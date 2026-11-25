// Writes the model usage of every worker round into the party's spend ledger. The orchestrator
// opens the file only while it appends, so the board can read it between writes.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openLedger, type Envelope, type SpendRecord } from '@remilia/politburo-ledger'
import type { ResultData } from '@remilia/politburo-relay/messages'
import type { AttemptRecord } from './state.ts'

export interface UsageLedgerOptions {
  file: string
  party: string
  /** The route the worker was asked to use, for `requested_route`. */
  requestedRoute: string
}

const iso = (ms: number) => new Date(ms).toISOString()

function decimal(value: number): string {
  const text = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return text === '-0' ? '0' : text
}

export class UsageLedger {
  readonly #o: UsageLedgerOptions

  constructor(options: UsageLedgerOptions) {
    this.#o = options
    mkdirSync(dirname(options.file), { recursive: true })
  }

  /** Creates the ledger file when it is missing, so readers find it before the first round. */
  initialize(): void {
    openLedger(this.#o.file, { journal: 'rollback', busyMs: 5_000 }).close()
  }

  envelope(attempt: AttemptRecord): Envelope {
    return {
      party: this.#o.party, repo: attempt.repository, work_id: `task-${attempt.taskId}`, attempt: attempt.attemptId,
      tier: 'mob', parent: null, session: attempt.session ?? attempt.channel,
      trace: { id: attempt.channel, execution_id: attempt.attemptId },
    }
  }

  /**
   * One record for each model row of the result. A round that ran Pi but reported no model row
   * gets one record with unknown counts, so the gap stays visible.
   */
  records(attempt: AttemptRecord, result: ResultData, receivedAt: number): SpendRecord[] {
    const envelope = this.envelope(attempt)
    const base = {
      revises: null, envelope, source: 'worker-result', source_version: '1', requested_route: this.#o.requestedRoute,
      auth_class: null, occurred: iso(receivedAt), received: iso(receivedAt), started: null, ended: null,
      status: result.exit_reason, exit_reason: result.exit_reason,
    } as const
    const key = `${attempt.channel}:r${result.round}`
    if (result.models.length === 0) {
      if (result.pi_exit_code === null && result.exit_reason !== 'completed') return []
      return [{
        ...base, record_id: `${key}:unknown`, dedupe_key: `worker-result:${key}:unknown`, source_event_key: `${key}:unknown`,
        evidence_ref: `relay:${attempt.channel}:result:${result.round}`, provider: null, actual_model: null,
        tokens: { input_uncached: null, input_total: null, output: null, cache_read: null, cache_write: null, reasoning: null },
        amount: null, basis: 'unknown',
        coverage: {
          state: 'partial',
          field_quality: {
            'tokens.input_uncached': 'unknown', 'tokens.input_total': 'unknown', 'tokens.output': 'unknown',
            'tokens.cache_read': 'unknown', 'tokens.cache_write': 'unknown', 'tokens.reasoning': 'unknown', amount: 'unknown',
          },
        },
      }]
    }
    return result.models.map((row, index) => ({
      ...base, record_id: `${key}:m${index}`, dedupe_key: `worker-result:${key}:${row.provider}/${row.model}`,
      source_event_key: `${key}:m${index}`, evidence_ref: `relay:${attempt.channel}:result:${result.round}`,
      provider: row.provider, actual_model: row.model,
      tokens: { input_uncached: row.input_tokens, input_total: null, output: row.output_tokens, cache_read: null, cache_write: null, reasoning: null },
      amount: { value: decimal(row.cost_usd), unit: 'USD' }, basis: 'priced_estimate',
      coverage: {
        state: 'partial',
        field_quality: {
          'tokens.input_uncached': 'provider_reported', 'tokens.input_total': 'unknown', 'tokens.output': 'provider_reported',
          'tokens.cache_read': 'unknown', 'tokens.cache_write': 'unknown', 'tokens.reasoning': 'unknown', amount: 'priced_estimate',
        },
      },
    }))
  }

  /** Appends the dispatch of the attempt (once) and the records of one round. Replays are harmless. */
  recordRound(attempt: AttemptRecord, result: ResultData, receivedAt: number): number {
    const ledger = openLedger(this.#o.file, { journal: 'rollback', busyMs: 5_000 })
    try {
      ledger.createDispatch({ envelope: this.envelope(attempt), sponsor: null, created: iso(attempt.createdAt) })
      let appended = 0
      for (const record of this.records(attempt, result, receivedAt)) {
        if (ledger.append(record).outcome === 'appended') appended++
      }
      return appended
    } finally {
      ledger.close()
    }
  }
}
