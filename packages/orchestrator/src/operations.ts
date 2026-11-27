// What the operations view sees of the orchestrator: an event for each message, tick and state
// change, and a snapshot of the live attempts. Events carry types, sizes, times, sequence numbers
// and states, never message content: no briefs, summaries, answers, bundle data or tokens.
import type { RelayStatistics } from '@remilia/politburo-relay/protocol'
import type { AttemptRecord } from './state.ts'

export type WakeSource = 'start' | 'board' | 'telemetry' | 'timer' | 'sweep' | 'request'

export type OperationsEventBody =
  | { kind: 'tick'; sources: WakeSource[]; live: number; duration_ms: number }
  | { kind: 'command'; channel: string; task: string; type: string; bytes: number; outcome: 'sent' | 'failed' }
  | { kind: 'telemetry'; channel: string; task: string; type: string; bytes: number; relay_seq: number }
  | { kind: 'phase'; channel: string; task: string; phase: string; round: number; duration_seconds?: number }
  | { kind: 'board'; action: 'claim' | 'renew' | 'reply' | 'complete' | 'fail' | 'release' | 'block'; task: string; channel?: string }
  | { kind: 'github'; action: 'push' | 'draft_pr'; repository: string; task: string; channel: string }
  | { kind: 'launch'; task: string; channel: string; outcome: string }
  | { kind: 'attempt'; attempt: string; task: string; channel: string; state: string }
  | { kind: 'fault'; component: 'board' | 'relay' | 'github' | 'worker' | 'launch' | 'ledger'; code: string; task?: string; channel?: string }
  | { kind: 'usage'; task: string; channel: string; round: number; models: number; providers: string[]; input_tokens: number; output_tokens: number; cost_usd: number }
  | { kind: 'decision_step'; task: string; channel: string; model: 'kev' | 'claude' }
  | { kind: 'decision'; task: string; channel: string; label: string; decided_by: string }

export type OperationsEvent = OperationsEventBody & { seq: number; at: number }

export interface WorkerHeartbeat {
  at: number
  state: string
  round: number
  elapsed_seconds: number
  pi_alive: boolean
}

/** The worker's latest acknowledged step. */
export interface WorkerPhase {
  at: number
  phase: string
  round: number
  detail?: string
  duration_seconds?: number
}

export interface AttemptView {
  attempt_id: string
  task_id: string
  attempt_no: number
  channel: string
  board_channel: string
  repository: string
  branch: string
  state: string
  outcome: string | null
  round: number
  created_at: number
  launched_at: number | null
  last_contact_at: number | null
  question_at: number | null
  stop_sent_at: number | null
  watchdog_due: number | null
  cost_usd: number
  pr_url: string | null
  heartbeat: WorkerHeartbeat | null
  phase: WorkerPhase | null
  progress: Record<string, number>
  messages: { commands: number; telemetry: number; last_at: number | null }
  /** The model the attempt's final decision waits on now; null when no decision runs. */
  decision_model: 'kev' | 'claude' | null
}

export interface RelayView {
  host: string
  reachable: boolean | null
  latency_ms: number | null
  checked_at: number | null
  error: string | null
  statistics: RelayStatistics | null
}

export interface OperationsSnapshot {
  at: number
  started_at: number
  board: { reachable: boolean | null; paused: boolean | null; pause_epoch: number | null; checked_at: number | null; error: string | null }
  orchestrator: {
    status: 'serving' | 'idle'
    /** Why an idle orchestrator does not serve. */
    reason: string | null
    actor: string
    live: number
    live_limit: number
    outbox: number
    sweep_seconds: number
    last_tick: { at: number; sources: WakeSource[]; duration_ms: number } | null
    ticks_last_minute: number
  }
  relay: RelayView
  attempts: AttemptView[]
  /** The newest event sequence number, for an events stream that starts after this snapshot. */
  last_seq: number
}

const EVENTS_KEPT = 2_000
const EVENTS_PER_ATTEMPT = 200
const SETTLED_KEPT = 20

