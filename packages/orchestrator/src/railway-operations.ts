// The Railway services of board channels: what the channel settings' Railway tab and the
// orchestrator's thread actions read and do. A channel's settings name one project, its
// production environment and the attached services; only those are reachable here. Each action
// posts a status line in the channel. A removal is never done: it becomes a task that waits for
// a person.
import type { board as openBoard } from '@vercel/board'
import { repositoryName } from './github.ts'
import {
  EDITABLE_SETTINGS, RailwayError, type EditableSetting, type RailwayClient, type RailwayDomain, type RailwayLogLine, type RailwayProject,
  type RailwayServiceSettings, type RailwayServiceStatus,
} from './railway.ts'

type Board = ReturnType<typeof openBoard>

export const RAILWAY_ACTIONS = ['start', 'stop', 'restart', 'redeploy', 'rollback'] as const
export type RailwayAction = (typeof RAILWAY_ACTIONS)[number]

/** A task a person must decide on: the orchestrator never claims it. */
export const ATTENTION_LABEL = 'politburo.attention'
const STATUS_LABEL = 'politburo.status'
const STATUS_CACHE_MS = 10_000

export interface ChannelRailway {
  projectId: string
  projectName: string
  environmentId: string
  services: Array<{ id: string; name: string }>
}

export class RailwayRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class RailwayOperations {
  readonly #client: RailwayClient | null
  readonly #board: Board
  readonly #log: (entry: Record<string, unknown>) => void
  readonly #statuses = new Map<string, { at: number; status: RailwayServiceStatus }>()

  constructor(options: { client: RailwayClient | null; board: Board; log?: (entry: Record<string, unknown>) => void }) {
    this.#client = options.client
    this.#board = options.board
    this.#log = options.log ?? (() => {})
  }

  get available(): boolean {
    return this.#client !== null
  }

  #railway(): RailwayClient {
    if (!this.#client) throw new RailwayRequestError(503, 'RAILWAY_TOKEN is not set for the orchestrator')
    return this.#client
  }

  /** The channel's settings: its repository and its Railway part, which must be set. */
  async channel(path: string): Promise<{ repository: string | null; railway: ChannelRailway }> {
    const page = await this.#board.channels({ prefix: path, limit: 100 })
    const settings = page.channels.find((channel) => channel.path === path)?.settings as { repository: string | null; railway?: ChannelRailway | null } | undefined
    if (!settings?.railway) throw new RailwayRequestError(404, `#${path} uses no Railway`)
    return { repository: settings.repository, railway: settings.railway }
  }

