// Railway public GraphQL API: the reads and writes of the channel settings' Railway tab and of
// the orchestrator's thread actions. Nothing here deletes: a removal is a decision for a person.
export const RAILWAY_API = 'https://backboard.railway.com/graphql/v2'

export class RailwayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface RailwayProject {
  id: string
  name: string
  /** The production environment: the project's primary one, else the one named production. */
  production: { id: string; name: string } | null
  services: Array<{ id: string; name: string }>
}

export interface RailwayDeployment {
  id: string
  status: string
  createdAt: string
  stopped: boolean
  url: string | null
  canRedeploy: boolean
  canRollback: boolean
  commit: string | null
}

export interface RailwayServiceStatus {
  id: string
  name: string
  domains: string[]
  latest: RailwayDeployment | null
  /** The deployments that run now; a stop ends them. */
  active: string[]
}

export interface RailwayLogLine { timestamp: string; severity: string | null; message: string }

/** The build and deploy settings the tab shows and edits; anything else stays as Railway has it. */
export interface RailwayServiceSettings {
  source: { repo: string | null; image: string | null; branch: string | null }
  rootDirectory: string | null
  builder: string | null
  dockerfilePath: string | null
  railwayConfigFile: string | null
  buildCommand: string | null
  startCommand: string | null
  preDeployCommand: string[] | null
  healthcheckPath: string | null
  healthcheckTimeout: number | null
  restartPolicyType: string | null
  restartPolicyMaxRetries: number | null
  numReplicas: number | null
  region: string | null
  sleepApplication: boolean | null
  cronSchedule: string | null
  watchPatterns: string[]
}

export const EDITABLE_SETTINGS = [
  'rootDirectory', 'builder', 'dockerfilePath', 'railwayConfigFile', 'buildCommand', 'startCommand', 'preDeployCommand',
  'healthcheckPath', 'healthcheckTimeout', 'restartPolicyType', 'restartPolicyMaxRetries', 'numReplicas', 'region',
  'sleepApplication', 'cronSchedule', 'watchPatterns',
] as const
export type EditableSetting = (typeof EDITABLE_SETTINGS)[number]

const DEPLOYMENT = 'id status createdAt deploymentStopped staticUrl url canRedeploy canRollback meta'

interface DeploymentJson {
  id: string; status: string; createdAt: string; deploymentStopped: boolean; staticUrl: string | null; url: string | null
  canRedeploy: boolean; canRollback: boolean; meta: Record<string, unknown> | null
}

const deploymentOf = (row: DeploymentJson | null | undefined): RailwayDeployment | null => row ? {
  id: row.id, status: row.status, createdAt: row.createdAt, stopped: row.deploymentStopped, url: row.staticUrl ?? row.url ?? null,
  canRedeploy: row.canRedeploy, canRollback: row.canRollback,
  commit: typeof row.meta?.commitHash === 'string' ? row.meta.commitHash : null,
} : null

export interface RailwayClientOptions { token: string; url?: string; fetch?: typeof fetch }

export class RailwayClient {
  readonly #o: RailwayClientOptions

  constructor(options: RailwayClientOptions) {
    this.#o = options
  }

  async #call<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response
    try {
      response = await (this.#o.fetch ?? fetch)(this.#o.url ?? RAILWAY_API, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#o.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new RailwayError(0, `Railway is unreachable: ${(error as Error).message}`)
    }
    const body = await response.json().catch(() => null) as { data?: T; errors?: Array<{ message?: string }> } | null
    if (response.status === 429) throw new RailwayError(429, 'the Railway rate limit is reached')
    if (!response.ok || !body) throw new RailwayError(response.status, `Railway answered ${response.status}`)
    if (body.errors?.length) throw new RailwayError(response.status, `Railway: ${body.errors.map((error) => error.message ?? 'error').join('; ').slice(0, 300)}`)
    return body.data as T
  }

