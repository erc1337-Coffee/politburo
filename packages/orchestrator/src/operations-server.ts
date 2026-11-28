// The orchestrator's status server for the operations view and the channel settings' Railway
// tab. It listens on 127.0.0.1 only: the board server shares the orchestrator's network namespace
// and forwards it to the inspector page, which checks the page token, and for a write its origin.
// Only the Railway routes accept writes.
//
//   GET /state                       snapshot of the board, orchestrator, relay and attempts
//   GET /events                      SSE of operations events, after Last-Event-ID
//   GET /attempts/{attempt}/events   the last events of one attempt
//
//   GET  /railway/projects                                       projects, production environments, services
//   POST /railway/projects                                       create a project, production only: { name }
//   GET  /railway/channels/{channel}/services                    status of the channel's services
//   POST /railway/channels/{channel}/services                    create a service from the channel's repository
//   GET  /railway/channels/{channel}/services/{id}/logs          ?kind=deploy|build&limit=N
//   POST /railway/channels/{channel}/services/{id}/{action}      start, stop, restart, redeploy, rollback
//   GET  /railway/channels/{channel}/services/{id}/variables
//   PUT  /railway/channels/{channel}/services/{id}/variables     { set: {name: value}, remove: [name] }
//   GET  /railway/channels/{channel}/services/{id}/settings
//   PUT  /railway/channels/{channel}/services/{id}/settings      { rootDirectory, buildCommand, ... }
//   GET  /railway/channels/{channel}/services/{id}/domains
//   POST /railway/channels/{channel}/services/{id}/domains       generate a railway.app domain: { targetPort? }
//   PUT  /railway/channels/{channel}/services/{id}/domains/{d}   { targetPort }
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OperationsMonitor, OperationsSnapshot } from './operations.ts'
import { RAILWAY_ACTIONS, RailwayRequestError, railwayFailure, type RailwayAction, type RailwayOperations } from './railway-operations.ts'

const KEEPALIVE_MS = 15_000
const STREAMS_MAX = 32
const ATTEMPT_ROUTE = /^\/attempts\/([0-9a-f-]{36})\/events$/
const RAILWAY_SERVICE = /^\/railway\/channels\/([^/]+)\/services\/([0-9a-f-]{36})\/(logs|variables|settings|domains|start|stop|restart|redeploy|rollback)$/
const RAILWAY_DOMAIN = /^\/railway\/channels\/([^/]+)\/services\/([0-9a-f-]{36})\/domains\/([0-9A-Za-z_-]{1,64})$/
const RAILWAY_SERVICES = /^\/railway\/channels\/([^/]+)\/services$/
const BODY_MAX = 256 * 1024
/** Who a request of the Railway tab is, in the channel's status lines. */
const TAB = 'the channel settings'

export interface OperationsServer {
  url: string
  close(): Promise<void>
}

