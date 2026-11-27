// The orchestrator's read-only status server for the operations view. It listens on 127.0.0.1
// only: the board server shares the orchestrator's network namespace and forwards it to the
// inspector page, which checks the page token. Nothing here accepts a write.
//
//   GET /state                       snapshot of the board, orchestrator, relay and attempts
//   GET /events                      SSE of operations events, after Last-Event-ID
//   GET /attempts/{attempt}/events   the last events of one attempt
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OperationsMonitor, OperationsSnapshot } from './operations.ts'

const KEEPALIVE_MS = 15_000
const STREAMS_MAX = 32
const ATTEMPT_ROUTE = /^\/attempts\/([0-9a-f-]{36})\/events$/

export interface OperationsServer {
  url: string
  close(): Promise<void>
}

export async function startOperationsServer(options: {
  monitor: OperationsMonitor
  snapshot: () => OperationsSnapshot
  port: number
  host?: string
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
    if (request.method !== 'GET') return reply(response, 405, { error: 'method_not_allowed' })
    const path = new URL(request.url ?? '/', 'http://operations').pathname
    if (path === '/state') return reply(response, 200, options.snapshot())
    if (path === '/events') return stream(request, response)
    const match = ATTEMPT_ROUTE.exec(path)
    if (match) {
      const events = monitor.attemptEvents(match[1]!)
      return events ? reply(response, 200, { events }) : reply(response, 404, { error: 'not_found' })
    }
    return reply(response, 404, { error: 'not_found' })
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