/** Short, content-free error codes: an error message may quote a URL, a path or a server answer. */
export function errorCode(error: unknown): string {
  const named = error as { code?: unknown; status?: unknown; name?: unknown }
  if (typeof named?.status === 'number') return `status_${named.status}`
  if (typeof named?.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(named.code)) return named.code
  if (typeof named?.name === 'string' && /^[A-Za-z]{1,40}$/.test(named.name)) return named.name
  return 'error'
}

/** The snapshot of an orchestrator that does not run, and why. */
export function idleSnapshot(reason: string, relayUrl: string, now = Date.now()): OperationsSnapshot {
  let host = ''
  try { host = new URL(relayUrl).host } catch { host = '' }
  return {
    at: now, started_at: now,
    board: { reachable: null, paused: null, pause_epoch: null, checked_at: null, error: null },
    orchestrator: { status: 'idle', reason: reason.slice(0, 300), actor: '', live: 0, live_limit: 0, outbox: 0, sweep_seconds: 0, last_tick: null, ticks_last_minute: 0 },
    relay: { host, reachable: null, latency_ms: null, checked_at: null, error: null, statistics: null },
    attempts: [],
    last_seq: 0,
  }
}

export class OperationsMonitor {
  readonly startedAt: number
  readonly #now: () => number
  readonly #deciding = new Map<string, 'kev' | 'claude'>()
  readonly #events: OperationsEvent[] = []
  readonly #byAttempt = new Map<string, OperationsEvent[]>()
  readonly #channels = new Map<string, string>()
  readonly #listeners = new Set<(event: OperationsEvent) => void>()
  readonly #heartbeats = new Map<string, WorkerHeartbeat>()
  readonly #phases = new Map<string, WorkerPhase>()
  readonly #progress = new Map<string, Record<string, number>>()
  readonly #messages = new Map<string, { commands: number; telemetry: number; last_at: number | null }>()
  readonly #settled: AttemptRecord[] = []
  #seq = 0
  #lastTick: OperationsSnapshot['orchestrator']['last_tick'] = null
  #board: OperationsSnapshot['board'] = { reachable: null, paused: null, pause_epoch: null, checked_at: null, error: null }
  #relay: RelayView

  constructor(options: { relayUrl: string; now?: () => number }) {
    this.#now = options.now ?? Date.now
    this.startedAt = this.#now()
    let host = ''
    try { host = new URL(options.relayUrl).host } catch { host = '' }
    this.#relay = { host, reachable: null, latency_ms: null, checked_at: null, error: null, statistics: null }
  }

