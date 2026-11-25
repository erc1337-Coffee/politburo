// Relay HTTP server. Routes and buffers messages, checks tokens, decides nothing.
//
//   POST   /channels/{channel}/{direction}   send one JSON object
//   GET    /channels/{channel}/{direction}   receive as SSE, after Last-Event-ID
//   DELETE /channels/{channel}               end a channel (orchestrator only)
//   GET    /stats                             counters (statistics token only)
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { KeyObject } from 'node:crypto'
import {
  CHANNEL_PATTERN,
  RECEIVER,
  SENDER,
  isDirection,
  loadVerificationKey,
  verifyToken,
  type Direction,
  type DirectionStatistics,
  type RelayStatistics,
  type TokenClaims,
} from './protocol.ts'
import type { MessageStore, StoredMessage } from './store.ts'

export interface RelayLimits {
  /** Largest accepted request body, in bytes. */
  maxMessageBytes: number
  /** How long a message is kept after its sender's token expires, in seconds. */
  retentionSeconds: number
  /** Interval of SSE keepalive comments, in seconds. */
  keepaliveSeconds: number
  /** Messages read from the store per batch. */
  batchSize: number
}

export const DEFAULT_LIMITS: Readonly<RelayLimits> = {
  maxMessageBytes: 64 * 1024,
  retentionSeconds: 24 * 60 * 60,
  keepaliveSeconds: 15,
  batchSize: 500,
}

export interface RelayOptions {
  /** The orchestrator's public key. The relay never holds the signing key. */
  verificationKey: KeyObject | string
  store: MessageStore
  limits?: Partial<RelayLimits>
  /** Clock, Unix milliseconds. For tests. */
  now?: () => number
}

export interface Relay {
  server: Server
  close(): Promise<void>
}

const PURGE_INTERVAL_MS = 60_000
/** Smallest interval between two statistics reads with one token. */
const STATISTICS_INTERVAL_MS = 1_000
/** Channels kept in the counters; the oldest is dropped first. */
const STATISTICS_CHANNELS = 1_000
const ROUTE = /^\/channels\/([^/]+)(?:\/([^/]+))?$/

class Signal {
  readonly #listeners = new Map<string, Set<() => void>>()

