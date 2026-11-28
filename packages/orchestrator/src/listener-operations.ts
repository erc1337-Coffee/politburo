// Local listeners of board channels: a channel's settings list its listeners, the orchestrator
// builds each from the channel's repository with the channel's Dockerfile, and the listener
// supervisor runs it on the host. The orchestrator checks every listener's port by a TCP
// connection; each action posts a status line in the channel.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import type { board as openBoard } from '@vercel/board'
import { isLocalRepository, localRepository, type GitRepositories } from './git.ts'
import { repositoryName } from './github.ts'

type Board = ReturnType<typeof openBoard>

export const LISTENER_ACTIONS = ['start', 'stop', 'reload'] as const
export type ListenerAction = (typeof LISTENER_ACTIONS)[number]
export const LISTENER_DOCKERFILE = 'Dockerfile.politburo'
const STATUS_LABEL = 'politburo.status'
const HEALTH_INTERVAL_MS = 10_000
const CONNECT_TIMEOUT_MS = 3_000

export const LISTENER_TEMPLATE_FILE = new URL('../templates/listener.Dockerfile', import.meta.url)

export interface ChannelListener { id: string; name: string; subpath: string; port: number; containerPort: number; interfaces: string[] }
export interface ChannelLocal { dockerfile: string; listeners: ChannelListener[] }
interface Settings { repository: string | null; routes: unknown[]; railway?: unknown; local?: ChannelLocal | null }

export class ListenerRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface ContainerState {
  id: string; exists: boolean; state: string | null; running: boolean; started_at: string | null; finished_at: string | null
  exit_code: number | null; restart_count: number; image: string | null; ports: Array<{ address: string; port: number }>
}

/** The TCP check of one address of a listener. */
export interface EndpointHealth { address: string; interface: string; port: number; open: boolean; connect_ms: number | null; since: string; checked_at: string }

export interface ListenerStatus {
  id: string; name: string; subpath: string; port: number; container_port: number; interfaces: string[]
  container: ContainerState | null
  endpoints: EndpointHealth[]
  last_build: { commit: string; branch: string; at: string } | null
  error?: string
}

/** The listener id prefix of a channel: its path as lowercase letters, digits and dashes. */
export const listenerPrefix = (channel: string) => channel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)

/** The supervisor's HTTP API, on the Compose network. */
export class SupervisorClient {
  readonly #url: string
  constructor(url: string) {
    this.#url = url.replace(/\/+$/, '')
  }

  async #call<T>(method: string, path: string, body?: Buffer | Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.#url}${path}`, {
        method,
        ...(body === undefined ? {} : Buffer.isBuffer(body)
          ? { body: new Uint8Array(body), headers: { 'content-type': 'application/x-tar' } }
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        signal: AbortSignal.timeout(path.endsWith('/build') ? 30 * 60_000 : 60_000),
      })
    } catch (error) {
      throw new ListenerRequestError(502, `the listener supervisor is unreachable: ${(error as Error).message}`)
    }
    const answer = await response.json().catch(() => null) as (T & { error?: string }) | null
    if (!response.ok) throw new ListenerRequestError(response.status === 404 || response.status === 409 || response.status === 400 ? response.status : 502, answer?.error ?? `the supervisor answered ${response.status}`)
    return answer as T
  }

  addresses(): Promise<Record<string, string>> {
    return this.#call<{ addresses: Record<string, string> }>('GET', '/addresses').then((answer) => answer.addresses)
  }
  state(id: string): Promise<ContainerState> {
    return this.#call('GET', `/listeners/${id}`)
  }
  build(id: string, context: Buffer, dockerfile: string): Promise<{ image: string; lines: string[] }> {
    return this.#call('POST', `/listeners/${id}/build?dockerfile=${encodeURIComponent(dockerfile)}`, context)
  }
  run(id: string, input: { port: number; container_port: number; addresses: string[] }): Promise<ContainerState> {
    return this.#call('POST', `/listeners/${id}/run`, input)
  }
  start(id: string): Promise<ContainerState> {
    return this.#call('POST', `/listeners/${id}/start`)
  }
  stop(id: string): Promise<ContainerState> {
    return this.#call('POST', `/listeners/${id}/stop`)
  }
  logs(id: string, tail: number): Promise<string[]> {
    return this.#call<{ lines: string[] }>('GET', `/listeners/${id}/logs?tail=${tail}`).then((answer) => answer.lines)
  }
}

/** Appends one file to a tar archive, before its end blocks. */
export function appendTarFile(tar: Buffer, name: string, content: string): Buffer {
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim() || '0', 8)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  const data = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([tar.subarray(0, offset), header, data, padding, Buffer.alloc(1024)])
}