  record(body: OperationsEventBody): OperationsEvent {
    const event = { ...body, seq: ++this.#seq, at: this.#now() } as OperationsEvent
    this.#events.push(event)
    if (this.#events.length > EVENTS_KEPT) this.#events.splice(0, this.#events.length - EVENTS_KEPT)
    const channel = 'channel' in event ? event.channel : undefined
    const attempt = event.kind === 'attempt' ? event.attempt : channel ? this.#channels.get(channel) : undefined
    if (event.kind === 'attempt') this.#channels.set(event.channel, event.attempt)
    if (attempt) {
      let list = this.#byAttempt.get(attempt)
      if (!list) this.#byAttempt.set(attempt, (list = []))
      list.push(event)
      if (list.length > EVENTS_PER_ATTEMPT) list.splice(0, list.length - EVENTS_PER_ATTEMPT)
      if (event.kind === 'command' || event.kind === 'telemetry') {
        const counts = this.#messages.get(attempt) ?? { commands: 0, telemetry: 0, last_at: null }
        if (event.kind === 'command') counts.commands++
        else counts.telemetry++
        counts.last_at = event.at
        this.#messages.set(attempt, counts)
      }
    }
    if (event.kind === 'tick') this.#lastTick = { at: event.at, sources: event.sources, duration_ms: event.duration_ms }
    for (const listener of [...this.#listeners]) {
      try { listener(event) } catch { this.#listeners.delete(listener) }
    }
    return event
  }

  heartbeat(attemptId: string, beat: Omit<WorkerHeartbeat, 'at'>): void {
    this.#heartbeats.set(attemptId, { ...beat, at: this.#now() })
  }

  phase(attemptId: string, phase: Omit<WorkerPhase, 'at'>): void {
    this.#phases.set(attemptId, { ...phase, at: this.#now() })
  }

  /** The model the attempt's final decision waits on now, or null when the decision ended. */
  deciding(attemptId: string, model: 'kev' | 'claude' | null): void {
    if (model) this.#deciding.set(attemptId, model)
    else this.#deciding.delete(attemptId)
  }

  progress(attemptId: string, kinds: string[]): void {
    const counts = this.#progress.get(attemptId) ?? {}
    for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1
    this.#progress.set(attemptId, counts)
  }

  /** Keeps a settled attempt visible for a while, so the view can show how it ended. */
  settled(attempt: AttemptRecord): void {
    const index = this.#settled.findIndex((row) => row.attemptId === attempt.attemptId)
    if (index >= 0) this.#settled.splice(index, 1)
    this.#settled.push({ ...attempt })
    while (this.#settled.length > SETTLED_KEPT) {
      const dropped = this.#settled.shift()!
      this.#byAttempt.delete(dropped.attemptId)
      this.#heartbeats.delete(dropped.attemptId)
      this.#phases.delete(dropped.attemptId)
      this.#progress.delete(dropped.attemptId)
      this.#messages.delete(dropped.attemptId)
      this.#deciding.delete(dropped.attemptId)
      this.#channels.delete(dropped.channel)
    }
  }

  board(view: Partial<OperationsSnapshot['board']>): void {
    this.#board = { ...this.#board, ...view, checked_at: this.#now() }
  }

  relay(view: Partial<RelayView>): void {
    this.#relay = { ...this.#relay, ...view, checked_at: this.#now() }
  }

  get relayView(): RelayView {
    return this.#relay
  }

  subscribe(listener: (event: OperationsEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Events after `seq`, oldest first; null when they are no longer kept. */
  since(seq: number): OperationsEvent[] | null {
    const first = this.#events[0]
    if (first && seq < first.seq - 1) return null
    return this.#events.filter((event) => event.seq > seq)
  }

  attemptEvents(attemptId: string): OperationsEvent[] | null {
    return this.#byAttempt.get(attemptId)?.slice() ?? null
  }

  snapshot(input: {
    actor: string
    live: AttemptRecord[]
    liveLimit: number
    outbox: number
    sweepSeconds: number
    watchdogDue: (attempt: AttemptRecord) => number | null
  }): OperationsSnapshot {
    const now = this.#now()
    const liveIds = new Set(input.live.map((attempt) => attempt.attemptId))
    const rows = [...input.live, ...this.#settled.filter((attempt) => !liveIds.has(attempt.attemptId)).reverse()]
    return {
      at: now,
      started_at: this.startedAt,
      board: this.#board,
      orchestrator: {
        status: 'serving', reason: null, actor: input.actor, live: input.live.length, live_limit: input.liveLimit, outbox: input.outbox,
        sweep_seconds: input.sweepSeconds, last_tick: this.#lastTick,
        ticks_last_minute: this.#events.filter((event) => event.kind === 'tick' && event.at > now - 60_000).length,
      },
      relay: this.#relay,
      attempts: rows.map((attempt) => ({
        attempt_id: attempt.attemptId, task_id: attempt.taskId, attempt_no: attempt.attemptNo, channel: attempt.channel,
        board_channel: attempt.boardChannel, repository: attempt.repository, branch: attempt.branch, state: attempt.state,
        outcome: attempt.outcome, round: attempt.round, created_at: attempt.createdAt, launched_at: attempt.launchedAt,
        last_contact_at: attempt.lastContactAt, question_at: attempt.questionAt, stop_sent_at: attempt.stopSentAt,
        watchdog_due: liveIds.has(attempt.attemptId) ? input.watchdogDue(attempt) : null,
        cost_usd: attempt.costUsd, pr_url: attempt.prUrl,
        heartbeat: this.#heartbeats.get(attempt.attemptId) ?? null,
        phase: this.#phases.get(attempt.attemptId) ?? null,
        progress: this.#progress.get(attempt.attemptId) ?? {},
        messages: this.#messages.get(attempt.attemptId) ?? { commands: 0, telemetry: 0, last_at: null },
        decision_model: this.#deciding.get(attempt.attemptId) ?? null,
      })),
      last_seq: this.#seq,
    }
  }
}
