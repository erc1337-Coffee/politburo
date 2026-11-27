// The thread reply of one worker round: a `worker_activity@1` block with the worker's thinking,
// actions and messages, kept up to date while the round runs, and the worker's final answer as
// the reply's text when the round ends.
import type { ProgressKind, ResultData } from '@remilia/politburo-relay/messages'

export const ACTIVITY_SCHEMA = {
  name: 'worker_activity',
  version: 1,
  description: 'What a Politburo worker did in one round: its thinking, actions and messages, oldest first.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['task', 'attempt', 'round', 'state', 'items'],
    properties: {
      task: { type: 'string' },
      attempt: { type: 'integer', minimum: 1 },
      round: { type: 'integer', minimum: 1 },
      state: { enum: ['running', 'completed', 'failed', 'timeout', 'idle', 'stopped', 'lost_contact', 'token_expired', 'worker_error'] },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['at', 'kind', 'text'],
          properties: { at: { type: 'integer' }, kind: { type: 'string' }, text: { type: 'string' } },
        },
      },
      changes: {
        type: 'object',
        additionalProperties: false,
        properties: { files: { type: 'integer' }, insertions: { type: 'integer' }, deletions: { type: 'integer' } },
      },
      checks: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, passed: { type: 'boolean' } } },
      },
    },
  },
} as const

/** The kinds the block keeps; usage and diff lines are in the result and the usage view. */
const SHOWN = new Set<ProgressKind>(['thinking', 'tool', 'output', 'say', 'error', 'warning'])
/** Most items one reply holds, newest kept, so its text stays far below the board's limit. */
const ITEMS_MAX = 60

export interface ActivityItem { at: number; kind: ProgressKind; text: string }

export class RoundReport {
  readonly items: ActivityItem[] = []
  state: string = 'running'
  answer = ''
  changes: ResultData['diff_stat'] | null = null
  checks: Array<{ name: string; passed: boolean }> = []
  /** The board reply that shows this round, once posted. */
  messageId: string | null = null

  readonly task: string
  readonly attempt: number
  readonly round: number

  constructor(task: string, attempt: number, round: number) {
    this.task = task
    this.attempt = attempt
    this.round = round
  }

  add(items: readonly ActivityItem[]): boolean {
    const shown = items.filter((item) => SHOWN.has(item.kind))
    this.items.push(...shown)
    if (this.items.length > ITEMS_MAX) this.items.splice(0, this.items.length - ITEMS_MAX)
    return shown.length > 0
  }

  finish(result: ResultData, text: (value: string, max: number) => string): void {
    this.state = result.exit_reason
    this.answer = text(result.summary, 4_000)
    // The final answer is the reply's text; the block does not repeat it.
    const last = this.items.at(-1)
    if (last?.kind === 'say' && result.summary.startsWith(last.text.replace(/…$/, ''))) this.items.pop()
    if (result.diff_stat.files > 0) this.changes = result.diff_stat
    this.checks = result.checks.map((check) => ({ name: check.name, passed: check.exit_code === 0 }))
  }

  text(): string {
    const data = {
      task: this.task, attempt: this.attempt, round: this.round, state: this.state, items: this.items,
      ...(this.changes ? { changes: this.changes } : {}),
      ...(this.checks.length ? { checks: this.checks } : {}),
    }
    const block = `\`\`\`json#${ACTIVITY_SCHEMA.name}@${ACTIVITY_SCHEMA.version}\n${JSON.stringify(data)}\n\`\`\``
    return this.answer ? `${block}\n\n${this.answer}` : block
  }
}
