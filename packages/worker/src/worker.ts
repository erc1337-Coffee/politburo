// The worker of one task attempt. It connects to the relay first, then sets up Pi, and
// acknowledges each step (start, setup, work of each round). It reads commands from the relay,
// runs Pi round by round in the task worktree, sends heartbeats, progress, questions, the commits
// as a git bundle and one result per round, and stops safely on a stop command, lost contact or
// token expiry.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  BUNDLE_PART_MAX, envelope, parseCommand,
  type Command, type ExitReason, type PhaseData, type ResultData, type StartData, type Telemetry, type WorkerState,
} from '../../relay/src/messages.ts'
import { open, workerKeyPair } from '../../relay/src/sealed.ts'
import { commitAll, createBundle, diffStat, head, prepareWorktree } from './git.ts'
import { PiRound, type ModelUsage, type PiRoundResult, type ProgressItem } from './pi.ts'
import type { PiSetup } from './setup.ts'
import type { WorkerFiles } from './state.ts'
import { CommandStream, TelemetrySender, tokenExpiry } from './transport.ts'

export const EXIT = { finished: 0, usage: 2, configuration: 3, lostContact: 4, internal: 5 } as const

export interface WorkerOptions {
  relayUrl: string
  channel: string
  files: WorkerFiles
  /** The uploaded repository checkout; it holds the base commit. */
  checkout: string
  /** Stop when the relay is unreachable this long. */
  contactTimeoutSeconds: number
  /** Pi extension files loaded in every round; `prepare` replaces them with its own. */
  extensions?: string[]
  piCommand?: string
  /** Sets up Pi after the relay connection starts; the first round waits for it. */
  prepare?: (log: (line: string) => void) => Promise<PiSetup>
  thinking?: string
  now?: () => number
  log?: (line: string) => void
}

const MAX_BUNDLE_PARTS = 64
const PROGRESS_INTERVAL_MS = 10_000
const TOKEN_MARGIN_SECONDS = 120
const CREDENTIALS_WAIT_MS = 300_000
/** The cloud session's own Claude Code variables stay out of Pi, so a nested `claude` acts as a plain CLI. */
const piEnvironment = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !/^(CLAUDE_|CLAUDECODE$|CCR_)/.test(name)))
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

interface CheckResult { name: string; exit_code: number | null; duration_seconds: number; output_tail: string }

function runCheck(cwd: string, command: string, timeoutSeconds: number): Promise<CheckResult & { name: '' }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-16_000) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } }, timeoutSeconds * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ name: '', exit_code: code, duration_seconds: (Date.now() - started) / 1000, output_tail: output.slice(-2_000) })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ name: '', exit_code: null, duration_seconds: 0, output_tail: error.message })
    })
  })
}

export class Worker {
  readonly #o: WorkerOptions
  readonly #now: () => number
  readonly #log: (line: string) => void
  readonly #stream: CommandStream
  readonly #sender: TelemetrySender
  #token: string
  #tokenExp: number
  #cursor: { lastSeq: number; processed: string[] }
  #state: WorkerState = 'waiting_start'
  #start: StartData | null = null
  #round = 0
  #pi: PiRound | null = null
  #roundRunning = false
  #nextRound: { round: number; text: string } | null = null
  #lastCommandAt: number
  #lastContactAt: number
  #startedAt: number
  #progress: ProgressItem[] = []
  #questions = new Set<string>()
  #timers: NodeJS.Timeout[] = []
  #finish!: (code: number) => void
  readonly #finished: Promise<number>
  #stopping = false
  readonly #keys = workerKeyPair()
  #credentials: Record<string, string> | null = null
  #credentialsArrived: () => void = () => undefined
  #extensions: string[]
  #piCommand: string | undefined
  #ready: Promise<boolean> = Promise.resolve(true)
  #roundStartedAt = 0
  /** Steering and follow-up messages that arrived while the round was still starting. */
  #waitingMessages: Array<{ id: string; mode: 'steer' | 'follow_up'; text: string }> = []

