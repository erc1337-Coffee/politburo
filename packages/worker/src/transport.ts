// Worker side of the relay: follows the commands stream over SSE and posts telemetry
// from an outbox kept on disk. Every connection is outbound. The token is never logged.
import type { Telemetry } from '../../relay/src/messages.ts'
import type { WorkerFiles } from './state.ts'

/** The expiry (Unix seconds) written in a relay token, or 0 when it cannot be read. */
export function tokenExpiry(token: string): number {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp : 0
  } catch {
    return 0
  }
}

export interface TransportOptions {
  relayUrl: string
  channel: string
  files: WorkerFiles
  token: () => string
  /** Called on every byte from the relay and on every accepted POST. */
  onContact: () => void
  /** 401 or 403: the relay refuses this token. */
  onRefused: (status: number) => void
  log: (line: string) => void
  /** No byte for this long ends the stream and reconnects. Default 45 s (three missed keepalives). */
  silenceMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const backoff = (attempt: number) => Math.min(60_000, 3_000 * 2 ** attempt) * (1 + Math.random() * 0.2)

export class CommandStream {
  readonly #options: TransportOptions
  readonly #onEvent: (seq: number, body: unknown) => Promise<void>
  readonly #after: () => number
  #controller: AbortController | null = null
  #closed = false
  #loop: Promise<void> | null = null

  constructor(options: TransportOptions, after: () => number, onEvent: (seq: number, body: unknown) => Promise<void>) {
    this.#options = options
    this.#after = after
    this.#onEvent = onEvent
  }

  start(): void {
    this.#loop ??= this.#run()
  }

  /** Ends the current connection; the loop reconnects at once with the current token. */
  reconnect(): void {
    this.#controller?.abort()
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#controller?.abort()
    await this.#loop
  }

  async #run(): Promise<void> {
    const { relayUrl, channel, onContact, onRefused, log } = this.#options
    const silenceMs = this.#options.silenceMs ?? 45_000
    let failures = 0
    while (!this.#closed) {
      const controller = new AbortController()
      this.#controller = controller
      let silence: NodeJS.Timeout | undefined
      const arm = () => {
        clearTimeout(silence)
        silence = setTimeout(() => controller.abort(), silenceMs)
      }
      try {
        arm()
        const response = await fetch(`${relayUrl}/channels/${channel}/commands`, {
          headers: { authorization: `Bearer ${this.#options.token()}`, 'last-event-id': String(this.#after()), accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 403) {
          clearTimeout(silence)
          onRefused(response.status)
          return
        }
        if (!response.ok || !response.body) throw new Error(`commands stream answered ${response.status}`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          arm()
          onContact()
          failures = 0
          buffer += decoder.decode(value, { stream: true })
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
            if (!data) continue
            let event: { seq?: unknown; body?: unknown }
            try {
              event = JSON.parse(data) as { seq?: unknown; body?: unknown }
            } catch {
              log('commands stream: an event is not JSON')
              continue
            }
            if (typeof event.seq === 'number') await this.#onEvent(event.seq, event.body)
          }
        }
      } catch (error) {
        if (this.#closed) break
        if (!controller.signal.aborted) {
          log(`commands stream: ${(error as Error).message}`)
          await sleep(backoff(failures++))
        }
      } finally {
        clearTimeout(silence)
      }
    }
  }
}

interface OutboxEntry { id: string; type: string; body: string }

/** Telemetry outbox: one POST at a time, in order; an entry leaves only after the relay accepts it. */
export class TelemetrySender {
  readonly #options: TransportOptions
  #entries: OutboxEntry[]
  #flushing: Promise<void> | null = null
  #wake: (() => void) | null = null
  #closed = false

  constructor(options: TransportOptions) {
    this.#options = options
    this.#entries = options.files.readJson<OutboxEntry[]>('outbox.json') ?? []
  }

  get pending(): number {
    return this.#entries.length
  }

  send(message: Telemetry): void {
    if (message.type === 'heartbeat') this.#entries = this.#entries.filter((entry) => entry.type !== 'heartbeat')
    this.#entries.push({ id: message.id, type: message.type, body: JSON.stringify(message) })
    this.#save()
    this.#wake?.()
    this.#flushing ??= this.#flush().finally(() => { this.#flushing = null })
  }

  /** Waits until the outbox is empty or `timeoutMs` passes; true when empty. */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.#entries.length > 0 && Date.now() < deadline) {
      this.#flushing ??= this.#flush().finally(() => { this.#flushing = null })
      await sleep(200)
    }
    return this.#entries.length === 0
  }

  close(): void {
    this.#closed = true
    this.#wake?.()
  }

  #save(): void {
    this.#options.files.writeJson('outbox.json', this.#entries)
  }

  async #flush(): Promise<void> {
    const { relayUrl, channel, onContact, onRefused, log } = this.#options
    let failures = 0
    while (this.#entries.length > 0 && !this.#closed) {
      const entry = this.#entries[0]!
      let status = 0
      try {
        const response = await fetch(`${relayUrl}/channels/${channel}/telemetry`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.#options.token()}`, 'content-type': 'application/json' },
          body: entry.body,
          signal: AbortSignal.timeout(15_000),
        })
        status = response.status
        await response.body?.cancel()
      } catch (error) {
        log(`telemetry: ${(error as Error).message}`)
      }
      if (status === 201 || status === 200) {
        onContact()
        failures = 0
        this.#entries.shift()
        this.#save()
        continue
      }
      if (status === 401 || status === 403) {
        onRefused(status)
        return
      }
      if (status === 400 || status === 413) {
        log(`telemetry: relay refused a ${entry.type} message (${status}); dropped`)
        this.#entries.shift()
        this.#save()
        continue
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff(failures++))
        this.#wake = () => { clearTimeout(timer); resolve() }
      })
      this.#wake = null
    }
  }
}
