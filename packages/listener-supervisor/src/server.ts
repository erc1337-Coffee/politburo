// The listener supervisor: the only Politburo process with the Docker socket. It builds, runs,
// stops and reads local listener containers through the Docker Engine API, and nothing else. The
// orchestrator reaches it on the Compose network; no port of it is published.
//
//   GET  /addresses                       the host addresses a listener may publish on
//   GET  /listeners                       every listener container with its state
//   POST /listeners/{id}/build            body: a tar build context; ?dockerfile=NAME
//   POST /listeners/{id}/run              { image, port, container_port, addresses: [ip], environment }
//   POST /listeners/{id}/start | stop
//   GET  /listeners/{id}                  state of the listener's container
//   GET  /listeners/{id}/logs?tail=N
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'

export const LABEL = 'politburo.listener'
const ID = /^[a-z0-9][a-z0-9_-]{0,62}$/
const BUILD_MAX = 512 * 1024 * 1024
const CONTROL_MAX = 64 * 1024

export class SupervisorError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface SupervisorOptions {
  /** The Docker Engine socket. */
  socket: string
  /** The host addresses listeners may publish on, by name, such as lan and wireguard. */
  addresses: Record<string, string>
  /** Memory limit of each listener container, in bytes; 0 for none. */
  memoryBytes?: number
  /** CPU limit of each listener container, in CPUs; 0 for none. */
  cpus?: number
  /** The image of the forwarders, with socat: each address after the first gets one. */
  forwarderImage?: string
}

export const ROLE_LABEL = 'politburo.listener.role'
export const imageOf = (id: string) => `politburo-listener-${id}:latest`
export const containerOf = (id: string) => `politburo-listener-${id}`
export const networkOf = (id: string) => `politburo-listener-${id}`
export const forwarderOf = (id: string, n: number) => `politburo-listener-${id}-forward-${n}`

export interface ListenerState {
  id: string
  exists: boolean
  state: string | null
  running: boolean
  started_at: string | null
  finished_at: string | null
  exit_code: number | null
  restart_count: number
  image: string | null
  ports: Array<{ address: string; port: number }>
}

export class DockerEngine {
  readonly #socket: string

  constructor(socket: string) {
    this.#socket = socket
  }

  /** One Docker Engine API call; `body` a JSON value or a tar stream's bytes. */
  call(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
      const call = httpRequest({
        socketPath: this.#socket, method, path: `/v1.44${path}`,
        headers: { host: 'docker', ...(payload ? { 'content-type': contentType, 'content-length': payload.length } : {}) },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
        response.on('error', reject)
      })
      call.on('error', (error) => reject(new SupervisorError(502, `Docker is unreachable: ${error.message}`)))
      call.setTimeout(30 * 60_000, () => call.destroy(new Error('Docker did not answer in time')))
      if (payload) call.write(payload)
      call.end()
    })
  }

  async json<T>(method: string, path: string, body?: unknown, accepted: number[] = [200, 201, 204, 304]): Promise<T> {
    const answer = await this.call(method, path, body)
    if (!accepted.includes(answer.status)) {
      const message = (() => { try { return (JSON.parse(answer.body.toString()) as { message?: string }).message } catch { return answer.body.toString().slice(0, 300) } })()
      throw new SupervisorError(answer.status === 404 ? 404 : answer.status === 409 ? 409 : 502, `Docker: ${message ?? answer.status}`)
    }
    return (answer.body.length ? JSON.parse(answer.body.toString()) : null) as T
  }
}

/** The lines of a Docker log stream without its 8-byte frame headers. */
export function demultiplex(buffer: Buffer): string {
  const parts: Buffer[] = []
  let offset = 0
  while (offset + 8 <= buffer.length && buffer[offset]! <= 2 && buffer[offset + 1] === 0) {
    const size = buffer.readUInt32BE(offset + 4)
    parts.push(buffer.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size
  }
  return offset === 0 ? buffer.toString('utf8') : Buffer.concat(parts).toString('utf8')
}

/** The build output's text: Docker answers one JSON object per line. */
export function buildOutput(body: Buffer): { lines: string[]; error: string | null } {
  const lines: string[] = []
  let error: string | null = null
  for (const line of body.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { stream?: string; error?: string; errorDetail?: { message?: string } }
      if (entry.stream) lines.push(...entry.stream.replace(/\n$/, '').split('\n'))
      if (entry.error) error = entry.errorDetail?.message ?? entry.error
    } catch {
      lines.push(line)
    }
  }
  return { lines, error }
}