/** One TCP connection to `address:port`: open with its connect time, or closed. */
export function probe(address: string, port: number, timeout = CONNECT_TIMEOUT_MS): Promise<{ open: boolean; connect_ms: number | null }> {
  return new Promise((resolve) => {
    const started = performance.now()
    const socket = connect({ host: address, port, timeout })
    const end = (open: boolean) => {
      socket.destroy()
      resolve({ open, connect_ms: open ? Math.round((performance.now() - started) * 10) / 10 : null })
    }
    socket.once('connect', () => end(true))
    socket.once('timeout', () => end(false))
    socket.once('error', () => end(false))
  })
}

export class ListenerOperations {
  readonly #supervisor: SupervisorClient | null
  readonly #board: Board
  readonly #git: GitRepositories
  readonly #log: (entry: Record<string, unknown>) => void
  readonly #health = new Map<string, EndpointHealth>()
  readonly #builds = new Map<string, { commit: string; branch: string; at: string }>()
  readonly #reloading = new Map<string, Promise<string>>()
  #timer: NodeJS.Timeout | null = null

  constructor(options: { supervisor: SupervisorClient | null; board: Board; git: GitRepositories; log?: (entry: Record<string, unknown>) => void }) {
    this.#supervisor = options.supervisor
    this.#board = options.board
    this.#git = options.git
    this.#log = options.log ?? (() => {})
  }

  get available(): boolean {
    return this.#supervisor !== null
  }

  #client(): SupervisorClient {
    if (!this.#supervisor) throw new ListenerRequestError(503, 'LISTENER_SUPERVISOR_URL is not set for the orchestrator')
    return this.#supervisor
  }

  template(): string {
    return readFileSync(LISTENER_TEMPLATE_FILE, 'utf8')
  }

  addresses(): Promise<Record<string, string>> {
    return this.#client().addresses()
  }

