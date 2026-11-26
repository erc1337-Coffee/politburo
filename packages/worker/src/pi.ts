// Runs one Pi round: `pi -p --mode json` in its own process group, with an idle limit and a
// maximum time. Pi JSONL events become progress items, model usage and the round summary.
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { ProgressKind } from '../../relay/src/messages.ts'
import { treeFingerprint } from './git.ts'

export interface ProgressItem { at: number; kind: ProgressKind; text: string }
export interface ModelUsage { provider: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number }

export interface PiRoundResult {
  exitReason: 'completed' | 'failed' | 'timeout' | 'idle' | 'stopped'
  exitCode: number | null
  summary: string
  models: ModelUsage[]
  costUsd: number
  error: string
}

export interface PiRoundOptions {
  command?: string
  cwd: string
  prompt: string
  model: string
  thinking: string
  sessionDirectory: string
  sessionId: string
  extensions: string[]
  env: NodeJS.ProcessEnv
  logFile: string
  idleSeconds: number
  maxSeconds: number
  onItem: (item: ProgressItem) => void
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

interface PiEvent {
  type?: string
  toolName?: string
  args?: Record<string, unknown>
  isError?: boolean
  result?: unknown
  message?: {
    role?: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string
    content?: Array<{ type?: string; text?: string; thinking?: string }>
    usage?: { input?: number; output?: number; cost?: { total?: number } }
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join(' ')
  if (value && typeof value === 'object' && 'content' in value) return textOf((value as { content: unknown }).content)
  return ''
}

export class PiRound {
  readonly #options: PiRoundOptions
  #child: ChildProcess | null = null
  #lastActivity = Date.now()
  #idlePaused = false
  #stopReason: 'stopped' | 'timeout' | 'idle' | null = null
  /** The last model reply was an error, so the round did not complete even when Pi exits 0. */
  #lastFailed = false
  readonly #models = new Map<string, ModelUsage>()
  #summary = ''
  #error = ''
  readonly done: Promise<PiRoundResult>

  constructor(options: PiRoundOptions) {
    this.#options = options
    this.done = this.#run()
  }

  get alive(): boolean {
    return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null
  }

  /** While a question waits for an answer, the idle limit does not run. */
  pauseIdle(paused: boolean): void {
    this.#idlePaused = paused
    this.#lastActivity = Date.now()
  }

  stop(): void {
    this.#stopReason ??= 'stopped'
    this.#terminate()
  }

  #terminate(): void {
    const pid = this.#child?.pid
    if (!pid || !this.alive) return
    try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }, 5_000).unref()
  }

  #handle(line: string): void {
    appendFileSync(this.#options.logFile, `${line}\n`, { mode: 0o600 })
    let event: PiEvent
    try { event = JSON.parse(line) as PiEvent } catch { return }
    const at = Date.now()
    const { onItem } = this.#options
    if (event.type === 'tool_execution_start') {
      const target = event.args?.command ?? event.args?.path ?? ''
      onItem({ at, kind: 'tool', text: clip(`${event.toolName ?? 'tool'} ${typeof target === 'string' ? target : JSON.stringify(target)}`, 300) })
    } else if (event.type === 'tool_execution_end') {
      const output = textOf(event.result).trim()
      if (event.isError) onItem({ at, kind: 'error', text: clip(output, 600) })
      else if (output) onItem({ at, kind: 'output', text: clip(output, 1_000) })
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message
      const thinking = (message.content ?? []).filter((part) => part.type === 'thinking').map((part) => part.thinking ?? '').join('\n').trim()
      if (thinking) onItem({ at, kind: 'thinking', text: clip(thinking, 1_000) })
      const text = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n').trim()
      if (text) {
        this.#summary = text
        onItem({ at, kind: 'say', text: clip(text, 600) })
      }
      this.#lastFailed = Boolean(message.errorMessage)
      if (message.errorMessage) {
        this.#error = message.errorMessage
        onItem({ at, kind: 'error', text: clip(message.errorMessage, 400) })
      }
      if (message.usage && message.provider && message.model) {
        const key = `${message.provider}/${message.model}`
        const row = this.#models.get(key) ?? { provider: message.provider, model: message.model, input_tokens: 0, output_tokens: 0, cost_usd: 0 }
        row.input_tokens += message.usage.input ?? 0
        row.output_tokens += message.usage.output ?? 0
        row.cost_usd += message.usage.cost?.total ?? 0
        this.#models.set(key, row)
        onItem({ at, kind: 'usage', text: clip(`${key} in ${message.usage.input ?? 0} out ${message.usage.output ?? 0} $${(message.usage.cost?.total ?? 0).toFixed(4)}`, 200) })
      }
    }
  }

  async #run(): Promise<PiRoundResult> {
    const o = this.#options
    const args = ['-p', '--mode', 'json', '--session-dir', o.sessionDirectory, '--session-id', o.sessionId, '--model', o.model, '--thinking', o.thinking]
    for (const extension of o.extensions) args.push('--extension', extension)
    args.push('--', o.prompt)
    const child = spawn(o.command ?? 'pi', args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.#child = child
    let buffer = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      this.#lastActivity = Date.now()
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line) this.#handle(line)
      }
    })
    let stderr = ''
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4_000) })
    const started = Date.now()
    let fingerprint = ''
    const watch = setInterval(() => {
      void treeFingerprint(o.cwd).then((next) => {
        if (next !== fingerprint) { fingerprint = next; this.#lastActivity = Date.now() }
      })
      if (Date.now() - started >= o.maxSeconds * 1000) { this.#stopReason ??= 'timeout'; this.#terminate() }
      else if (!this.#idlePaused && Date.now() - this.#lastActivity >= o.idleSeconds * 1000) { this.#stopReason ??= 'idle'; this.#terminate() }
    }, 5_000)
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (error) => { this.#error = error.message; resolve(null) })
      child.on('close', (code) => resolve(code))
    })
    clearInterval(watch)
    if (buffer.trim()) this.#handle(buffer.trim())
    const models = [...this.#models.values()]
    const exitReason = this.#stopReason ?? (exitCode === 0 && !this.#lastFailed ? 'completed' : 'failed')
    if (exitReason === 'failed' && !this.#error) this.#error = stderr.trim().split('\n').slice(-5).join('\n')
    return {
      exitReason, exitCode, summary: (this.#lastFailed ? this.#error : this.#summary) || this.#error || '(no reply)', models,
      costUsd: models.reduce((sum, row) => sum + row.cost_usd, 0), error: this.#error,
    }
  }
}