  async #service(path: string, serviceId: string): Promise<{ railway: ChannelRailway; service: { id: string; name: string } }> {
    const { railway } = await this.channel(path)
    const service = railway.services.find((entry) => entry.id === serviceId)
    if (!service) throw new RailwayRequestError(404, `the service is not attached to #${path}`)
    return { railway, service }
  }

  /** The attached service of a channel by its name, as a person writes it. */
  async serviceNamed(path: string, name: string): Promise<{ id: string; name: string }> {
    const { railway } = await this.channel(path)
    const wanted = name.trim().toLowerCase()
    const service = railway.services.find((entry) => entry.name.toLowerCase() === wanted) ?? (railway.services.length === 1 ? railway.services[0] : undefined)
    if (!service) throw new RailwayRequestError(404, `#${path} has no service named ${name}`)
    return service
  }

  projects(): Promise<RailwayProject[]> {
    return this.#railway().projects()
  }

  /**
   * A new project in the token's workspace, with production only. The workspace is the one of the
   * projects the token reaches; a workspace with no project yet needs one made in Railway first.
   */
  async createProject(input: { name?: unknown }, by: string): Promise<RailwayProject> {
    const name = typeof input.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/.test(input.name.trim()) ? input.name.trim() : null
    if (!name) throw new RailwayRequestError(400, 'a project name of letters, digits, spaces, dots, dashes and underscores is expected')
    const projects = await this.#railway().projects()
    if (projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) throw new RailwayRequestError(409, `a project named ${name} exists; attach it instead`)
    const workspaces = [...new Set(projects.map((project) => project.workspaceId).filter((id): id is string => Boolean(id)))]
    if (workspaces.length !== 1) throw new RailwayRequestError(409, workspaces.length === 0 ? 'the token reaches no project, so its workspace is not known' : 'the token reaches more than one workspace')
    const project = await this.#railway().createProject(name, workspaces[0]!)
    this.#log({ event: 'railway_project_created', project: project.id, name, by })
    return project
  }

  async domains(path: string, serviceId: string): Promise<{ service: RailwayDomain[]; custom: string[] }> {
    const { railway, service } = await this.#service(path, serviceId)
    return this.#railway().domains(service.id, railway.environmentId)
  }

  /** A public railway.app domain for the service. */
  async createDomain(path: string, serviceId: string, input: { targetPort?: unknown }, by: string): Promise<RailwayDomain> {
    const { railway, service } = await this.#service(path, serviceId)
    const port = portOf(input.targetPort)
    const domain = await this.#railway().createDomain(service.id, railway.environmentId, port)
    this.#statuses.delete(service.id)
    await this.#statusLine(path, `Railway: ${service.name} is public at https://${domain.domain}${port ? ` (port ${port})` : ''}, on request of ${by}.`)
    return domain
  }

  async setDomainPort(path: string, serviceId: string, domainId: string, input: { targetPort?: unknown }, by: string): Promise<void> {
    const { railway, service } = await this.#service(path, serviceId)
    const domain = (await this.#railway().domains(service.id, railway.environmentId)).service.find((entry) => entry.id === domainId)
    if (!domain) throw new RailwayRequestError(404, `${service.name} has no such domain`)
    const port = portOf(input.targetPort)
    await this.#railway().setDomainPort(service.id, railway.environmentId, domain, port)
    await this.#statusLine(path, `Railway: ${domain.domain} routes to ${port ? `port ${port}` : 'the service port'}, on request of ${by}.`)
  }

  async status(path: string, serviceId: string, fresh = false): Promise<RailwayServiceStatus> {
    const { railway, service } = await this.#service(path, serviceId)
    const cached = this.#statuses.get(service.id)
    if (!fresh && cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.status
    const status = await this.#railway().serviceStatus(service.id, railway.environmentId)
    this.#statuses.set(service.id, { at: Date.now(), status })
    return status
  }

  async statuses(path: string): Promise<Array<RailwayServiceStatus | { id: string; name: string; error: string }>> {
    const { railway } = await this.channel(path)
    return Promise.all(railway.services.map((service) => this.status(path, service.id)
      .catch((error: Error) => ({ id: service.id, name: service.name, error: error.message.slice(0, 300) }))))
  }

  async logs(path: string, serviceId: string, kind: 'deploy' | 'build', limit: number): Promise<{ deployment: string | null; lines: RailwayLogLine[] }> {
    const status = await this.status(path, serviceId)
    if (!status.latest) return { deployment: null, lines: [] }
    return { deployment: status.latest.id, lines: await this.#railway().logs(status.latest.id, kind, Math.min(Math.max(limit, 1), 500)) }
  }

  /** Starts, stops, restarts, redeploys or rolls back a service, and says so in the channel. */
  async act(path: string, serviceId: string, action: RailwayAction, by: string): Promise<string> {
    const { railway, service } = await this.#service(path, serviceId)
    const client = this.#railway()
    const status = await this.status(path, serviceId, true)
    const latest = status.latest
    let outcome: string
    switch (action) {
      case 'start':
        outcome = `deployment ${(await client.deploy(service.id, railway.environmentId)).slice(0, 8)} started`
        break
      case 'stop':
        if (status.active.length === 0) throw new RailwayRequestError(409, `${service.name} runs no deployment`)
        for (const id of status.active) await client.stop(id)
        outcome = `stopped`
        break
      case 'restart':
        if (!latest || status.active.length === 0) throw new RailwayRequestError(409, `${service.name} runs no deployment to restart`)
        await client.restart(status.active[0]!)
        outcome = 'restarted'
        break
      case 'redeploy':
        if (!latest?.canRedeploy) throw new RailwayRequestError(409, `${service.name} has no deployment to redeploy`)
        outcome = `redeployed as ${(await client.redeploy(latest.id)).slice(0, 8)}`
        break
      case 'rollback':
        if (!latest?.canRollback) throw new RailwayRequestError(409, `${service.name} has no deployment to roll back to`)
        await client.rollback(latest.id)
        outcome = 'rolled back'
        break
    }
    this.#statuses.delete(service.id)
    await this.#statusLine(path, `Railway: ${service.name} ${outcome}, on request of ${by}.`)
    return `${service.name} ${outcome}`
  }

  async variables(path: string, serviceId: string): Promise<Record<string, string>> {
    const { railway, service } = await this.#service(path, serviceId)
    return this.#railway().variables(railway.projectId, railway.environmentId, service.id)
  }

  /** Sets variables; a variable that is to go away becomes a task for a person. */
  async setVariables(path: string, serviceId: string, change: { set?: Record<string, unknown>; remove?: unknown }, by: string): Promise<{ set: string[]; removal_task: string | null }> {
    const { railway, service } = await this.#service(path, serviceId)
    const set: Record<string, string> = {}
    for (const [name, value] of Object.entries(change.set ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,254}$/.test(name) || typeof value !== 'string' || value.length > 32_768) throw new RailwayRequestError(400, `variable ${name.slice(0, 60)} is not valid`)
      set[name] = value
    }
    const remove = Array.isArray(change.remove) ? change.remove.filter((name): name is string => typeof name === 'string' && name.length <= 255) : []
    if (Object.keys(set).length > 0) {
      await this.#railway().setVariables(railway.projectId, railway.environmentId, service.id, set)
      await this.#statusLine(path, `Railway: ${service.name} variables set (${Object.keys(set).sort().join(', ')}), on request of ${by}.`)
    }
    const task = remove.length > 0
      ? await this.attention(path, `Remove Railway variables of ${service.name}: ${remove.join(', ')}`, `${by} asked to remove these variables of ${service.name} in ${railway.projectName}. The orchestrator removes nothing; remove them in Railway if they should go.`)
      : null
    return { set: Object.keys(set), removal_task: task }
  }

  async settings(path: string, serviceId: string): Promise<RailwayServiceSettings> {
    const { railway, service } = await this.#service(path, serviceId)
    return this.#railway().settings(service.id, railway.environmentId)
  }

  async updateSettings(path: string, serviceId: string, change: Record<string, unknown>, by: string): Promise<string[]> {
    const { railway, service } = await this.#service(path, serviceId)
    const known = Object.fromEntries(Object.entries(change).filter(([key]) => (EDITABLE_SETTINGS as readonly string[]).includes(key))) as Partial<Pick<RailwayServiceSettings, EditableSetting>>
    const names = Object.keys(known)
    if (names.length === 0) return []
    await this.#railway().updateSettings(service.id, railway.environmentId, known)
    await this.#statusLine(path, `Railway: ${service.name} settings changed (${names.sort().join(', ')}), on request of ${by}.`)
    return names
  }

  /**
   * A new service in the channel's project, deployed from the channel's GitHub repository. A
   * channel without one gets a task for a person instead: a private repository comes first.
   */
  async createService(path: string, input: { name?: unknown; branch?: unknown }, by: string): Promise<{ id: string; name: string }> {
    const { repository, railway } = await this.channel(path)
    const repo = repository ? repositoryName(repository) : null
    if (!repo) {
      const task = await this.attention(path, `Create a GitHub repository for #${path} before Railway`,
        `${by} asked for a Railway service in #${path}, which links no GitHub repository. Create a private repository, push the channel's work to it and link it in the channel settings; then create the service.`)
      throw new RailwayRequestError(409, `#${path} links no GitHub repository; task #${task} asks for one`)
    }
    const name = typeof input.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/.test(input.name.trim()) ? input.name.trim() : null
    if (!name) throw new RailwayRequestError(400, 'a service name of letters, digits, spaces, dots, dashes and underscores is expected')
    const branch = typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim().slice(0, 200) : null
    const service = await this.#railway().createService({ projectId: railway.projectId, environmentId: railway.environmentId, name, repo, branch })
    await this.#statusLine(path, `Railway: service ${service.name} created in ${railway.projectName} from ${repo}${branch ? ` at ${branch}` : ''}, on request of ${by}.`)
    return service
  }

  /** A task in the channel that waits for a person; answers its id. */
  async attention(path: string, title: string, text: string): Promise<string> {
    const { task } = await this.#board.tasks.create(path, { text: `${title}\n\n${text}`, labels: { [ATTENTION_LABEL]: 'orchestrator' } })
    await this.#board.tasks.block(task.id, 'Needs a decision of a person.', { kind: 'needs_input' })
      .catch((error: Error) => this.#log({ event: 'attention_block_failed', task: task.id, message: error.message }))
    return task.id
  }

  async #statusLine(path: string, text: string): Promise<void> {
    await this.#board.post(path, { text, labels: { [STATUS_LABEL]: 'orchestrator' } })
      .catch((error: Error) => this.#log({ event: 'railway_status_line_failed', channel: path, message: error.message }))
  }
}

function portOf(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RailwayRequestError(400, 'a port from 1 to 65535 is expected')
  return port
}

/** The HTTP status and message of an error, for the status server. */
export function railwayFailure(error: unknown): { status: number; message: string } {
  if (error instanceof RailwayRequestError) return { status: error.status, message: error.message }
  if (error instanceof RailwayError) return { status: error.status === 429 ? 429 : 502, message: error.message }
  return { status: 500, message: (error as Error).message?.slice(0, 300) ?? 'error' }
}