export class ListenerSupervisor {
  readonly #docker: DockerEngine
  readonly #o: SupervisorOptions
  readonly #busy = new Set<string>()

  constructor(options: SupervisorOptions, docker = new DockerEngine(options.socket)) {
    this.#o = options
    this.#docker = docker
  }

  addresses(): Record<string, string> {
    return { ...this.#o.addresses }
  }

  #id(id: string): string {
    if (!ID.test(id)) throw new SupervisorError(400, 'a listener id is lowercase letters, digits, dashes and underscores')
    return id
  }

  /** The container of a listener, only when it carries the listener label. */
  async #inspect(id: string): Promise<Record<string, any> | null> {
    const answer = await this.#docker.call('GET', `/containers/${containerOf(id)}/json`)
    if (answer.status === 404) return null
    if (answer.status !== 200) throw new SupervisorError(502, `Docker answered ${answer.status}`)
    const container = JSON.parse(answer.body.toString()) as Record<string, any>
    if (container.Config?.Labels?.[LABEL] !== id) throw new SupervisorError(409, `${containerOf(id)} is not a listener container`)
    return container
  }

  async state(id: string): Promise<ListenerState> {
    const container = await this.#inspect(this.#id(id))
    if (!container) return { id, exists: false, state: null, running: false, started_at: null, finished_at: null, exit_code: null, restart_count: 0, image: null, ports: [] }
    const forwarders = await Promise.all((await this.#containers(id)).slice(1).map(async (name) => (await this.#docker.json<Record<string, any>>('GET', `/containers/${name}/json`))))
    const bindings = [container, ...forwarders].map((entry) => (entry.HostConfig?.PortBindings ?? {}) as Record<string, Array<{ HostIp: string; HostPort: string }>>)
      .reduce<Record<string, Array<{ HostIp: string; HostPort: string }>>>((all, entry, n) => ({ ...all, ...Object.fromEntries(Object.entries(entry).map(([key, value]) => [`${n}:${key}`, value])) }), {})
    return {
      id, exists: true, state: container.State?.Status ?? null, running: container.State?.Running === true,
      started_at: container.State?.StartedAt ?? null, finished_at: container.State?.FinishedAt ?? null,
      exit_code: container.State?.ExitCode ?? null, restart_count: container.RestartCount ?? 0, image: container.Config?.Image ?? null,
      ports: Object.values(bindings).flat().map((binding) => ({ address: binding.HostIp, port: Number(binding.HostPort) })),
    }
  }

  async list(): Promise<ListenerState[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }))
    const containers = await this.#docker.json<Array<{ Labels: Record<string, string> }>>('GET', `/containers/json?all=1&filters=${filters}`)
    const ids = [...new Set(containers.filter((container) => container.Labels[ROLE_LABEL] !== 'forwarder').map((container) => container.Labels[LABEL]).filter((id): id is string => typeof id === 'string' && ID.test(id)))]
    return Promise.all(ids.map((id) => this.state(id)))
  }

  async #exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new SupervisorError(409, `listener ${id} is busy with another operation`)
    this.#busy.add(id)
    try {
      return await work()
    } finally {
      this.#busy.delete(id)
    }
  }

  /** Builds the listener's image from a tar build context. */
  build(id: string, context: Buffer, dockerfile: string): Promise<{ image: string; lines: string[] }> {
    this.#id(id)
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(dockerfile)) throw new SupervisorError(400, 'the Dockerfile name is not valid')
    return this.#exclusive(id, async () => {
      const image = imageOf(id)
      const query = new URLSearchParams({ t: image, dockerfile, rm: '1', forcerm: '1', labels: JSON.stringify({ [LABEL]: id }) })
      const answer = await this.#docker.call('POST', `/build?${query}`, context, 'application/x-tar')
      const output = buildOutput(answer.body)
      if (answer.status !== 200 || output.error) throw new SupervisorError(422, `the build failed: ${output.error ?? answer.status}\n${output.lines.slice(-40).join('\n')}`)
      return { image, lines: output.lines.slice(-200) }
    })
  }

  /**
   * Replaces the listener's container with a new one from its image, published on the first of
   * `addresses` at `port`; each further address gets a forwarder container, because Docker Desktop
   * refuses one container port on two host addresses. The listener and its forwarders share a
   * network of their own. No container gets mounts, privileges or the host network.
   */
  run(id: string, input: { port: unknown; container_port: unknown; addresses: unknown; environment?: unknown }): Promise<ListenerState> {
    this.#id(id)
    const port = Number(input.port)
    const containerPort = Number(input.container_port ?? input.port)
    for (const value of [port, containerPort]) if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new SupervisorError(400, 'a port from 1 to 65535 is expected')
    const allowed = new Set(Object.values(this.#o.addresses))
    const addresses = Array.isArray(input.addresses) ? [...new Set(input.addresses.filter((address): address is string => typeof address === 'string'))] : []
    if (addresses.length === 0 || addresses.some((address) => !allowed.has(address) || isIP(address) === 0)) {
      throw new SupervisorError(400, `a listener publishes only on ${[...allowed].join(', ') || 'no configured address'}`)
    }
    const environment = Object.entries((input.environment ?? {}) as Record<string, unknown>)
      .filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && typeof value === 'string')
      .map(([name, value]) => `${name}=${value as string}`)
    return this.#exclusive(id, async () => {
      await this.#remove(id)
      await this.#network(id)
      const memory = this.#o.memoryBytes ?? 0
      const cpus = this.#o.cpus ?? 0
      const confined = {
        RestartPolicy: { Name: 'unless-stopped' },
        Privileged: false, CapDrop: ['ALL'], CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'NET_BIND_SERVICE', 'DAC_OVERRIDE', 'FOWNER'],
        SecurityOpt: ['no-new-privileges'], Binds: [], NetworkMode: networkOf(id),
      }
      const binding = (address: string) => ({ [`${containerPort}/tcp`]: [{ HostIp: address, HostPort: String(port) }] })
      await this.#docker.json('POST', `/containers/create?name=${containerOf(id)}`, {
        Image: imageOf(id),
        Labels: { [LABEL]: id, [ROLE_LABEL]: 'listener' },
        Env: [`PORT=${containerPort}`, ...environment],
        ExposedPorts: { [`${containerPort}/tcp`]: {} },
        HostConfig: {
          ...confined, PortBindings: binding(addresses[0]!),
          ...(memory > 0 ? { Memory: memory } : {}), ...(cpus > 0 ? { NanoCpus: Math.round(cpus * 1e9) } : {}),
        },
      })
      for (const [n, address] of addresses.slice(1).entries()) {
        await this.#docker.json('POST', `/containers/create?name=${forwarderOf(id, n + 1)}`, {
          Image: this.#o.forwarderImage ?? 'politburo_development:latest',
          Labels: { [LABEL]: id, [ROLE_LABEL]: 'forwarder' },
          Entrypoint: ['socat'],
          Cmd: [`TCP-LISTEN:${containerPort},fork,reuseaddr`, `TCP:${containerOf(id)}:${containerPort}`],
          User: '65534:65534',
          ExposedPorts: { [`${containerPort}/tcp`]: {} },
          HostConfig: { ...confined, CapAdd: [], PortBindings: binding(address), Memory: 64 * 1024 * 1024 },
        })
      }
      await this.#each(id, 'start')
      return this.state(id)
    })
  }

  /** The listener's own network, made once. */
  async #network(id: string): Promise<void> {
    const answer = await this.#docker.call('GET', `/networks/${networkOf(id)}`)
    if (answer.status === 200) return
    await this.#docker.json('POST', '/networks/create', { Name: networkOf(id), Driver: 'bridge', Labels: { [LABEL]: id } }, [201, 409])
  }

  /** The names of the listener's containers: the listener first, then its forwarders. */
  async #containers(id: string): Promise<string[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${id}`] }))
    const rows = await this.#docker.json<Array<{ Names: string[]; Labels: Record<string, string> }>>('GET', `/containers/json?all=1&filters=${filters}`)
    return rows.map((row) => ({ name: row.Names[0]!.replace(/^\//, ''), role: row.Labels[ROLE_LABEL] }))
      .sort((a, b) => (a.role === 'forwarder' ? 1 : 0) - (b.role === 'forwarder' ? 1 : 0))
      .map((row) => row.name)
  }

  async #each(id: string, action: 'start' | 'stop'): Promise<void> {
    const names = await this.#containers(id)
    for (const name of action === 'stop' ? names.reverse() : names) {
      await this.#docker.json('POST', `/containers/${name}/${action === 'stop' ? 'stop?t=10' : 'start'}`)
    }
  }

  /** The listener's containers go; its image and network stay for the next run. Only a run calls it. */
  async #remove(id: string): Promise<void> {
    await this.#inspect(id)
    for (const name of await this.#containers(id)) await this.#docker.json('DELETE', `/containers/${name}?force=1`, undefined, [204, 404])
  }

  start(id: string): Promise<ListenerState> {
    return this.#exclusive(this.#id(id), async () => {
      if (!(await this.#inspect(id))) throw new SupervisorError(404, `listener ${id} has no container; reload it`)
      await this.#each(id, 'start')
      return this.state(id)
    })
  }

  stop(id: string): Promise<ListenerState> {
    return this.#exclusive(this.#id(id), async () => {
      if (!(await this.#inspect(id))) throw new SupervisorError(404, `listener ${id} has no container`)
      await this.#each(id, 'stop')
      return this.state(id)
    })
  }

  async logs(id: string, tail: number): Promise<string[]> {
    if (!(await this.#inspect(this.#id(id)))) return []
    const lines = Math.min(Math.max(Math.trunc(tail) || 100, 1), 1_000)
    const answer = await this.#docker.call('GET', `/containers/${containerOf(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${lines}`)
    if (answer.status !== 200) throw new SupervisorError(502, `Docker answered ${answer.status}`)
    return demultiplex(answer.body).split('\n').filter(Boolean)
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

async function read(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) throw new SupervisorError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function control(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse((await read(request, CONTROL_MAX)).toString('utf8') || '{}') as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof SupervisorError) throw error
  }
  throw new SupervisorError(400, 'a JSON object is expected')
}

const ROUTE = /^\/listeners\/([^/]+)(?:\/(build|run|start|stop|logs))?$/

export function supervisorHandler(supervisor: ListenerSupervisor) {
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://supervisor')
    const method = request.method ?? 'GET'
    if (url.pathname === '/addresses' && method === 'GET') return reply(response, 200, { addresses: supervisor.addresses() })
    if (url.pathname === '/listeners' && method === 'GET') return reply(response, 200, { listeners: await supervisor.list() })
    const match = ROUTE.exec(url.pathname)
    if (!match) return reply(response, 404, { error: 'not_found' })
    const id = decodeURIComponent(match[1]!)
    const what = match[2] ?? 'state'
    if (what === 'state' && method === 'GET') return reply(response, 200, await supervisor.state(id))
    if (what === 'logs' && method === 'GET') return reply(response, 200, { lines: await supervisor.logs(id, Number(url.searchParams.get('tail') ?? 100)) })
    if (method !== 'POST') return reply(response, 405, { error: 'method_not_allowed' })
    if (what === 'build') return reply(response, 200, await supervisor.build(id, await read(request, BUILD_MAX), url.searchParams.get('dockerfile') ?? 'Dockerfile'))
    if (what === 'run') return reply(response, 200, await supervisor.run(id, await control(request) as never))
    if (what === 'start') return reply(response, 200, await supervisor.start(id))
    if (what === 'stop') return reply(response, 200, await supervisor.stop(id))
    return reply(response, 405, { error: 'method_not_allowed' })
  }
  return (request: IncomingMessage, response: ServerResponse) => {
    route(request, response).catch((error: unknown) => {
      const status = error instanceof SupervisorError ? error.status : 500
      if (!response.headersSent) reply(response, status, { error: (error as Error).message?.slice(0, 4_000) ?? 'error' })
      else response.end()
    })
  }
}

/** The addresses from LISTENER_ADDRESSES: `name=ip` pairs separated by commas. */
export function parseAddresses(text: string | undefined): Record<string, string> {
  const addresses: Record<string, string> = {}
  for (const pair of (text ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const [name, address] = pair.split('=').map((part) => part.trim())
    if (!name || !address || !/^[a-z][a-z0-9_-]{0,31}$/.test(name) || isIP(address) === 0) throw new Error(`LISTENER_ADDRESSES: "${pair}" is not name=ip`)
    addresses[name] = address
  }
  return addresses
}

export function startSupervisor(options: SupervisorOptions & { host: string; port: number }) {
  const server = createServer(supervisorHandler(new ListenerSupervisor(options)))
  server.requestTimeout = 0
  server.listen(options.port, options.host)
  return server
}

if (import.meta.main) {
  const addresses = parseAddresses(process.env.LISTENER_ADDRESSES)
  const port = Number(process.env.LISTENER_SUPERVISOR_PORT ?? 4790)
  const host = process.env.LISTENER_SUPERVISOR_HOST ?? '0.0.0.0'
  startSupervisor({
    socket: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock', addresses, host, port,
    memoryBytes: Number(process.env.LISTENER_MEMORY_MEGABYTES ?? 1024) * 1024 * 1024, cpus: Number(process.env.LISTENER_CPUS ?? 2),
    forwarderImage: process.env.LISTENER_FORWARDER_IMAGE ?? 'politburo_development:latest',
  })
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'listener_supervisor_started', host, port, addresses }))
}
