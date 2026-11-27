// Relay client for the orchestrator: mints tokens, posts commands, follows telemetry.
// Every connection is outbound. Tokens are minted locally for each request or stream.
import type { KeyObject } from 'node:crypto'
import { loadSigningKey, signToken, STATISTICS_CHANNEL, type Direction, type RelayStatistics, type Role } from '@remilia/politburo-relay/protocol'

export class RelayError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`relay answered ${status} ${code}`)
    this.status = status
    this.code = code
  }
}

export interface RelayMessageEvent { seq: number; at: number; body: unknown }

export interface Subscription { close(): void }

export interface RelayClientOptions {
  url: string
  signingKey: KeyObject | string
  orchestratorTtlSeconds: number
  fetch?: typeof fetch
  now?: () => number
}

const BACKOFF_START_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** Three missed relay keepalives (15 s each) mean the stream is dead. */
const SILENCE_MS = 45_000

export class RelayClient {
  readonly #base: string
  readonly #key: KeyObject
  readonly #ttl: number
  readonly #fetch: typeof fetch
  readonly #now: () => number

  constructor(options: RelayClientOptions) {
    this.#base = options.url.replace(/\/+$/, '')
    this.#key = loadSigningKey(options.signingKey)
    this.#ttl = options.orchestratorTtlSeconds
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  /** A token for `channel`. Worker tokens go to the worker; orchestrator tokens stay here. */
  token(channel: string, role: Role, ttlSeconds: number = this.#ttl): { token: string; exp: number } {
    const token = signToken(this.#key, { channel, role, ttlSeconds, now: this.#now() })
    return { token, exp: Math.floor(this.#now() / 1000) + ttlSeconds }
  }

  #url(channel: string, direction?: Direction): string {
    return `${this.#base}/channels/${encodeURIComponent(channel)}${direction ? `/${direction}` : ''}`
  }

  async post(channel: string, body: unknown): Promise<number> {
    const response = await this.#fetch(this.#url(channel, 'commands'), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token(channel, 'orchestrator').token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const answer = await response.json().catch(() => ({})) as { seq?: number; error?: string }
    if (response.status !== 201 || typeof answer.seq !== 'number') throw new RelayError(response.status, answer.error ?? 'unexpected_answer')
    return answer.seq
  }

  async remove(channel: string): Promise<void> {
    const response = await this.#fetch(this.#url(channel), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.token(channel, 'orchestrator').token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status !== 204) throw new RelayError(response.status, 'delete_failed')
  }

  /** The relay's counters, read with a 60 s statistics token, and the time the answer took. */
  async statistics(): Promise<{ statistics: RelayStatistics; latencyMs: number }> {
    const started = performance.now()
    const response = await this.#fetch(`${this.#base}/stats`, {
      headers: { authorization: 'Bearer ' + this.token(STATISTICS_CHANNEL, 'statistics', 60).token },
      signal: AbortSignal.timeout(10_000),
    })
    const answer = await response.json().catch(() => ({})) as RelayStatistics & { error?: string }
    if (response.status !== 200) throw new RelayError(response.status, answer.error ?? 'unexpected_answer')
    return { statistics: answer, latencyMs: Math.round(performance.now() - started) }
  }

  /**
   * Follows the telemetry of `channel` from after `after`. `onMessage` runs for each event in order and
   * must return once its effect is stored; the stream resumes from the last seq it was given.
   * Reconnects with backoff and a fresh token. 401/403 stop the subscription and call `onRefused`.
   */
  subscribe(channel: string, after: number, onMessage: (event: RelayMessageEvent) => Promise<void>, onRefused?: (status: number) => void): Subscription {
    const controller = new AbortController()
    let last = after
    let backoff = BACKOFF_START_MS
    const run = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const attempt = new AbortController()
        const abort = (): void => attempt.abort()
        controller.signal.addEventListener('abort', abort, { once: true })
        let silence: NodeJS.Timeout | undefined
        const resetSilence = (): void => {
          clearTimeout(silence)
          silence = setTimeout(() => attempt.abort(), SILENCE_MS)
        }
        try {
          resetSilence()
          const response = await this.#fetch(this.#url(channel, 'telemetry'), {
            headers: { authorization: `Bearer ${this.token(channel, 'orchestrator').token}`, accept: 'text/event-stream', 'last-event-id': String(last) },
            signal: attempt.signal,
          })
          if (response.status === 401 || response.status === 403) {
            onRefused?.(response.status)
            return
          }
          if (response.status !== 200 || !response.body) throw new RelayError(response.status, 'stream_refused')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let id: number | null = null
          let data: string[] = []
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            resetSilence()
            backoff = BACKOFF_START_MS
            buffer += decoder.decode(value, { stream: true })
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline).replace(/\r$/, '')
              buffer = buffer.slice(newline + 1)
              if (line === '') {
                if (id !== null && data.length > 0 && id > last) {
                  const frame = JSON.parse(data.join('\n')) as RelayMessageEvent
                  await onMessage(frame)
                  last = id
                }
                id = null
                data = []
              } else if (line.startsWith('id:')) id = Number(line.slice(3).trim())
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
            }
          }
        } catch {
          // Network error, silence or a refused stream: reconnect after the backoff.
        } finally {
          clearTimeout(silence)
          controller.signal.removeEventListener('abort', abort)
        }
        if (controller.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, backoff * (1 + Math.random() * 0.2)))
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    }
    void run()
    return { close: () => controller.abort() }
  }
}