  constructor(options: WorkerOptions, token: string) {
    this.#o = options
    this.#extensions = options.extensions ?? []
    this.#piCommand = options.piCommand
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? ((line) => process.stderr.write(`politburo-worker: ${line}\n`))
    const saved = options.files.readToken()
    this.#token = saved && tokenExpiry(saved) > tokenExpiry(token) ? saved : token
    this.#tokenExp = tokenExpiry(this.#token)
    options.files.writeToken(this.#token)
    this.#cursor = options.files.readCursor()
    this.#startedAt = this.#lastCommandAt = this.#lastContactAt = this.#now()
    this.#finished = new Promise((resolve) => { this.#finish = resolve })
    const transport = {
      relayUrl: options.relayUrl.replace(/\/+$/, ''), channel: options.channel, files: options.files,
      token: () => this.#token,
      onContact: () => { this.#lastContactAt = this.#now() },
      onRefused: (status: number) => { void this.#safeStop(status === 403 ? 'worker_error' : 'token_expired', `the relay refused the token (${status})`, status === 403 ? EXIT.configuration : EXIT.lostContact) },
      log: (line: string) => this.#log(line),
    }
    this.#stream = new CommandStream(transport, () => this.#cursor.lastSeq, (seq, body) => this.#onCommandEvent(seq, body))
    this.#sender = new TelemetrySender(transport)
    const saved_start = options.files.readJson<{ start: StartData; round: number }>('start.json')
    if (saved_start) {
      this.#start = saved_start.start
      this.#round = saved_start.round
      this.#state = 'running'
    }
  }

  /** Runs until the attempt ends; resolves with the process exit code. */
  async run(): Promise<number> {
    this.#status(`connected to channel ${this.#o.channel}, token valid until ${new Date(this.#tokenExp * 1000).toISOString()}`)
    this.#phase({ phase: 'started', round: this.#round })
    this.#ready = this.#setUp()
    this.#stream.start()
    this.#timers.push(setInterval(() => this.#watch(), 5_000))
    this.#timers.push(setInterval(() => this.#flushProgress(), PROGRESS_INTERVAL_MS))
    this.#scheduleHeartbeat(60)
    const signal = () => void this.#safeStop('stopped', 'the worker process received a stop signal', EXIT.lostContact)
    process.once('SIGTERM', signal)
    process.once('SIGHUP', signal)
    if (this.#start && this.#state === 'running') {
      this.#status(`resuming task ${this.#start.task_id} at round ${this.#round}`)
      void this.#runRound(this.#round, this.#roundPrompt(this.#start, null))
    }
    const code = await this.#finished
    for (const timer of this.#timers) clearInterval(timer)
    process.removeListener('SIGTERM', signal)
    process.removeListener('SIGHUP', signal)
    await this.#stream.close()
    this.#sender.close()
    this.#o.files.writeJson('exit.json', { code, at: this.#now() })
    return code
  }

  // --- telemetry ----------------------------------------------------------------

  #send(type: Telemetry['type'], data: unknown): void {
    this.#sender.send(envelope(type, this.#start?.task_id ?? 'unknown', this.#o.channel, data, this.#now()) as Telemetry)
  }

  #phase(data: PhaseData): void {
    this.#send('phase', data)
    this.#status(`${data.phase.replace('_', ' ')}${data.detail ? `: ${data.detail}` : ''}`)
  }

  /** Runs `prepare` with acknowledgements; false when it failed and the worker stops. */
  async #setUp(): Promise<boolean> {
    const prepare = this.#o.prepare
    if (!prepare) return true
    const before = this.#state
    const began = this.#now()
    const seconds = () => Math.round((this.#now() - began) / 1000)
    this.#state = 'setting_up'
    this.#phase({ phase: 'setup_started', round: this.#round })
    try {
      const setup = await prepare((line) => this.#status(line))
      this.#extensions = setup.extensions
      this.#piCommand = setup.piCommand
      this.#state = this.#state === 'setting_up' ? before : this.#state
      this.#phase({ phase: 'setup_finished', round: this.#round, duration_seconds: seconds(), detail: setup.installed.length ? `installed ${setup.installed.join(', ')}` : 'nothing to install' })
      this.#heartbeat()
      return true
    } catch (error) {
      const detail = clip((error as Error).message, 1_000)
      this.#phase({ phase: 'setup_failed', round: this.#round, duration_seconds: seconds(), detail })
      await this.#safeStop('worker_error', `setup failed: ${detail}`, EXIT.configuration, false)
      return false
    }
  }

  #status(line: string): void {
    this.#o.files.status(line)
    this.#log(line)
  }

  #scheduleHeartbeat(seconds: number): void {
    for (const timer of this.#timers.splice(2)) clearInterval(timer)
    this.#timers.push(setInterval(() => this.#heartbeat(), seconds * 1000))
    this.#heartbeat()
  }

  #heartbeat(): void {
    this.#send('heartbeat', {
      state: this.#state, round: this.#round, last_command_seq: this.#cursor.lastSeq,
      elapsed_seconds: Math.round((this.#now() - this.#startedAt) / 1000), token_exp: this.#tokenExp, pi_alive: this.#pi?.alive ?? false,
      ...(this.#credentials ? {} : { public_key: this.#keys.publicKey }),
    })
  }

  #item(item: ProgressItem): void {
    const mode = this.#start?.telemetry.progress_mode ?? 'summary'
    if (mode === 'summary' && item.kind !== 'say' && item.kind !== 'error' && item.kind !== 'warning') return
    this.#progress.push(item)
  }

  #flushProgress(): void {
    if (this.#progress.length === 0) return
    let items = this.#progress
    this.#progress = []
    if (items.length > 50) {
      const keep = [...items.filter((item) => item.kind === 'error'), ...items.filter((item) => item.kind !== 'error')].slice(0, 49)
      keep.push({ at: this.#now(), kind: 'warning', text: `${items.length - 49} progress items dropped` })
      items = keep.sort((a, b) => a.at - b.at)
    }
    this.#send('progress', { round: this.#round, items: items.map((item) => ({ ...item, text: clip(item.text, 1_024) })) })
  }

  // --- safety -------------------------------------------------------------------

  #watch(): void {
    if (this.#stopping) return
    const now = this.#now()
    if (now - this.#lastContactAt > this.#o.contactTimeoutSeconds * 1000) {
      void this.#safeStop('lost_contact', `no contact with the relay for ${this.#o.contactTimeoutSeconds} s`, EXIT.lostContact)
    } else if (this.#tokenExp > 0 && now / 1000 >= this.#tokenExp - TOKEN_MARGIN_SECONDS) {
      void this.#safeStop('token_expired', 'the relay token expires and no renewal arrived', EXIT.lostContact)
    } else if (this.#start && !this.#roundRunning && now - this.#lastCommandAt > this.#start.limits.max_seconds * 1000) {
      void this.#safeStop('stopped', 'no command arrived after the last result', EXIT.finished)
    }
    this.#watchQuestions()
  }

  #questionDirectory(): string {
    const directory = this.#o.files.path('questions')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  #watchQuestions(): void {
    if (!this.#start) return
    const directory = this.#questionDirectory()
    const open = new Set(readdirSync(directory).filter((name) => name.endsWith('.question.json')).map((name) => name.slice(0, -'.question.json'.length)))
    for (const id of open) {
      if (this.#questions.has(id)) continue
      this.#questions.add(id)
      try {
        const question = JSON.parse(readFileSync(join(directory, `${id}.question.json`), 'utf8')) as { text?: string; options?: string[] }
        this.#send('question', {
          question_id: id, round: this.#round, text: clip(String(question.text ?? ''), 4_096),
          ...(question.options?.length ? { options: question.options.slice(0, 10).map((option) => clip(String(option), 200)) } : {}),
        })
        this.#status(`question ${id} sent`)
      } catch { /* written again on the next pass */ this.#questions.delete(id) }
    }
    for (const id of [...this.#questions]) if (!open.has(id)) this.#questions.delete(id)
    const waiting = this.#questions.size > 0
    this.#pi?.pauseIdle(waiting)
    if (this.#roundRunning) this.#state = waiting ? 'waiting_answer' : this.#state === 'waiting_answer' ? 'running' : this.#state
  }

  // --- commands -----------------------------------------------------------------

  async #onCommandEvent(seq: number, body: unknown): Promise<void> {
    if (seq <= this.#cursor.lastSeq) return
    const parsed = parseCommand(body)
    if (!parsed.ok) {
      this.#item({ at: this.#now(), kind: 'warning', text: clip(`command ${seq} refused: ${parsed.error}`, 300) })
    } else if (parsed.message.channel !== this.#o.channel) {
      this.#item({ at: this.#now(), kind: 'warning', text: `command ${seq} names another channel` })
    } else if (!this.#cursor.processed.includes(parsed.message.id)) {
      this.#lastCommandAt = this.#now()
      await this.#onCommand(parsed.message)
      this.#cursor.processed.push(parsed.message.id)
    }
    this.#cursor.lastSeq = seq
    this.#o.files.writeCursor(this.#cursor)
  }

  async #onCommand(command: Command): Promise<void> {
    switch (command.type) {
      case 'start': return this.#onStart(command.data)
      case 'credentials': {
        try {
          this.#credentials = open(this.#keys.privateKey, command.data, this.#o.channel)
        } catch (error) {
          this.#item({ at: this.#now(), kind: 'error', text: clip(`credentials refused: ${(error as Error).message}`, 300) })
          return
        }
        this.#status(`credentials received: ${Object.keys(this.#credentials).sort().join(', ') || 'none'}`)
        this.#heartbeat()
        this.#credentialsArrived()
        return
      }
      case 'instruct': {
        if (!this.#start) return
        if (command.data.mode === 'steer' || command.data.mode === 'follow_up') {
          this.#message({ id: command.id, mode: command.data.mode, text: command.data.text })
          return
        }
        if (command.data.mode === 'interrupt' && this.#roundRunning) {
          this.#nextRound = { round: command.data.round, text: command.data.text }
          this.#pi?.stop()
          return
        }
        if (this.#roundRunning) this.#nextRound = { round: command.data.round, text: command.data.text }
        else void this.#runRound(command.data.round, command.data.text)
        return
      }
      case 'answer': {
        const directory = this.#questionDirectory()
        const file = join(directory, `${command.data.question_id}.answer.json`)
        writeFileSync(`${file}.tmp`, JSON.stringify({ text: command.data.text }), { mode: 0o600 })
        renameSync(`${file}.tmp`, file)
        this.#status(`answer to ${command.data.question_id} received`)
        return
      }
      case 'renew': {
        if (command.data.exp <= this.#tokenExp) return
        this.#token = command.data.token
        this.#tokenExp = command.data.exp
        this.#o.files.writeToken(this.#token)
        this.#stream.reconnect()
        return
      }
      case 'stop': {
        void this.#safeStop('stopped', command.data.reason, EXIT.finished, command.data.send_bundle)
      }
    }
  }

  async #onStart(start: StartData): Promise<void> {
    if (this.#start) {
      this.#item({ at: this.#now(), kind: 'warning', text: 'a second start command was ignored' })
      return
    }
    this.#start = start
    this.#scheduleHeartbeat(start.telemetry.heartbeat_seconds)
    this.#status(`task ${start.task_id} attempt ${start.attempt}: ${start.title}`)
    try {
      await prepareWorktree(this.#o.checkout, this.#worktree(), start.branch, start.repository.base_commit)
    } catch (error) {
      await this.#safeStop('worker_error', (error as Error).message, EXIT.configuration)
      return
    }
    void this.#runRound(start.round, this.#roundPrompt(start, null))
  }

  /**
   * Gives a steering or follow-up message to the running Pi, or keeps it for the round that is
   * starting; with no round, it is dropped and the orchestrator hears so.
   */
  #message(message: { id: string; mode: 'steer' | 'follow_up'; text: string }): void {
    if (this.#pi?.send(message.mode, message.text)) {
      this.#phase({ phase: 'instruction_received', round: this.#round, detail: message.id })
    } else if (!this.#pi && !this.#stopping && (this.#roundRunning || this.#roundStartedAt === 0)) {
      this.#waitingMessages.push(message)
    } else {
      this.#phase({ phase: 'instruction_dropped', round: this.#round, detail: message.id })
    }
  }

  #worktree(): string {
    return this.#o.files.path('work')
  }

  #roundPrompt(start: StartData, instruction: string | null): string {
    if (instruction) return instruction
    return [
      `Task ${start.task_id}: ${start.title}`,
      '',
      start.brief,
      '',
      'Work in the current directory, which is a git checkout of the task branch. Make the change the task asks for.',
      'Do not push, and do not open pull requests. Your changes are committed and published for you after this run.',
      'If the task cannot continue without a decision from the person who owns it, call the ask_orchestrator tool.',
      'End with a short summary of what you changed and what remains.',
    ].join('\n')
  }

  // --- rounds -------------------------------------------------------------------

  async #runRound(round: number, prompt: string): Promise<void> {
    const start = this.#start
    if (!start || this.#roundRunning || this.#stopping) return
    this.#roundRunning = true
    if (!(await this.#ready) || this.#stopping) {
      this.#roundRunning = false
      return
    }
    if (start.credentials && !this.#credentials) {
      this.#status('waiting for credentials')
      const arrived = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), CREDENTIALS_WAIT_MS)
        this.#credentialsArrived = () => { clearTimeout(timer); resolve(true) }
      })
      if (!arrived) {
        this.#roundRunning = false
        await this.#safeStop('worker_error', `no credentials within ${CREDENTIALS_WAIT_MS / 1000} s`, EXIT.configuration)
        return
      }
    }
    this.#round = round
    this.#state = 'running'
    this.#o.files.writeJson('start.json', { start, round })
    this.#roundStartedAt = this.#now()
    this.#phase({ phase: 'work_started', round })
    const tiers = JSON.stringify(start.model.fallback_tiers)
    this.#pi = new PiRound({
      ...(this.#piCommand ? { command: this.#piCommand } : {}),
      cwd: this.#worktree(),
      prompt,
      model: start.model.pi_model,
      thinking: this.#o.thinking ?? process.env.PI_THINKING ?? 'medium',
      sessionDirectory: this.#o.files.path('pi_session'),
      sessionId: `task-${start.task_id}-attempt-${start.attempt}`,
      extensions: this.#extensions,
      env: {
        ...piEnvironment(process.env),
        ...this.#credentials,
        PI_FALLBACK_TIERS: tiers,
        POLITBURO_QUESTION_DIRECTORY: this.#questionDirectory(),
        POLITBURO_QUESTION_WAIT_SECONDS: String(start.limits.question_wait_seconds),
      },
      logFile: this.#o.files.path(`round_${round}.jsonl`),
      idleSeconds: start.limits.idle_seconds,
      maxSeconds: start.limits.max_seconds,
      onItem: (item) => this.#item(item),
    })
    for (const message of this.#waitingMessages.splice(0)) this.#message(message)
    let outcome: PiRoundResult
    try {
      outcome = await this.#pi.done
    } catch (error) {
      outcome = { exitReason: 'failed', exitCode: null, summary: (error as Error).message, models: [], costUsd: 0, error: (error as Error).message }
    }
    this.#flushProgress()
    for (const message of this.#waitingMessages.splice(0)) this.#phase({ phase: 'instruction_dropped', round, detail: message.id })
    if (this.#stopping) return
    await this.#finishRound(outcome.exitReason, outcome, true)
    this.#pi = null
    this.#roundRunning = false
    this.#state = 'waiting_start'
    const next = this.#nextRound
    this.#nextRound = null
    if (next) void this.#runRound(next.round, next.text)
  }

  /** Checks, commit, bundle parts and the result of the current round. */
  async #finishRound(exitReason: ExitReason, outcome: Pick<PiRoundResult, 'exitCode' | 'summary' | 'models' | 'costUsd'>, runChecks: boolean): Promise<void> {
    const start = this.#start!
    const worktree = this.#worktree()
    const checks: CheckResult[] = []
    if (runChecks) {
      this.#state = 'checking'
      for (const check of start.checks) {
        const result = await runCheck(worktree, check.command, check.timeout_seconds)
        checks.push({ ...result, name: check.name })
      }
    }
    this.#state = 'bundling'
    const truncated: string[] = []
    let headCommit: string | null = null
    let bundle: ResultData['bundle'] = null
    let stat = { files: 0, insertions: 0, deletions: 0 }
    try {
      await commitAll(worktree, `Task ${start.task_id} round ${this.#round}${exitReason === 'completed' ? '' : ` (${exitReason})`}`)
      headCommit = await head(worktree)
      stat = await diffStat(worktree, start.repository.base_commit)
      const made = await createBundle(worktree, start.branch, start.repository.base_commit, this.#o.files.path(`round_${this.#round}.bundle`))
      if (made) {
        const text = made.bytes.toString('base64')
        const parts: string[] = []
        for (let offset = 0; offset < text.length; offset += BUNDLE_PART_MAX) parts.push(text.slice(offset, offset + BUNDLE_PART_MAX))
        if (parts.length > MAX_BUNDLE_PARTS) {
          truncated.push('bundle')
        } else {
          for (const [index, data] of parts.entries()) this.#send('bundle_part', { round: this.#round, index, count: parts.length, data })
          bundle = { sha256: made.sha256, bytes: made.bytes.length, parts: parts.length }
        }
      }
    } catch (error) {
      this.#item({ at: this.#now(), kind: 'error', text: clip(`git: ${(error as Error).message}`, 400) })
      this.#flushProgress()
    }
    const summary = outcome.summary.length > 8_000 ? (truncated.push('summary'), clip(outcome.summary, 8_000)) : outcome.summary
    const result: ResultData = {
      round: this.#round, exit_reason: exitReason, pi_exit_code: outcome.exitCode !== null && outcome.exitCode >= 0 ? outcome.exitCode : null,
      summary: truncated.includes('bundle') ? clip(`${summary}\n\nThe commits are too large for the relay (more than ${MAX_BUNDLE_PARTS} parts).`, 8_000) : summary,
      branch: start.branch, head_commit: headCommit, base_commit: start.repository.base_commit, bundle,
      diff_stat: stat, checks: checks.slice(0, 20), models: outcome.models.slice(0, 20) as ModelUsage[],
      cost_usd: outcome.costUsd, duration_seconds: Math.round((this.#now() - this.#startedAt) / 1000), truncated,
    }
    this.#phase({ phase: 'work_finished', round: this.#round, detail: exitReason, duration_seconds: Math.round((this.#now() - (this.#roundStartedAt || this.#startedAt)) / 1000) })
    this.#send('result', result)
    this.#o.files.writeJson(`result_round_${this.#round}.json`, result)
    this.#status(`round ${this.#round} result sent: ${exitReason}, ${stat.files} files, checks ${checks.map((check) => `${check.name}=${check.exit_code}`).join(' ') || 'none'}`)
  }

  /**
   * Stops Pi, commits what exists, sends the bundle and a final result when asked, waits up to
   * 30 s for the relay to accept the outbox, then ends the run.
   */
  async #safeStop(reason: ExitReason, detail: string, code: number, sendBundle = true): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    this.#state = 'stopping'
    this.#status(`stopping: ${detail}`)
    const pi = this.#pi
    let outcome: Pick<PiRoundResult, 'exitCode' | 'summary' | 'models' | 'costUsd'> = { exitCode: null, summary: detail, models: [], costUsd: 0 }
    if (pi) {
      pi.stop()
      const ended = await pi.done.catch(() => null)
      if (ended) outcome = { ...ended, summary: `${detail}\n\n${ended.summary}` }
    }
    this.#flushProgress()
    if (this.#start && sendBundle && (this.#roundRunning || pi)) await this.#finishRound(reason, outcome, false)
    this.#state = 'finished'
    this.#heartbeat()
    const drained = await this.#sender.drain(30_000)
    if (!drained) this.#status(`relay unreachable; ${this.#sender.pending} messages stay in ${this.#o.files.path('outbox.json')}`)
    this.#finish(code)
  }
}