  async #settings(path: string): Promise<Settings | null> {
    const page = await this.#board.channels({ prefix: path, limit: 100 })
    return (page.channels.find((channel) => channel.path === path)?.settings as Settings | undefined) ?? null
  }

  async channel(path: string): Promise<{ settings: Settings; local: ChannelLocal }> {
    const settings = await this.#settings(path)
    if (!settings?.local) throw new ListenerRequestError(404, `#${path} has no local deployment`)
    return { settings, local: settings.local }
  }

  async #listener(path: string, id: string): Promise<{ settings: Settings; local: ChannelLocal; listener: ChannelListener }> {
    const { settings, local } = await this.channel(path)
    const listener = local.listeners.find((entry) => entry.id === id)
    if (!listener) throw new ListenerRequestError(404, `#${path} has no listener ${id}`)
    if (!listener.id.startsWith(`${listenerPrefix(path)}-`)) throw new ListenerRequestError(409, `listener ids of #${path} start with ${listenerPrefix(path)}-`)
    return { settings, local, listener }
  }

  async listenerNamed(path: string, name: string): Promise<ChannelListener> {
    const { local } = await this.channel(path)
    const wanted = name.trim().toLowerCase()
    const listener = local.listeners.find((entry) => entry.name.toLowerCase() === wanted || entry.id === wanted) ?? (local.listeners.length === 1 ? local.listeners[0] : undefined)
    if (!listener) throw new ListenerRequestError(404, `#${path} has no listener named ${name}`)
    return listener
  }

  async statuses(path: string): Promise<ListenerStatus[]> {
    const { local } = await this.channel(path)
    return Promise.all(local.listeners.map(async (listener) => {
      const base: ListenerStatus = {
        id: listener.id, name: listener.name, subpath: listener.subpath, port: listener.port, container_port: listener.containerPort,
        interfaces: listener.interfaces, container: null, last_build: this.#builds.get(listener.id) ?? null,
        endpoints: [...this.#health].filter(([key, entry]) => key.startsWith(`${listener.id}@`) && entry.port === listener.port).map(([, entry]) => entry),
      }
      try {
        return { ...base, container: await this.#client().state(listener.id) }
      } catch (error) {
        return { ...base, error: (error as Error).message.slice(0, 300) }
      }
    }))
  }

  async logs(path: string, id: string, tail: number): Promise<string[]> {
    const { listener } = await this.#listener(path, id)
    return this.#client().logs(listener.id, Math.min(Math.max(tail, 1), 1_000))
  }

  async act(path: string, id: string, action: ListenerAction, by: string): Promise<string> {
    const { settings, local, listener } = await this.#listener(path, id)
    if (action === 'reload') return this.#reload(path, settings, local, listener, by)
    const state = action === 'start' ? await this.#client().start(listener.id) : await this.#client().stop(listener.id)
    const outcome = `${listener.name} ${action === 'start' ? (state.running ? 'started' : 'did not start') : 'stopped'}`
    await this.#statusLine(path, `Listener: ${outcome}, on request of ${by}.`)
    void this.checkAll().catch(() => {})
    return outcome
  }

  /** Builds the listener from the latest `main`, else `master`, and replaces its container. */
  #reload(path: string, settings: Settings, local: ChannelLocal, listener: ChannelListener, by: string): Promise<string> {
    const running = this.#reloading.get(listener.id)
    if (running) return running
    const work = (async () => {
      const repository = settings.repository ? repositoryName(settings.repository) : localRepository(path)
      if (!repository) throw new ListenerRequestError(409, `#${path} links a repository the orchestrator cannot read`)
      const addresses = await this.#client().addresses()
      const published = listener.interfaces.map((name) => addresses[name])
      if (published.some((address) => !address)) throw new ListenerRequestError(409, `the host has no address for ${listener.interfaces.filter((name) => !addresses[name]).join(', ')}`)
      const archive = await this.#git.deploymentArchive(repository, listener.subpath)
      const context = appendTarFile(archive.tar, LISTENER_DOCKERFILE, local.dockerfile)
      try {
        await this.#client().build(listener.id, context, LISTENER_DOCKERFILE)
      } catch (error) {
        const text = (error as Error).message
        await this.#statusLine(path, `Listener: ${listener.name} build of ${archive.branch} ${archive.commit.slice(0, 7)} failed, on request of ${by}.\n\n${text.slice(-1_500)}`)
        throw error
      }
      const state = await this.#client().run(listener.id, { port: listener.port, container_port: listener.containerPort, addresses: published as string[] })
      this.#builds.set(listener.id, { commit: archive.commit, branch: archive.branch, at: new Date().toISOString() })
      const where = (published as string[]).map((address) => `${address}:${listener.port}`).join(', ')
      const outcome = `${listener.name} reloaded at ${archive.branch} ${archive.commit.slice(0, 7)}${isLocalRepository(repository) ? ' (local repository)' : ''}, ${state.running ? 'running' : 'not running'} on ${where}`
      await this.#statusLine(path, `Listener: ${outcome}, on request of ${by}.`)
      setTimeout(() => void this.checkAll().catch(() => {}), 1_500).unref()
      return outcome
    })()
    this.#reloading.set(listener.id, work)
    work.finally(() => this.#reloading.delete(listener.id)).catch(() => {})
    return work
  }

  /** The orchestrator's change of a channel's Dockerfile; every listener of the channel reloads with it. */
  async setDockerfile(path: string, dockerfile: string, by: string): Promise<string> {
    const { settings, local } = await this.channel(path)
    const text = dockerfile.trim()
    if (!text || text.length > 64 * 1024) throw new ListenerRequestError(400, 'a Dockerfile of up to 64 KiB is expected')
    const next = { ...local, dockerfile: `${text}\n` }
    await this.#board.configureChannel(path, { ...settings, local: next } as never)
    await this.#statusLine(path, `Listener: the Dockerfile of #${path} changed, on request of ${by}; every listener reloads.`)
    const outcomes = await Promise.all(next.listeners.map((listener) =>
      this.#reload(path, settings, next, listener, by).catch((error: Error) => `${listener.name} reload failed: ${error.message.slice(0, 200)}`)))
    return outcomes.length ? outcomes.join('; ') : 'the Dockerfile changed; the channel has no listener yet'
  }

  /** Checks every listener of every channel by a TCP connection to each of its addresses. */
  async checkAll(): Promise<void> {
    if (!this.#supervisor) return
    const addresses = await this.#supervisor.addresses().catch(() => null)
    if (!addresses) return
    const page = await this.#board.channels({ limit: 500 })
    const seen = new Set<string>()
    await Promise.all(page.channels.flatMap((channel) => ((channel.settings as Settings | undefined)?.local?.listeners ?? []).flatMap((listener) =>
      listener.interfaces.filter((name) => addresses[name]).map(async (name) => {
        const address = addresses[name]!
        const key = `${listener.id}@${address}:${listener.port}`
        seen.add(key)
        const result = await probe(address, listener.port)
        const now = new Date().toISOString()
        const before = this.#health.get(key)
        this.#health.set(key, { address, interface: name, port: listener.port, ...result, since: before && before.open === result.open ? before.since : now, checked_at: now })
      }))))
    for (const key of this.#health.keys()) if (!seen.has(key)) this.#health.delete(key)
  }

  startMonitor(): void {
    if (this.#timer || !this.#supervisor) return
    const tick = () => void this.checkAll().catch((error: Error) => this.#log({ event: 'listener_check_failed', message: error.message }))
    tick()
    this.#timer = setInterval(tick, HEALTH_INTERVAL_MS)
    this.#timer.unref()
  }

  stopMonitor(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  async #statusLine(path: string, text: string): Promise<void> {
    await this.#board.post(path, { text, labels: { [STATUS_LABEL]: 'orchestrator' } })
      .catch((error: Error) => this.#log({ event: 'listener_status_line_failed', channel: path, message: error.message }))
  }
}

export function listenerFailure(error: unknown): { status: number; message: string } | null {
  if (error instanceof ListenerRequestError) return { status: error.status, message: error.message }
  return null
}
