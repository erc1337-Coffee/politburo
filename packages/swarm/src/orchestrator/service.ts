// The orchestrator service: claims board tasks, starts one remote worker per attempt,
// follows it through the relay, decides the next step and settles the board task.
//
// Wake sources (event based, one serialized tick at a time):
//   - board events (long-poll feed)            -> new or changed tasks
//   - telemetry from a live attempt (relay SSE) -> handled at once
//   - the next due timer (lease, token, watchdog)
//   - a sweep every `sweepSeconds`              -> catches anything missed
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardError, type board as openBoard, type MessageView } from '@vercel/board'
import { envelope, parseTelemetry, type BundlePartData, type Command, type ResultData, type StartData, type Telemetry } from '@remilia/politburo-relay/messages'
import { repositoryAllowed, type OrchestratorConfig } from './config.ts'
import type { GitRepositories } from './git.ts'
import type { UsageLedger } from './usage-ledger.ts'
import { errorCode, type OperationsEventBody, type OperationsMonitor, type OperationsSnapshot, type WakeSource } from './operations.ts'
import { repositoryName, type GitHubClient } from './github.ts'
import { launch, launchKey, recover, type Binding, type Journal, type Provider } from './launch.ts'
import { workerPrompt } from './launcher.ts'
import { workerFiles } from './worker-files.ts'
import { fixedRulesPolicy, limitStep, type NextStep, type NextStepPolicy } from './policy.ts'
import type { RelayClient, Subscription } from './relay-client.ts'
import { LIVE_STATES, type AttemptRecord, type StateStore } from './state.ts'

type Board = ReturnType<typeof openBoard>

export interface PartyRoute { label: string; provider: string; model: string }

export interface OrchestratorDependencies {
  config: OrchestratorConfig
  /** A handle that writes as the orchestrator's profile. */
  board: Board
  relay: RelayClient
  github: GitHubClient
  git: GitRepositories
  state: StateStore
  journal: Journal
  /** The party's sprite routes, in order. */
  routes: () => PartyRoute[]
  /** A launch provider for one attempt's prompt, started in the attempt's launch directory. */
  provider: (prompt: string, directory: string) => Provider
  /** Spend ledger writer; without it, usage is not recorded. */
  usage?: UsageLedger | null
  /** Receives the events of the operations view; without it, none are kept. */
  monitor?: OperationsMonitor | null
  /** Files of the worker client that every launch directory receives. */
  workerFiles?: () => Array<{ path: string; source: string }>
  policy?: NextStepPolicy
  now?: () => number
  log?: (entry: Record<string, unknown>) => void
}

const PROGRESS_REPLY_MS = 10 * 60_000
const MAX_FAULTS = 3
/** At most 64 bundle parts (about 2.3 MiB of bundle) for one round. */
const MAX_BUNDLE_PARTS = 64
const PRIORITY: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3, lowest: 4 }

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
/** Worker text is untrusted: no mentions, no control characters, bounded. */
const workerText = (text: string, max = 3_000) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/@/g, '@\u200b').slice(0, max)

type Resolved = Required<OrchestratorDependencies>

export class Orchestrator {
  readonly #d: Resolved
  /** In memory: the last lease renewal of each live attempt. */
  readonly #leaseRenewedAt = new Map<string, number>()
  readonly #subscriptions = new Map<string, Subscription>()
  readonly #faults = new Map<string, number>()
  readonly #lastProgressReply = new Map<string, number>()
  readonly #skipped = new Set<string>()
  #chain: Promise<void> = Promise.resolve()
  #wakeQueued = false
  #timer: NodeJS.Timeout | undefined
  #sweep: NodeJS.Timeout | undefined
  #events: AbortController | undefined
  #actor = ''
  #stopped = false
  readonly #wakeSources = new Set<WakeSource>()
  #statistics: NodeJS.Timeout | undefined

  constructor(dependencies: OrchestratorDependencies) {
    const log = (entry: Record<string, unknown>): void => {
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    }
    this.#d = { policy: fixedRulesPolicy, now: Date.now, log, workerFiles: () => workerFiles(), usage: null, monitor: null, ...dependencies }
  }

  /** Recovers live attempts, then follows board events and starts the sweep. */
  async start(): Promise<void> {
    this.#actor = (await this.#d.board.me()).actor
    await this.#serial(() => this.#recover())
    this.#events = new AbortController()
    void this.#followEvents(this.#events.signal)
    this.#sweep = setInterval(() => this.wake('sweep'), this.#d.config.sweepSeconds * 1000)
    if (this.#d.monitor) {
      void this.#readRelayStatistics()
      this.#statistics = setInterval(() => void this.#readRelayStatistics(), this.#d.config.operations.relayStatisticsSeconds * 1000)
      this.#statistics.unref?.()
    }
    this.wake('start')
  }

