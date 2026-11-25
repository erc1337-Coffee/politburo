// The inspector's operations routes: the orchestrator's status, forwarded from its server on
// 127.0.0.1, and usage figures read from the spend ledger. Read only.
//
//   GET /api/operations/state                       orchestrator snapshot
//   GET /api/operations/events                      orchestrator events (SSE)
//   GET /api/operations/attempts/{attempt}/events   last events of one attempt
//   GET /api/operations/usage                       usage from the spend ledger
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SpendRecord } from '@remilia/politburo-ledger'

export type OperationsOptions = {
  /** The orchestrator's status server, e.g. `http://127.0.0.1:4190`; null when there is none. */
  url: string | null
  /** The spend ledger file; null when there is none. */
  ledgerFile: string | null
}

export const OPERATIONS_PREFIX = '/api/operations/'

const ATTEMPT_ROUTE = /^attempts\/([0-9a-f-]{36})\/events$/
const USAGE_CACHE_MS = 5_000

type Figures = {
  records: number
  input_tokens: number
  output_tokens: number
  /** Known estimated cost, in USD, as a decimal string. */
  cost_usd: string
  /** Records whose cost or token counts are unknown: never counted as zero. */
  unknown_records: number
}

export type UsageSummary = {
  at: number
  available: boolean
  error: string | null
  last_hour: Figures
  today: Figures
  total: Figures
  by_attempt: Array<{ attempt: string; work_id: string | null; figures: Figures }>
  by_model: Array<{ model: string; figures: Figures }>
  /** Hourly cost of the last 24 hours, oldest first. */
  hourly: Array<{ hour: number; cost_usd: string; output_tokens: number }>
}

const empty = (): Figures => ({ records: 0, input_tokens: 0, output_tokens: 0, cost_usd: '0', unknown_records: 0 })

/** Adds decimal strings without floating-point error, at 1e-9 USD. */
function addUsd(a: string, b: string): string {
  const scale = 1_000_000_000n
  const parse = (value: string) => {
    const negative = value.startsWith('-')
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.')
    const units = BigInt(whole) * scale + BigInt((fraction + '000000000').slice(0, 9))
    return negative ? -units : units
  }
  const sum = parse(a) + parse(b)
  const negative = sum < 0n
  const absolute = negative ? -sum : sum
  const fraction = (absolute % scale).toString().padStart(9, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${absolute / scale}${fraction ? `.${fraction}` : ''}`
}

function add(figures: Figures, record: SpendRecord): void {
  figures.records++
  figures.input_tokens += record.tokens.input_uncached ?? 0
  figures.output_tokens += record.tokens.output ?? 0
  const known = record.amount !== null && record.amount.unit === 'USD' && record.tokens.output !== null
  if (record.amount !== null && record.amount.unit === 'USD') figures.cost_usd = addUsd(figures.cost_usd, record.amount.value)
  if (!known) figures.unknown_records++
}

export async function summarizeUsage(file: string, now = Date.now()): Promise<UsageSummary> {
  const { readLedger } = await import('@remilia/politburo-ledger')
  const ledger = readLedger(file)
  const hour = 3_600_000
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const summary: UsageSummary = {
    at: now, available: true, error: null, last_hour: empty(), today: empty(), total: empty(), by_attempt: [], by_model: [], hourly: [],
  }
  const attempts = new Map<string, { work_id: string | null; figures: Figures }>()
  const models = new Map<string, Figures>()
  const firstHour = Math.floor(now / hour) * hour - 23 * hour
  const hourly = Array.from({ length: 24 }, (_, index) => ({ hour: firstHour + index * hour, cost_usd: '0', output_tokens: 0 }))
  for (const record of ledger.heads()) {
    const at = Date.parse(record.occurred ?? record.received)
    add(summary.total, record)
    if (at >= now - hour) add(summary.last_hour, record)
    if (at >= midnight.getTime()) add(summary.today, record)
    const attempt = record.envelope?.trace.execution_id ?? 'unassigned'
    const row = attempts.get(attempt) ?? { work_id: record.envelope?.work_id ?? null, figures: empty() }
    add(row.figures, record)
    attempts.set(attempt, row)
    const model = record.actual_model ? `${record.provider ?? 'unknown'}/${record.actual_model}` : 'unknown'
    const figures = models.get(model) ?? empty()
    add(figures, record)
    models.set(model, figures)
    const slot = hourly[Math.floor((at - firstHour) / hour)]
    if (slot) {
      if (record.amount?.unit === 'USD') slot.cost_usd = addUsd(slot.cost_usd, record.amount.value)
      slot.output_tokens += record.tokens.output ?? 0
    }
  }
  summary.by_attempt = [...attempts].map(([attempt, row]) => ({ attempt, ...row }))
  summary.by_model = [...models].map(([model, figures]) => ({ model, figures })).sort((a, b) => b.figures.records - a.figures.records)
  summary.hourly = hourly
  return summary
}

export function operationsRoutes(options: OperationsOptions) {
  let cached: { at: number; summary: UsageSummary } | null = null

  async function usage(): Promise<UsageSummary> {
    const now = Date.now()
    if (cached && now - cached.at < USAGE_CACHE_MS) return cached.summary
    let summary: UsageSummary
    if (!options.ledgerFile) {
      summary = { ...emptySummary(now), error: 'no ledger' }
    } else if (!existsSync(options.ledgerFile)) {
      summary = { ...emptySummary(now), available: true }
    } else {
      try {
        summary = await summarizeUsage(options.ledgerFile, now)
      } catch {
        summary = { ...emptySummary(now), error: 'ledger unreadable' }
      }
    }
    cached = { at: now, summary }
    return summary
  }

  /** Answers a request under `/api/operations/`, after the caller checked the page token. */
  async function handle(request: IncomingMessage, response: ServerResponse, path: string, signal: AbortSignal): Promise<void> {
    if (request.method !== 'GET') return json(response, 405, { error: { code: 'method_not_allowed', message: 'read only' } })
    if (path === 'usage') return json(response, 200, await usage())
    const attempt = ATTEMPT_ROUTE.exec(path)
    if (path !== 'state' && path !== 'events' && !attempt) return json(response, 404, { error: { code: 'not_found', message: 'no such operations route' } })
    if (!options.url) return json(response, 503, { error: { code: 'no_orchestrator', message: 'no orchestrator status server is configured' } })
    const lastEventId = request.headers['last-event-id']
    let upstream: Response
    try {
      upstream = await fetch(`${options.url.replace(/\/+$/, '')}/${path}`, {
        headers: typeof lastEventId === 'string' && /^\d{1,15}$/.test(lastEventId) ? { 'last-event-id': lastEventId } : {},
        signal,
        redirect: 'error',
      })
    } catch (error) {
      if (signal.aborted) return void response.end()
      const cause = (error as { cause?: { code?: unknown } }).cause?.code
      const code = typeof cause === 'string' && /^[A-Z_]{1,40}$/.test(cause) ? cause : (error as Error).name
      return json(response, 502, { error: { code: 'orchestrator_unreachable', message: `orchestrator unreachable (${code})` } })
    }
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(path === 'events' ? { 'x-accel-buffering': 'no' } : {}),
    })
    try {
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk)
    } catch {
      // The orchestrator or the page closed the stream.
    }
    response.end()
  }

  return { handle }
}

function emptySummary(now: number): UsageSummary {
  return { at: now, available: false, error: null, last_hour: empty(), today: empty(), total: empty(), by_attempt: [], by_model: [], hourly: [] }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(body))
}