export async function startOperationsServer(options: {
  monitor: OperationsMonitor
  snapshot: () => OperationsSnapshot
  port: number
  host?: string
  railway?: RailwayOperations | null
}): Promise<OperationsServer> {
  const { monitor } = options
  const streams = new Set<() => void>()

  const server: Server = createServer((request, response) => {
    try {
      handle(request, response)
    } catch {
      if (!response.headersSent) reply(response, 500, { error: 'internal_error' })
      else response.end()
    }
  })

  function handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://operations')
    if (url.pathname.startsWith('/railway/')) {
      void railway(request, response, url).catch((error: unknown) => {
        const { status, message } = railwayFailure(error)
        if (!response.headersSent) reply(response, status, { error: message })
        else response.end()
      })
      return
    }
    if (request.method !== 'GET') return reply(response, 405, { error: 'method_not_allowed' })
    const path = url.pathname
    if (path === '/state') return reply(response, 200, options.snapshot())
    if (path === '/events') return stream(request, response)
    const match = ATTEMPT_ROUTE.exec(path)
    if (match) {
      const events = monitor.attemptEvents(match[1]!)
      return events ? reply(response, 200, { events }) : reply(response, 404, { error: 'not_found' })
    }
    return reply(response, 404, { error: 'not_found' })
  }

  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > BODY_MAX) throw new RailwayRequestError(413, 'request body too large')
      chunks.push(chunk as Buffer)
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object expected')
      return value as Record<string, unknown>
    } catch {
      throw new RailwayRequestError(400, 'a JSON object is expected')
    }
  }

  async function railway(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const operations = options.railway
    if (!operations) return reply(response, 503, { error: 'the orchestrator has no Railway operations' })
    const method = request.method ?? 'GET'
    if (url.pathname === '/railway/projects') {
      if (method === 'GET') return reply(response, 200, { projects: await operations.projects() })
      if (method === 'POST') return reply(response, 201, { project: await operations.createProject(await body(request), TAB) })
      return reply(response, 405, { error: 'method_not_allowed' })
    }
    const domain = RAILWAY_DOMAIN.exec(url.pathname)
    if (domain) {
      if (method !== 'PUT') return reply(response, 405, { error: 'method_not_allowed' })
      await operations.setDomainPort(decodeURIComponent(domain[1]!), domain[2]!, domain[3]!, await body(request), TAB)
      return reply(response, 200, { ok: true })
    }
    const services = RAILWAY_SERVICES.exec(url.pathname)
    if (services) {
      const channel = decodeURIComponent(services[1]!)
      if (method === 'GET') return reply(response, 200, { services: await operations.statuses(channel) })
      if (method === 'POST') return reply(response, 201, { service: await operations.createService(channel, await body(request), TAB) })
      return reply(response, 405, { error: 'method_not_allowed' })
    }
    const match = RAILWAY_SERVICE.exec(url.pathname)
    if (!match) return reply(response, 404, { error: 'not_found' })
    const channel = decodeURIComponent(match[1]!)
    const service = match[2]!
    const what = match[3]!
    if (what === 'logs' && method === 'GET') {
      const kind = url.searchParams.get('kind') === 'build' ? 'build' : 'deploy'
      return reply(response, 200, await operations.logs(channel, service, kind, Number(url.searchParams.get('limit') ?? 100) || 100))
    }
    if (what === 'variables') {
      if (method === 'GET') return reply(response, 200, { variables: await operations.variables(channel, service) })
      if (method === 'PUT') return reply(response, 200, await operations.setVariables(channel, service, await body(request), TAB))
      return reply(response, 405, { error: 'method_not_allowed' })
    }
    if (what === 'domains') {
      if (method === 'GET') return reply(response, 200, await operations.domains(channel, service))
      if (method === 'POST') return reply(response, 201, { domain: await operations.createDomain(channel, service, await body(request), TAB) })
      return reply(response, 405, { error: 'method_not_allowed' })
    }
    if (what === 'settings') {
      if (method === 'GET') return reply(response, 200, { settings: await operations.settings(channel, service) })
      if (method === 'PUT') return reply(response, 200, { changed: await operations.updateSettings(channel, service, await body(request), TAB) })
      return reply(response, 405, { error: 'method_not_allowed' })
    }
    if ((RAILWAY_ACTIONS as readonly string[]).includes(what) && method === 'POST') {
      return reply(response, 200, { outcome: await operations.act(channel, service, what as RailwayAction, TAB) })
    }
    return reply(response, 405, { error: 'method_not_allowed' })
  }

  function stream(request: IncomingMessage, response: ServerResponse): void {
    if (streams.size >= STREAMS_MAX) return reply(response, 503, { error: 'too_many_streams' })
    const header = String(request.headers['last-event-id'] ?? '')
    const after = /^\d{1,15}$/.test(header) ? Number(header) : null
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    response.write('retry: 2000\n\n')
    const backlog = after === null ? [] : monitor.since(after)
    // A gap the monitor no longer holds: the client reloads the snapshot.
    if (backlog === null) response.write('event: reset\ndata: {}\n\n')
    else for (const event of backlog) response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
    const unsubscribe = monitor.subscribe((event) => {
      response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), KEEPALIVE_MS)
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      clearInterval(keepalive)
      unsubscribe()
      streams.delete(end)
      response.end()
    }
    streams.add(end)
    response.on('close', end)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://${address.address}:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      for (const end of [...streams]) end()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(body))
}