  /** The operations view's snapshot. */
  operations(): OperationsSnapshot | null {
    return this.#d.monitor?.snapshot({
      actor: this.#actor, live: this.#d.state.live(), liveLimit: this.#d.config.admission.liveAttempts,
      outbox: this.#d.state.pending().length, sweepSeconds: this.#d.config.sweepSeconds,
      watchdogDue: (attempt) => this.#watchdogDue(attempt),
    }) ?? null
  }

  #emit(body: OperationsEventBody): void {
    this.#d.monitor?.record(body)
  }

  async #readRelayStatistics(): Promise<void> {
    const monitor = this.#d.monitor
    if (!monitor || this.#stopped) return
    const was = monitor.relayView.reachable
    try {
      const { statistics, latencyMs } = await this.#d.relay.statistics()
      monitor.relay({ reachable: true, latency_ms: latencyMs, error: null, statistics })
    } catch (error) {
      const code = errorCode(error)
      monitor.relay({ reachable: false, latency_ms: null, error: code })
      if (was !== false) this.#emit({ kind: 'fault', component: 'relay', code })
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#events?.abort()
    clearInterval(this.#sweep)
    clearInterval(this.#statistics)
    clearTimeout(this.#timer)
    for (const subscription of this.#subscriptions.values()) subscription.close()
    this.#subscriptions.clear()
    await this.#chain
  }

  /** Requests one tick; several requests before it runs collapse into one. */
  wake(source: WakeSource = 'request'): void {
    if (this.#stopped) return
    this.#wakeSources.add(source)
    if (this.#wakeQueued) return
    this.#wakeQueued = true
    void this.#serial(async () => {
      this.#wakeQueued = false
      const sources = [...this.#wakeSources]
      this.#wakeSources.clear()
      await this.#tick(sources)
    })
  }

  /** Runs one tick and waits for it; for tests and the status command. */
  async tick(): Promise<void> {
    await this.#serial(() => this.#tick(['request']))
  }

  #serial(fn: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(fn).catch((error: unknown) => {
      this.#d.log({ event: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    this.#chain = next
    return next
  }

  async #followEvents(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const _ of this.#d.board.events({ last: 1 }, { signal })) this.wake('board')
      } catch {
        if (signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
  }

  // --- one tick -------------------------------------------------------------

  async #tick(sources: WakeSource[]): Promise<void> {
    const now = this.#d.now()
    const started = performance.now()
    let status: Awaited<ReturnType<Board['status']>>
    try {
      status = await this.#d.board.status()
      this.#d.monitor?.board({ reachable: true, paused: status.paused, pause_epoch: status.pauseEpoch, error: null })
    } catch (error) {
      this.#d.monitor?.board({ reachable: false, error: errorCode(error) })
      this.#emit({ kind: 'fault', component: 'board', code: errorCode(error) })
      throw error
    }
    try {
      await this.#tickWork(status, now)
    } finally {
      this.#emit({ kind: 'tick', sources, live: this.#d.state.live().length, duration_ms: Math.round(performance.now() - started) })
    }
  }

  async #tickWork(status: Awaited<ReturnType<Board['status']>>, now: number): Promise<void> {
    await this.#flushOutbox()
    for (const attempt of this.#d.state.live()) {
      if (status.paused && attempt.state !== 'stopping') await this.#stopAttempt(attempt, 'the board is paused')
      await this.#maintain(attempt, now)
    }
    if (!status.paused) await this.#admit(now, status.pauseEpoch)
    this.#scheduleTimer()
  }

  async #flushOutbox(): Promise<void> {
    for (const command of this.#d.state.pending()) {
      try {
        const body = JSON.parse(command.body) as { type?: unknown; task?: unknown }
        await this.#d.relay.post(command.channel, body)
        this.#d.state.sent(command.id)
        this.#emit({ kind: 'command', channel: command.channel, task: String(body.task ?? ''), type: String(body.type ?? ''), bytes: command.body.length, outcome: 'sent' })
      } catch (error) {
        this.#d.log({ event: 'relay_post_failed', channel: command.channel, message: (error as Error).message })
        this.#emit({ kind: 'fault', component: 'relay', code: errorCode(error), channel: command.channel })
        return
      }
    }
  }

  #queue(attempt: AttemptRecord, command: Command): void {
    this.#d.state.queue({ id: command.id, channel: attempt.channel, body: JSON.stringify(command) }, this.#d.now())
  }

  async #send(attempt: AttemptRecord, command: Command): Promise<void> {
    this.#queue(attempt, command)
    await this.#flushOutbox()
  }

  #held(attempt: AttemptRecord) {
    return this.#d.board.tasks.held(attempt.taskId, { epoch: attempt.claimEpoch, token: attempt.claimToken })
  }

  async #reply(taskId: string, text: string): Promise<void> {
    try {
      await this.#d.board.reply(taskId, text)
      this.#emit({ kind: 'board', action: 'reply', task: taskId })
    } catch (error) {
      this.#d.log({ event: 'board_reply_failed', task: taskId, message: (error as Error).message })
      this.#emit({ kind: 'fault', component: 'board', code: errorCode(error), task: taskId })
    }
  }

  #transition(attempt: AttemptRecord, change: Partial<AttemptRecord>, reason?: string): void {
    this.#d.state.update(attempt.attemptId, change)
    Object.assign(attempt, change)
    if (change.state) {
      this.#d.log({ event: 'attempt_state', attempt: attempt.attemptId, task: attempt.taskId, channel: attempt.channel, state: change.state, reason })
      this.#emit({ kind: 'attempt', attempt: attempt.attemptId, task: attempt.taskId, channel: attempt.channel, state: change.state })
      if (change.state === 'settled') this.#d.monitor?.settled(attempt)
    }
  }

  /** The board call of a held claim, recorded for the operations view. */
  async #settle(attempt: AttemptRecord, action: 'complete' | 'fail' | 'release' | 'block', call: () => Promise<unknown>): Promise<void> {
    await call()
    this.#emit({ kind: 'board', action, task: attempt.taskId, channel: attempt.channel })
  }

  // --- live attempts: lease, token, watchdog --------------------------------

  #leaseDue(attempt: AttemptRecord): number {
    const renewed = this.#leaseRenewedAt.get(attempt.attemptId) ?? attempt.createdAt
    return renewed + (this.#d.config.board.leaseSeconds * 1000) / 3
  }

  #tokenDue(attempt: AttemptRecord): number {
    return (attempt.workerTokenExp - this.#d.config.tokens.workerTtlSeconds / 2) * 1000
  }

  #watchdogDue(attempt: AttemptRecord): number | null {
    const w = this.#d.config.watchdog
    const wall = attempt.createdAt + this.#d.config.limits.attemptWallMinutes * 60_000
    switch (attempt.state) {
      case 'awaiting_contact': return Math.min((attempt.launchedAt ?? attempt.createdAt) + w.contactTimeoutSeconds * 1000, wall)
      case 'running': return Math.min((attempt.lastContactAt ?? attempt.createdAt) + w.heartbeatSeconds * w.missedHeartbeats * 1000, wall)
      case 'waiting_answer': return Math.min((attempt.questionAt ?? attempt.createdAt) + w.questionWaitSeconds * 1000, wall)
      case 'stopping': return (attempt.stopSentAt ?? attempt.createdAt) + w.stopGraceSeconds * 1000
      default: return null
    }
  }

  async #maintain(attempt: AttemptRecord, now: number): Promise<void> {
    if (now >= this.#leaseDue(attempt)) {
      try {
        await this.#held(attempt).renew(this.#d.config.board.leaseSeconds)
        this.#leaseRenewedAt.set(attempt.attemptId, now)
        this.#emit({ kind: 'board', action: 'renew', task: attempt.taskId, channel: attempt.channel })
      } catch (error) {
        if (error instanceof BoardError && (error.code === 'claim_lost' || error.status === 409)) {
          await this.#stopAttempt(attempt, 'the board claim was lost')
          this.#transition(attempt, { state: 'settled', outcome: 'claim_lost' }, 'claim lost')
          this.#unsubscribe(attempt)
          return
        }
        this.#d.log({ event: 'lease_renew_failed', task: attempt.taskId, message: (error as Error).message })
      }
    }
    if (['awaiting_contact', 'running', 'waiting_answer', 'deciding', 'stopping'].includes(attempt.state) && now >= this.#tokenDue(attempt)) {
      const { token, exp } = this.#d.relay.token(attempt.channel, 'worker', this.#d.config.tokens.workerTtlSeconds)
      await this.#send(attempt, envelope('renew', attempt.taskId, attempt.channel, { token, exp }, now))
      this.#transition(attempt, { workerTokenExp: exp })
    }
    if (attempt.state === 'waiting_answer') await this.#checkAnswer(attempt)
    const due = this.#watchdogDue(attempt)
    if (due !== null && now >= due) {
      if (attempt.state === 'stopping') await this.#lost(attempt, 'no result after the stop command')
      else await this.#stopAttempt(attempt, attempt.state === 'awaiting_contact' ? 'the worker never made contact' : attempt.state === 'waiting_answer' ? 'no answer to the worker question in time' : 'the worker went silent or ran out of time')
    }
  }

  #scheduleTimer(): void {
    clearTimeout(this.#timer)
    if (this.#stopped) return
    let next = Infinity
    for (const attempt of this.#d.state.live()) {
      next = Math.min(next, this.#leaseDue(attempt), this.#tokenDue(attempt), this.#watchdogDue(attempt) ?? Infinity)
      if (attempt.state === 'waiting_answer') next = Math.min(next, this.#d.now() + 30_000)
    }
    if (next === Infinity) return
    this.#timer = setTimeout(() => this.wake('timer'), Math.max(next - this.#d.now(), 100))
    this.#timer.unref?.()
  }

  async #stopAttempt(attempt: AttemptRecord, reason: string): Promise<void> {
    if (attempt.state === 'stopping') return
    await this.#send(attempt, envelope('stop', attempt.taskId, attempt.channel, { reason, send_bundle: true }, this.#d.now()))
    this.#transition(attempt, { state: 'stopping', stopSentAt: this.#d.now() }, reason)
  }

  async #lost(attempt: AttemptRecord, reason: string): Promise<void> {
    const retry = attempt.attemptNo < this.#d.config.limits.attemptsPerTask
    try {
      if (retry) await this.#settle(attempt, 'release', () => this.#held(attempt).release())
      else await this.#settle(attempt, 'fail', () => this.#held(attempt).fail(`Attempt ${attempt.attemptNo} lost: ${reason}`))
    } catch (error) {
      this.#d.log({ event: 'settle_failed', task: attempt.taskId, message: (error as Error).message })
    }
    await this.#reply(attempt.taskId, `Orchestrator: attempt ${attempt.attemptNo} lost (${reason}). ${retry ? 'The task is ready for a new attempt.' : 'No attempts remain; the task failed.'}`)
    this.#transition(attempt, { state: 'settled', outcome: 'lost' }, reason)
    this.#unsubscribe(attempt)
  }

  #unsubscribe(attempt: AttemptRecord): void {
    this.#subscriptions.get(attempt.channel)?.close()
    this.#subscriptions.delete(attempt.channel)
    this.#leaseRenewedAt.delete(attempt.attemptId)
    rmSync(this.#bundleDirectory(attempt), { recursive: true, force: true })
  }

  // --- admission and start --------------------------------------------------

  async #admit(now: number, pauseEpoch: number): Promise<void> {
    const { admission } = this.#d.config
    let live = this.#d.state.live()
    if (live.length >= admission.liveAttempts) return
    const page = await this.#d.board.tasks.list({ state: 'ready' })
    const candidates = page.tasks
      .map((summary) => summary.message)
      .filter((message) => !live.some((attempt) => attempt.taskId === message.id))
      .sort((a, b) => (PRIORITY[a.task?.priority ?? 'normal']! - PRIORITY[b.task?.priority ?? 'normal']!) || Number(a.id) - Number(b.id))
    for (const message of candidates) {
      if (live.length >= admission.liveAttempts) return
      if (live.filter((attempt) => attempt.boardChannel === message.channel).length >= admission.perChannel) continue
      const plan = await this.#plan(message)
      if (!plan) continue
      if (live.filter((attempt) => attempt.repository === plan.repository).length >= admission.perRepository) continue
      await this.#startAttempt(message, plan, now, pauseEpoch)
      live = this.#d.state.live()
    }
  }

  async #skip(message: MessageView, reason: string): Promise<null> {
    const key = `${message.id}:${reason}`
    if (!this.#skipped.has(key)) {
      this.#skipped.add(key)
      await this.#reply(message.id, `Orchestrator: not started. ${reason}`)
    }
    return null
  }

  async #plan(message: MessageView): Promise<{ repository: string; url: string; routes: PartyRoute[] } | null> {
    const page = await this.#d.board.channels({ prefix: message.channel, limit: 100 })
    const settings = page.channels.find((channel) => channel.path === message.channel)?.settings ?? null
    if (!settings?.repository) return this.#skip(message, `Channel #${message.channel} links no repository.`)
    const repository = repositoryName(settings.repository)
    if (!repository) return this.#skip(message, `The repository of #${message.channel} is not a github.com repository.`)
    if (!repositoryAllowed(this.#d.config, repository)) return this.#skip(message, `Repository ${repository} is denied.`)
    const party = this.#d.routes()
    const byKey = new Map(party.map((route) => [`${route.provider}/${route.model}`, route]))
    const routes = settings.routes.length === 0
      ? party
      : settings.routes.filter((route) => route.enabled && byKey.has(route.key)).map((route) => byKey.get(route.key)!)
    if (routes.length === 0) return this.#skip(message, `Channel #${message.channel} enables no model route of the party.`)
    const attempts = this.#d.state.forTask(message.id).length
    if (attempts >= this.#d.config.limits.attemptsPerTask) return this.#skip(message, `All ${attempts} attempts are used.`)
    return { repository, url: settings.repository, routes }
  }

  async #startAttempt(message: MessageView, plan: { repository: string; url: string; routes: PartyRoute[] }, now: number, pauseEpoch: number): Promise<void> {
    const { config } = this.#d
    let baseRef: string
    let baseCommit: string | null
    try {
      baseRef = await this.#d.github.defaultBranch(plan.repository)
      baseCommit = await this.#d.github.branchHead(plan.repository, baseRef)
    } catch (error) {
      this.#d.log({ event: 'github_read_failed', task: message.id, message: (error as Error).message })
      this.#emit({ kind: 'fault', component: 'github', code: errorCode(error), task: message.id })
      return
    }
    if (!baseCommit) return
    let claim: Awaited<ReturnType<Board['tasks']['claim']>>
    try {
      claim = await this.#d.board.tasks.claim(message.id, { lease: config.board.leaseSeconds })
    } catch (error) {
      if (error instanceof BoardError && error.status === 409) return
      throw error
    }
    if (!claim) return
    const attemptNo = this.#d.state.forTask(message.id).length + 1
    const channel = `task-${message.id}-a${attemptNo}-${randomBytes(4).toString('hex')}`
    const branch = `claude/task-${message.id}`
    const worker = this.#d.relay.token(channel, 'worker', config.tokens.workerTtlSeconds)
    const attempt: AttemptRecord = {
      attemptId: randomUUID(), taskId: message.id, attemptNo, channel, boardChannel: message.channel, repository: plan.repository,
      branch, baseCommit, state: 'claimed', round: 1, claimEpoch: claim.epoch, claimToken: claim.token, session: null,
      createdAt: now, launchedAt: null, lastContactAt: null, workerTokenExp: worker.exp, stopSentAt: null,
      telemetrySeq: 0, costUsd: 0, questionId: null, questionAt: null, outcome: null, prUrl: null,
    }
    this.#d.state.insert(attempt)
    this.#leaseRenewedAt.set(attempt.attemptId, now)
    this.#emit({ kind: 'attempt', attempt: attempt.attemptId, task: attempt.taskId, channel, state: 'claimed' })
    this.#emit({ kind: 'board', action: 'claim', task: attempt.taskId, channel })
    this.#d.log({ event: 'attempt_state', attempt: attempt.attemptId, task: attempt.taskId, channel, state: 'claimed' })

    const brief = message.text
    const start: StartData = {
      task_id: message.id, attempt: attemptNo, round: 1,
      title: brief.split('\n').find((line) => line.trim())?.trim().slice(0, 120) ?? `Task ${message.id}`,
      brief, brief_sha256: sha256(brief),
      repository: { url: plan.url, base_ref: baseRef, base_commit: baseCommit },
      branch,
      limits: { max_seconds: config.worker.maxSeconds, idle_seconds: config.worker.idleSeconds, question_wait_seconds: config.watchdog.questionWaitSeconds },
      model: { pi_model: config.worker.piModel, fallback_tiers: plan.routes },
      checks: config.worker.checks.map((check) => ({ name: check.name, command: check.command, timeout_seconds: check.timeoutSeconds })),
      telemetry: { heartbeat_seconds: config.watchdog.heartbeatSeconds, progress_mode: config.worker.progressMode },
    }
    const startCommand = envelope('start', message.id, channel, start, now)
    if (JSON.stringify(startCommand).length > 60 * 1024) {
      await this.#held(attempt).block('The brief is too large for one start command (60 KiB).', { kind: 'needs_input' })
      this.#transition(attempt, { state: 'settled', outcome: 'brief_too_large' })
      return
    }
    // The relay buffers the start command, so the worker finds it whenever it connects.
    await this.#send(attempt, startCommand)

    const key = launchKey({ repo: plan.repository, account: config.boardProfile, workId: message.id, round: attemptNo, attemptId: attempt.attemptId })
    const binding: Binding = {
      kind: 'implement', envelopeRef: channel, repo: plan.repository, account: config.boardProfile, briefRef: `task-${message.id}`,
      briefDigest: sha256(brief), generation: attemptNo, epoch: pauseEpoch, requestDigest: sha256(JSON.stringify(startCommand)), createdAt: now,
    }
    const prompt = workerPrompt({
      taskId: message.id, attemptNo, journalKey: key, relayUrl: config.relay.url, channel, token: worker.token, tokenExp: worker.exp,
      protocolPath: config.worker.protocolPath, contactTimeoutSeconds: config.watchdog.contactTimeoutSeconds,
    })
    this.#transition(attempt, { state: 'launching' })
    const launchDirectory = join(config.stateDirectory, 'launch', attempt.attemptId)
    try {
      await this.#d.git.prepareLaunchDirectory(plan.repository, baseCommit, launchDirectory, this.#d.workerFiles())
    } catch (error) {
      await this.#held(attempt).release().catch(() => undefined)
      await this.#reply(message.id, `Orchestrator: attempt ${attemptNo} not started. The launch directory failed: ${(error as Error).message}`)
      this.#transition(attempt, { state: 'settled', outcome: 'launch_preparation_failed' }, (error as Error).message)
      return
    }
    const result = await launch({ journal: this.#d.journal, provider: this.#d.provider(prompt, launchDirectory), control: this.#control(), key, binding })
      .finally(() => rmSync(launchDirectory, { recursive: true, force: true }))
    this.#emit({ kind: 'launch', task: attempt.taskId, channel, outcome: 'ok' in result ? 'journal_unreadable' : result.status })
    if ('ok' in result) {
      await this.#markUncertain(attempt, `launch journal unreadable (${result.reason})`)
      return
    }
    if (result.status === 'launched' || result.status === 'adopted' || result.status === 'reattached') {
      this.#transition(attempt, { state: 'awaiting_contact', session: result.session ?? null, launchedAt: this.#d.now() })
      await this.#reply(message.id, `Orchestrator: attempt ${attemptNo} started. Session ${result.session}, branch ${branch} in ${plan.repository}, routes ${plan.routes.map((route) => route.label).join(', ')}.`)
      this.#subscribe(attempt)
      return
    }
    if (result.status === 'uncertain') return this.#markUncertain(attempt, `launch result unknown (${result.reason ?? 'no session id'})`)
    // Refused (board paused) or abandoned: give the task back.
    await this.#held(attempt).release().catch(() => undefined)
    this.#transition(attempt, { state: 'settled', outcome: `launch_${result.status}` }, result.reason)
  }

  #control() {
    return {
      epoch: async (): Promise<number | 'unknown'> => {
        const status = await this.#d.board.status()
        return status.paused ? 'unknown' : status.pauseEpoch
      },
    }
  }

  async #markUncertain(attempt: AttemptRecord, reason: string): Promise<void> {
    this.#transition(attempt, { state: 'uncertain', outcome: reason }, reason)
    await this.#settle(attempt, 'block', () => this.#held(attempt).block(`Orchestrator: ${reason}. Check the cloud sessions before the task is started again; it is never relaunched automatically.`, { kind: 'needs_input' })).catch(() => undefined)
  }

  // --- telemetry ------------------------------------------------------------

  #subscribe(attempt: AttemptRecord): void {
    if (this.#subscriptions.has(attempt.channel)) return
    const subscription = this.#d.relay.subscribe(attempt.channel, attempt.telemetrySeq, async (event) => {
      await this.#serial(() => this.#onTelemetry(attempt.attemptId, event.seq, event.body))
    }, (status) => {
      this.#d.log({ event: 'telemetry_refused', channel: attempt.channel, status })
      this.#emit({ kind: 'fault', component: 'relay', code: `status_${status}`, task: attempt.taskId, channel: attempt.channel })
    })
    this.#subscriptions.set(attempt.channel, subscription)
  }

  async #onTelemetry(attemptId: string, seq: number, body: unknown): Promise<void> {
    const attempt = this.#d.state.get(attemptId)
    if (!attempt || !LIVE_STATES.includes(attempt.state) || seq <= attempt.telemetrySeq) return
    const parsed = parseTelemetry(body)
    const valid = parsed.ok && parsed.message.task === attempt.taskId && parsed.message.channel === attempt.channel
    const fresh = valid && this.#d.state.markSeen(attempt.channel, parsed.message.id)
    this.#transition(attempt, { telemetrySeq: seq })
    if (!valid) {
      const faults = (this.#faults.get(attemptId) ?? 0) + 1
      this.#faults.set(attemptId, faults)
      this.#d.log({ event: 'protocol_fault', channel: attempt.channel, error: parsed.ok ? 'wrong task or channel' : parsed.error })
      this.#emit({ kind: 'fault', component: 'worker', code: 'protocol_fault', task: attempt.taskId, channel: attempt.channel })
      if (faults >= MAX_FAULTS) await this.#stopAttempt(attempt, 'too many invalid telemetry messages')
      return
    }
    if (!fresh) return
    const message = parsed.message
    const now = this.#d.now()
    this.#emit({ kind: 'telemetry', channel: attempt.channel, task: attempt.taskId, type: message.type, bytes: JSON.stringify(body).length, relay_seq: seq })
    this.#transition(attempt, { lastContactAt: now, ...(attempt.state === 'awaiting_contact' ? { state: 'running' } : {}) })
    switch (message.type) {
      case 'heartbeat': {
        const { state, round, elapsed_seconds, pi_alive } = message.data
        this.#d.monitor?.heartbeat(attempt.attemptId, { state, round, elapsed_seconds, pi_alive })
        return
      }
      case 'progress': return this.#onProgress(attempt, message, now)
      case 'question': return this.#onQuestion(attempt, message, now)
      case 'bundle_part': return this.#onBundlePart(attempt, message.data)
      case 'result': return this.#onResult(attempt, message.data)
    }
  }

  async #onProgress(attempt: AttemptRecord, message: Extract<Telemetry, { type: 'progress' }>, now: number): Promise<void> {
    this.#d.monitor?.progress(attempt.attemptId, message.data.items.map((item) => item.kind))
    const last = this.#lastProgressReply.get(attempt.attemptId) ?? 0
    if (now - last < PROGRESS_REPLY_MS || message.data.items.length === 0) return
    this.#lastProgressReply.set(attempt.attemptId, now)
    const lines = message.data.items.slice(-5).map((item) => `- ${item.kind}: ${workerText(item.text, 300)}`)
    await this.#reply(attempt.taskId, `Worker report (round ${message.data.round}):\n${lines.join('\n')}`)
  }

  async #onQuestion(attempt: AttemptRecord, message: Extract<Telemetry, { type: 'question' }>, now: number): Promise<void> {
    if (attempt.state === 'stopping') return
    const options = message.data.options?.length ? `\nOptions: ${message.data.options.map((option) => workerText(option, 200)).join(' | ')}` : ''
    await this.#reply(attempt.taskId, `Worker question ${message.data.question_id}: ${workerText(message.data.text)}${options}\nReply in this thread; the first reply from a person is sent to the worker as the answer.`)
    this.#transition(attempt, { state: 'waiting_answer', questionId: message.data.question_id, questionAt: now })
  }

  async #checkAnswer(attempt: AttemptRecord): Promise<void> {
    if (!attempt.questionId || attempt.questionAt === null) return
    const thread = await this.#d.board.thread(attempt.taskId)
    const answer = thread.replies.find((reply) =>
      reply.by.actor !== this.#actor && reply.by.principal !== this.#actor && Date.parse(reply.createdAt) > attempt.questionAt!)
    if (!answer) return
    await this.#send(attempt, envelope('answer', attempt.taskId, attempt.channel, { question_id: attempt.questionId, text: answer.text.slice(0, 8_000) }, this.#d.now()))
    this.#transition(attempt, { state: 'running', questionId: null, questionAt: null, lastContactAt: this.#d.now() })
  }

  #bundleDirectory(attempt: AttemptRecord, round?: number): string {
    const directory = join(this.#d.config.stateDirectory, 'bundles', attempt.attemptId)
    return round === undefined ? directory : join(directory, `round_${round}`)
  }

  /** Stores one bundle part on disk, so parts survive a restart of the orchestrator. */
  async #onBundlePart(attempt: AttemptRecord, part: BundlePartData): Promise<void> {
    if (part.count > MAX_BUNDLE_PARTS || part.index >= part.count) {
      this.#d.log({ event: 'protocol_fault', channel: attempt.channel, error: `bundle part ${part.index}/${part.count} refused` })
      return
    }
    const directory = this.#bundleDirectory(attempt, part.round)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, `part_${part.index}`), part.data, { mode: 0o600 })
  }

  /** Joins the round's parts into one bundle file; null when a part is missing or the digest differs. */
  #assembleBundle(attempt: AttemptRecord, result: ResultData): string | null {
    if (!result.bundle) return null
    const directory = this.#bundleDirectory(attempt, result.round)
    try {
      const parts: Buffer[] = []
      for (let index = 0; index < result.bundle.parts; index++) parts.push(Buffer.from(readFileSync(join(directory, `part_${index}`), 'utf8'), 'base64'))
      const bundle = Buffer.concat(parts)
      if (bundle.length !== result.bundle.bytes || createHash('sha256').update(bundle).digest('hex') !== result.bundle.sha256) return null
      const file = join(directory, 'commits.bundle')
      writeFileSync(file, bundle, { mode: 0o600 })
      return file
    } catch {
      return null
    }
  }

  async #onResult(attempt: AttemptRecord, result: ResultData): Promise<void> {
    const wasStopping = attempt.state === 'stopping'
    this.#transition(attempt, { state: 'deciding', costUsd: attempt.costUsd + result.cost_usd })
    try {
      this.#d.usage?.recordRound(attempt, result, this.#d.now())
    } catch (error) {
      this.#d.log({ event: 'ledger_write_failed', task: attempt.taskId, message: (error as Error).message })
      this.#emit({ kind: 'fault', component: 'ledger', code: errorCode(error), task: attempt.taskId, channel: attempt.channel })
    }
    this.#emit({
      kind: 'usage', task: attempt.taskId, channel: attempt.channel, round: result.round, models: result.models.length,
      input_tokens: result.models.reduce((sum, row) => sum + row.input_tokens, 0),
      output_tokens: result.models.reduce((sum, row) => sum + row.output_tokens, 0),
      cost_usd: result.cost_usd,
    })
    await this.#reply(attempt.taskId, `Worker report (round ${result.round}, ${result.exit_reason}): ${workerText(result.summary, 1_500)}\nFiles ${result.diff_stat.files}, +${result.diff_stat.insertions} -${result.diff_stat.deletions}. Checks: ${result.checks.map((check) => `${check.name} ${check.exit_code === 0 ? 'pass' : 'fail'}`).join(', ') || 'none'}.`)
    const bundleFile = this.#assembleBundle(attempt, result)
    const task = await this.#d.board.thread(attempt.taskId).then((thread) => thread.message).catch(() => null)
    const input = {
      task: { id: attempt.taskId, brief: task?.text ?? '', channel: attempt.boardChannel },
      attempt: { no: attempt.attemptNo, round: attempt.round, costUsd: attempt.costUsd, wallMs: this.#d.now() - attempt.createdAt },
      result, bundleReceived: bundleFile !== null,
    }
    const taskCost = this.#d.state.forTask(attempt.taskId).reduce((sum, row) => sum + row.costUsd, 0)
    let step: NextStep = await this.#d.policy.decide(input).catch((error: unknown) => ({ kind: 'hold', question: `The next-step policy failed: ${(error as Error).message}` }) as NextStep)
    step = limitStep(step, input, {
      roundsPerAttempt: this.#d.config.limits.roundsPerAttempt, attemptsPerTask: this.#d.config.limits.attemptsPerTask,
      attemptWallMs: this.#d.config.limits.attemptWallMinutes * 60_000, taskBudgetUsd: this.#d.config.limits.taskBudgetUsd, taskCostUsd: taskCost,
    })
    if (wasStopping && step.kind === 'instruct') step = { kind: 'retry', reason: 'the attempt was stopping' }
    this.#d.log({ event: 'decision', task: attempt.taskId, attempt: attempt.attemptId, step: step.kind })
    await this.#apply(attempt, step, result, bundleFile)
  }

  async #apply(attempt: AttemptRecord, step: NextStep, result: ResultData, bundleFile: string | null = null): Promise<void> {
    const now = this.#d.now()
    switch (step.kind) {
      case 'instruct': {
        const round = attempt.round + 1
        await this.#send(attempt, envelope('instruct', attempt.taskId, attempt.channel, { round, text: step.text, mode: 'next_round' as const }, now))
        this.#transition(attempt, { state: 'running', round, lastContactAt: now })
        await this.#reply(attempt.taskId, `Orchestrator: round ${round} sent to the worker.`)
        return
      }
      case 'publish': return this.#publish(attempt, result, bundleFile)
      case 'retry': {
        await this.#finishWorker(attempt, step.reason)
        await this.#lostOrRetry(attempt, step.reason)
        return
      }
      case 'fail': {
        await this.#finishWorker(attempt, step.reason)
        await this.#settle(attempt, 'fail', () => this.#held(attempt).fail(step.reason)).catch(() => undefined)
        await this.#reply(attempt.taskId, `Orchestrator: task failed. ${step.reason}`)
        this.#transition(attempt, { state: 'settled', outcome: 'failed' }, step.reason)
        this.#unsubscribe(attempt)
        return
      }
      case 'hold': {
        await this.#finishWorker(attempt, 'held for a person')
        await this.#settle(attempt, 'block', () => this.#held(attempt).block(`Orchestrator: ${step.question}`, { kind: 'needs_input' })).catch(() => undefined)
        this.#transition(attempt, { state: 'settled', outcome: 'held' }, step.question)
        this.#unsubscribe(attempt)
      }
    }
  }

  async #finishWorker(attempt: AttemptRecord, reason: string): Promise<void> {
    if (attempt.stopSentAt === null) {
      await this.#send(attempt, envelope('stop', attempt.taskId, attempt.channel, { reason, send_bundle: false }, this.#d.now()))
      this.#transition(attempt, { stopSentAt: this.#d.now() })
    }
  }

  async #lostOrRetry(attempt: AttemptRecord, reason: string): Promise<void> {
    if (attempt.attemptNo < this.#d.config.limits.attemptsPerTask) {
      await this.#settle(attempt, 'release', () => this.#held(attempt).release()).catch(() => undefined)
      await this.#reply(attempt.taskId, `Orchestrator: attempt ${attempt.attemptNo} ends (${reason}). A new attempt will start.`)
      this.#transition(attempt, { state: 'settled', outcome: 'retry' }, reason)
    } else {
      await this.#settle(attempt, 'fail', () => this.#held(attempt).fail(reason)).catch(() => undefined)
      await this.#reply(attempt.taskId, `Orchestrator: task failed. ${reason}`)
      this.#transition(attempt, { state: 'settled', outcome: 'failed' }, reason)
    }
    this.#unsubscribe(attempt)
  }

  /**
   * The last step: push the worker's commits from the bundle, then open the draft PR. The allow list
   * is checked here once more, because this is the only place that writes to GitHub.
   */
  async #publish(attempt: AttemptRecord, result: ResultData, bundleFile: string | null): Promise<void> {
    this.#transition(attempt, { state: 'publishing' })
    const { github } = this.#d
    if (!repositoryAllowed(this.#d.config, attempt.repository)) return this.#apply(attempt, { kind: 'fail', reason: `${attempt.repository} is not allowed` }, result)
    if (!bundleFile || !result.head_commit || !attempt.baseCommit) return this.#apply(attempt, { kind: 'retry', reason: 'no verified bundle to push' }, result)
    try {
      await this.#d.git.publishBundle(attempt.repository, { bundleFile, branch: attempt.branch, head: result.head_commit, base: attempt.baseCommit })
      this.#emit({ kind: 'github', action: 'push', repository: attempt.repository, task: attempt.taskId, channel: attempt.channel })
      let url = attempt.prUrl
      if (!url) {
        const existing = await github.findPullRequest(attempt.repository, attempt.branch)
        if (existing && existing.state === 'closed') {
          return this.#apply(attempt, { kind: 'hold', question: `A closed PR exists for ${attempt.branch}: ${existing.url}. Decide whether to reopen it.` }, result)
        }
        url = existing?.url ?? await github.openDraftPullRequest(attempt.repository, {
          branch: attempt.branch,
          base: await github.defaultBranch(attempt.repository),
          title: `Task ${attempt.taskId}: ${result.summary.split('\n')[0]?.slice(0, 80) ?? 'worker change'}`,
          body: `Board task #${attempt.taskId}, attempt ${attempt.attemptNo}, round ${result.round}.\n\nWorker report (untrusted text):\n\n${workerText(result.summary, 4_000)}`,
        })
        this.#transition(attempt, { prUrl: url })
        this.#emit({ kind: 'github', action: 'draft_pr', repository: attempt.repository, task: attempt.taskId, channel: attempt.channel })
      }
      await this.#finishWorker(attempt, 'published')
      await this.#settle(attempt, 'complete', () => this.#held(attempt).complete(url))
      await this.#reply(attempt.taskId, `Orchestrator: draft PR ${url}`)
      this.#transition(attempt, { state: 'settled', outcome: 'published' })
      this.#unsubscribe(attempt)
    } catch (error) {
      this.#d.log({ event: 'publish_failed', task: attempt.taskId, message: (error as Error).message })
      this.#emit({ kind: 'fault', component: 'github', code: errorCode(error), task: attempt.taskId, channel: attempt.channel })
      this.#transition(attempt, { state: 'deciding' })
      await this.#apply(attempt, { kind: 'hold', question: `Publishing failed: ${(error as Error).message}` }, result)
    }
  }

  // --- restart --------------------------------------------------------------

  async #recover(): Promise<void> {
    const journal = await recover({ journal: this.#d.journal, provider: { send: async () => { throw new Error('no send on recovery') }, probe: async () => ({ kind: 'unknown' }) }, control: this.#control() })
    const sessions = new Map<string, string>()
    if (!('ok' in journal)) for (const row of journal) if (row.session) sessions.set(row.key, row.session)
    for (const attempt of this.#d.state.live()) {
      if (attempt.state === 'claimed' || attempt.state === 'launching') {
        await this.#markUncertain(attempt, 'the orchestrator stopped during the launch')
        continue
      }
      try {
        await this.#held(attempt).renew(this.#d.config.board.leaseSeconds)
        this.#leaseRenewedAt.set(attempt.attemptId, this.#d.now())
      } catch {
        await this.#stopAttempt(attempt, 'the orchestrator lost the board claim during a restart')
        this.#transition(attempt, { state: 'settled', outcome: 'claim_lost' })
        continue
      }
      this.#subscribe(attempt)
    }
  }
}