  on(key: string, listener: () => void): () => void {
    let set = this.#listeners.get(key)
    if (!set) this.#listeners.set(key, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.#listeners.delete(key)
    }
  }

  emit(key: string): void {
    for (const listener of [...(this.#listeners.get(key) ?? [])]) listener()
  }
}

export function createRelay(options: RelayOptions): Relay {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const verificationKey = loadVerificationKey(options.verificationKey)
  const store = options.store
  const now = options.now ?? Date.now
  const signal = new Signal()
  const streams = new Map<string, Set<() => void>>()
  const startedAt = now()
  const counters = new Map<string, Record<Direction, DirectionStatistics>>()
  const refused = new Map<number, number>()
  const statisticsReads = new Map<string, number>()

  const counter = (channel: string, direction: Direction): DirectionStatistics => {
    let entry = counters.get(channel)
    if (!entry) {
      if (counters.size >= STATISTICS_CHANNELS) counters.delete(counters.keys().next().value!)
      const empty = (): DirectionStatistics => ({ messages: 0, bytes: 0, last_seq: 0, last_at: null, streams: 0 })
      counters.set(channel, (entry = { commands: empty(), telemetry: empty() }))
    }
    return entry[direction]
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500) refused.set(res.statusCode, (refused.get(res.statusCode) ?? 0) + 1)
    })
    handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, { error: 'internal_error' })
      else res.end()
    })
  }

  function statistics(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') return reply(res, 404, { error: 'not_found' })
    const claims = authenticate(req)
    if (!claims || claims.role !== 'statistics') return reply(res, 401, { error: 'unauthorized' })
    const key = `${claims.iat}:${claims.exp}:${req.headers.authorization!.slice(-16)}`
    const at = now()
    if (at - (statisticsReads.get(key) ?? 0) < STATISTICS_INTERVAL_MS) return reply(res, 429, { error: 'too_many_requests' })
    statisticsReads.set(key, at)
    for (const [k, last] of statisticsReads) if (at - last > 120_000) statisticsReads.delete(k)
    const body: RelayStatistics = {
      started_at: startedAt, at,
      channels: Object.fromEntries([...counters].map(([name, entry]) => [name, structuredClone(entry)])),
      refused: Object.fromEntries([...refused].map(([status, count]) => [String(status), count])),
    }
    return reply(res, 200, body)
  }

  const server = createHttpServer(handler)

  const purge = setInterval(() => store.purgeExpired(now()), PURGE_INTERVAL_MS)
  purge.unref()

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay')
    if (url.pathname === '/stats') return statistics(req, res)
    const match = ROUTE.exec(url.pathname)
    const channel = match?.[1]
    const direction = match?.[2]
    if (!channel || !CHANNEL_PATTERN.test(channel)) return reply(res, 404, { error: 'not_found' })
    if (direction !== undefined && !isDirection(direction)) return reply(res, 404, { error: 'not_found' })

    // One answer for a missing, forged, expired or other-channel token.
    const claims = authenticate(req)
    if (!claims || claims.channel !== channel) return reply(res, 401, { error: 'unauthorized' })

    if (direction === undefined) {
      if (req.method !== 'DELETE') return reply(res, 404, { error: 'not_found' })
      if (claims.role !== 'orchestrator') return reply(res, 403, { error: 'forbidden' })
      store.deleteChannel(channel)
      counters.delete(channel)
      for (const end of [...(streams.get(channel) ?? [])]) end()
      res.writeHead(204, { 'cache-control': 'no-store' }).end()
      return
    }
    if (req.method === 'POST') return send(req, res, claims, channel, direction)
    if (req.method === 'GET') return receive(req, res, claims, channel, direction)
    return reply(res, 404, { error: 'not_found' })
  }

  function authenticate(req: IncomingMessage): TokenClaims | null {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return null
    return verifyToken(verificationKey, header.slice('Bearer '.length).trim(), now())
  }

  async function send(req: IncomingMessage, res: ServerResponse, claims: TokenClaims, channel: string, direction: Direction): Promise<void> {
    if (claims.role !== SENDER[direction]) return reply(res, 403, { error: 'forbidden' })
    const raw = await readBody(req, limits.maxMessageBytes)
    if (raw === null) return reply(res, 413, { error: 'message_too_large' })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      return reply(res, 400, { error: 'invalid_json' })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return reply(res, 400, { error: 'invalid_json' })
    const at = now()
    const seq = store.append(channel, direction, JSON.stringify(parsed), at, claims.exp * 1000 + limits.retentionSeconds * 1000)
    const count = counter(channel, direction)
    count.messages++
    count.bytes += raw.length
    count.last_seq = seq
    count.last_at = at
    signal.emit(`${channel}/${direction}`)
    return reply(res, 201, { seq })
  }

  function receive(req: IncomingMessage, res: ServerResponse, claims: TokenClaims, channel: string, direction: Direction): void {
    if (claims.role !== RECEIVER[direction]) return reply(res, 403, { error: 'forbidden' })
    const after = parseCount(req.headers['last-event-id'] ?? '0')
    if (after === null) return reply(res, 400, { error: 'invalid_last_event_id' })
    return stream(res, claims, channel, direction, after)
  }

  function stream(res: ServerResponse, claims: TokenClaims, channel: string, direction: Direction, after: number): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    res.write('retry: 3000\n\n')
    let last = after
    let closed = false
    const flush = (): void => {
      if (closed) return
      for (;;) {
        const batch = store.read(channel, direction, last, limits.batchSize, now())
        for (const message of batch) {
          res.write(`id: ${message.seq}\ndata: ${frame(message)}\n\n`)
          last = message.seq
        }
        if (batch.length < limits.batchSize) return
      }
    }
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), limits.keepaliveSeconds * 1000)
    // The stream ends when the token does; the client reconnects with a new one.
    const expiry = setTimeout(() => end(), Math.min(Math.max(claims.exp * 1000 - now(), 0), 2 ** 31 - 1))
    const unsubscribe = signal.on(`${channel}/${direction}`, flush)
    counter(channel, direction).streams++
    let set = streams.get(channel)
    if (!set) streams.set(channel, (set = new Set()))
    const channelStreams = set
    const end = (): void => {
      if (closed) return
      closed = true
      clearInterval(keepalive)
      clearTimeout(expiry)
      unsubscribe()
      const count = counters.get(channel)?.[direction]
      if (count) count.streams = Math.max(0, count.streams - 1)
      channelStreams.delete(end)
      if (channelStreams.size === 0) streams.delete(channel)
      res.end()
    }
    channelStreams.add(end)
    res.on('close', end)
    flush()
  }

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(purge)
        for (const set of [...streams.values()]) for (const end of [...set]) end()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function frame(message: StoredMessage): string {
  // The body is stored as compact JSON, so it fits on one SSE data line.
  return `{"seq":${message.seq},"at":${message.at},"body":${message.body}}`
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function parseCount(value: string | string[]): number | null {
  const text = Array.isArray(value) ? value[0] ?? '' : value
  if (!/^\d{1,15}$/.test(text)) return null
  return Number(text)
}

/** The body, or null when it is larger than `limit`. A larger body is read to the end and dropped. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    let size = 0
    let tooLarge = declared > limit
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) tooLarge = true
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