  /** The projects the token reaches, each with its production environment and services. */
  async projects(): Promise<RailwayProject[]> {
    type Edges<T> = { edges: Array<{ node: T }> }
    const data = await this.#call<{ projects: Edges<{
      id: string; name: string; primaryEnvironmentId: string | null
      environments: Edges<{ id: string; name: string }>; services: Edges<{ id: string; name: string }>
    }> }>(`query { projects(first: 100) { edges { node { id name primaryEnvironmentId
      environments { edges { node { id name } } } services { edges { node { id name } } } } } } }`)
    return data.projects.edges.map(({ node }) => {
      const environments = node.environments.edges.map((edge) => edge.node)
      const production = environments.find((environment) => environment.id === node.primaryEnvironmentId)
        ?? environments.find((environment) => environment.name.toLowerCase() === 'production') ?? null
      return { id: node.id, name: node.name, production, services: node.services.edges.map((edge) => edge.node) }
    })
  }

  async serviceStatus(serviceId: string, environmentId: string): Promise<RailwayServiceStatus> {
    const data = await this.#call<{ serviceInstance: {
      serviceName: string; latestDeployment: DeploymentJson | null; activeDeployments: Array<{ id: string }>
      domains: { serviceDomains: Array<{ domain: string }>; customDomains: Array<{ domain: string }> }
    } }>(`query($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      serviceName latestDeployment { ${DEPLOYMENT} } activeDeployments { id }
      domains { serviceDomains { domain } customDomains { domain } } } }`, { serviceId, environmentId })
    const instance = data.serviceInstance
    return {
      id: serviceId, name: instance.serviceName, latest: deploymentOf(instance.latestDeployment),
      active: instance.activeDeployments.map((deployment) => deployment.id),
      domains: [...instance.domains.customDomains, ...instance.domains.serviceDomains].map((domain) => domain.domain),
    }
  }

  /** The last `limit` lines of a deployment's runtime or build log, oldest first. */
  async logs(deploymentId: string, kind: 'deploy' | 'build', limit = 100): Promise<RailwayLogLine[]> {
    const field = kind === 'build' ? 'buildLogs' : 'deploymentLogs'
    const data = await this.#call<Record<string, Array<{ timestamp: string; severity: string | null; message: string }>>>(
      `query($id: String!, $limit: Int) { logs: ${field}(deploymentId: $id, limit: $limit) { timestamp severity message } }`, { id: deploymentId, limit })
    return (data.logs ?? []).map(({ timestamp, severity, message }) => ({ timestamp, severity: severity ?? null, message }))
  }

  /** Deploys the service's current commit; the start of a stopped service. Answers the new deployment's id. */
  async deploy(serviceId: string, environmentId: string): Promise<string> {
    const data = await this.#call<{ id: string }>(`mutation($serviceId: String!, $environmentId: String!) {
      id: serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`, { serviceId, environmentId })
    return data.id
  }

  async redeploy(deploymentId: string): Promise<string> {
    const data = await this.#call<{ deployment: { id: string } }>(`mutation($id: String!) { deployment: deploymentRedeploy(id: $id) { id } }`, { id: deploymentId })
    return data.deployment.id
  }

  async restart(deploymentId: string): Promise<void> {
    await this.#call(`mutation($id: String!) { deploymentRestart(id: $id) }`, { id: deploymentId })
  }

  async stop(deploymentId: string): Promise<void> {
    await this.#call(`mutation($id: String!) { deploymentStop(id: $id) }`, { id: deploymentId })
  }

  async rollback(deploymentId: string): Promise<void> {
    await this.#call(`mutation($id: String!) { deploymentRollback(id: $id) }`, { id: deploymentId })
  }

  /** The service's variables as set, with references unrendered. */
  async variables(projectId: string, environmentId: string, serviceId: string): Promise<Record<string, string>> {
    const data = await this.#call<{ variables: Record<string, string> }>(`query($projectId: String!, $environmentId: String!, $serviceId: String) {
      variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true) }`, { projectId, environmentId, serviceId })
    return data.variables ?? {}
  }

  /** Sets these variables and leaves the others as they are; Railway deploys the change. */
  async setVariables(projectId: string, environmentId: string, serviceId: string, variables: Record<string, string>): Promise<void> {
    await this.#call(`mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`, {
      input: { projectId, environmentId, serviceId, variables, replace: false },
    })
  }

  async settings(serviceId: string, environmentId: string): Promise<RailwayServiceSettings> {
    const data = await this.#call<{ serviceInstance: Omit<RailwayServiceSettings, 'source' | 'preDeployCommand'> & {
      source: { repo: string | null; image: string | null } | null; preDeployCommand: unknown
    }; service: { repoTriggers: { edges: Array<{ node: { branch: string } }> } } }>(
      `query($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { source { repo image } ${EDITABLE_SETTINGS.join(' ')} }
        service(id: $serviceId) { repoTriggers { edges { node { branch } } } } }`, { serviceId, environmentId })
    const instance = data.serviceInstance
    const pre = instance.preDeployCommand
    return {
      ...instance,
      source: { repo: instance.source?.repo ?? null, image: instance.source?.image ?? null, branch: data.service.repoTriggers.edges[0]?.node.branch ?? null },
      preDeployCommand: Array.isArray(pre) ? pre.map(String) : typeof pre === 'string' ? [pre] : null,
      watchPatterns: instance.watchPatterns ?? [],
    }
  }

  /** Changes the given build and deploy settings; Railway uses them from the next deployment. */
  async updateSettings(serviceId: string, environmentId: string, change: Partial<Pick<RailwayServiceSettings, EditableSetting>>): Promise<void> {
    const input = Object.fromEntries(Object.entries(change).filter(([key]) => (EDITABLE_SETTINGS as readonly string[]).includes(key)))
    if (Object.keys(input).length === 0) return
    await this.#call(`mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`, { serviceId, environmentId, input })
  }

  /** A new service in the project, deployed from `repo` (`owner/name`) at `branch`. */
  async createService(input: { projectId: string; environmentId: string; name: string; repo: string; branch: string | null }): Promise<{ id: string; name: string }> {
    const data = await this.#call<{ serviceCreate: { id: string; name: string } }>(`mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`, {
      input: { projectId: input.projectId, environmentId: input.environmentId, name: input.name, source: { repo: input.repo }, ...(input.branch ? { branch: input.branch } : {}) },
    })
    return data.serviceCreate
  }
}
