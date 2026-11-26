// Message schema, version 1, for both relay directions.
// The relay itself never reads these; the orchestrator and the worker client
// validate every message they receive with `parseCommand` / `parseTelemetry`.
// Schemas are closed: an unknown field, a wrong type or an oversized text is refused.

export const MESSAGE_VERSION = 1

export type CommandType = 'start' | 'credentials' | 'instruct' | 'answer' | 'stop' | 'renew'
export type TelemetryType = 'heartbeat' | 'progress' | 'question' | 'bundle_part' | 'result'

export interface Envelope<T extends string, D> {
  v: typeof MESSAGE_VERSION
  /** Unique per message; a retried POST reuses it, so receivers drop duplicates. */
  id: string
  type: T
  task: string
  channel: string
  /** Sender clock, Unix milliseconds. Information only. */
  sent_at: number
  data: D
}

export interface StartData {
  task_id: string
  attempt: number
  round: number
  title: string
  brief: string
  brief_sha256: string
  repository: { url: string; base_ref: string; base_commit: string }
  branch: string
  limits: { max_seconds: number; idle_seconds: number; question_wait_seconds: number }
  model: { pi_model: string; fallback_tiers: unknown[] }
  checks: Array<{ name: string; command: string; timeout_seconds: number }>
  telemetry: { heartbeat_seconds: number; progress_mode: 'summary' | 'events' }
  /** A `credentials` command follows once the worker's heartbeat carries its public key; Pi waits for it. */
  credentials: boolean
}
/** Environment variables for Pi, sealed for the worker's public key (see sealed.ts). */
export interface CredentialsData { ephemeral_public_key: string; nonce: string; ciphertext: string }
export interface InstructData { round: number; text: string; mode: 'next_round' | 'interrupt' }
export interface AnswerData { question_id: string; text: string }
/** `send_bundle`: send the commits made so far as bundle parts and a final result before exiting. */
export interface StopData { reason: string; send_bundle: boolean }
export interface RenewData { token: string; exp: number }

export type WorkerState = 'waiting_start' | 'running' | 'waiting_answer' | 'checking' | 'bundling' | 'stopping' | 'finished'
export interface HeartbeatData {
  state: WorkerState
  round: number
  last_command_seq: number
  elapsed_seconds: number
  token_exp: number
  pi_alive: boolean
  /** The worker's X25519 public key, base64url, until it has received its credentials. */
  public_key?: string
}
export type ProgressKind = 'tool' | 'say' | 'error' | 'usage' | 'diff' | 'warning'
export interface ProgressData { round: number; items: Array<{ at: number; kind: ProgressKind; text: string }> }
export interface QuestionData { question_id: string; round: number; text: string; options?: string[] }
/** One part of the round's git bundle (base64). Workers hold no GitHub credential: the orchestrator pushes. */
export interface BundlePartData { round: number; index: number; count: number; data: string }
/** Largest base64 text in one bundle part, so the whole message stays under the relay's 64 KiB. */
export const BUNDLE_PART_MAX = 48_000
export type ExitReason = 'completed' | 'failed' | 'timeout' | 'idle' | 'stopped' | 'lost_contact' | 'token_expired' | 'worker_error'
export interface ResultData {
  round: number
  exit_reason: ExitReason
  pi_exit_code: number | null
  summary: string
  branch: string
  head_commit: string | null
  base_commit: string
  /** The round's commits as a git bundle of `branch`, sent before this result in `bundle_part` messages; null without commits. */
  bundle: { sha256: string; bytes: number; parts: number } | null
  diff_stat: { files: number; insertions: number; deletions: number }
  checks: Array<{ name: string; exit_code: number | null; duration_seconds: number; output_tail: string }>
  models: Array<{ provider: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number }>
  cost_usd: number
  duration_seconds: number
  truncated: string[]
}

export type Command =
  | Envelope<'start', StartData>
  | Envelope<'credentials', CredentialsData>
  | Envelope<'instruct', InstructData>
  | Envelope<'answer', AnswerData>
  | Envelope<'stop', StopData>
  | Envelope<'renew', RenewData>
export type Telemetry =
  | Envelope<'heartbeat', HeartbeatData>
  | Envelope<'progress', ProgressData>
  | Envelope<'question', QuestionData>
  | Envelope<'bundle_part', BundlePartData>
  | Envelope<'result', ResultData>

export type Parsed<T> = { ok: true; message: T } | { ok: false; error: string }

// --- schema checker -------------------------------------------------------

type Check = (value: unknown, path: string) => string | null

const str = (max: number, pattern?: RegExp): Check => (v, p) =>
  typeof v !== 'string' ? `${p}: string expected`
    : v.length > max ? `${p}: longer than ${max}`
    : pattern && !pattern.test(v) ? `${p}: invalid format` : null
const int = (min = 0): Check => (v, p) => Number.isSafeInteger(v) && (v as number) >= min ? null : `${p}: integer >= ${min} expected`
const num: Check = (v, p) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? null : `${p}: number >= 0 expected`
const bool: Check = (v, p) => typeof v === 'boolean' ? null : `${p}: boolean expected`
const oneOf = (...values: string[]): Check => (v, p) => typeof v === 'string' && values.includes(v) ? null : `${p}: one of ${values.join(', ')}`
const nullable = (check: Check): Check => (v, p) => v === null ? null : check(v, p)
const list = (item: Check, max: number): Check => (v, p) => {
  if (!Array.isArray(v)) return `${p}: array expected`
  if (v.length > max) return `${p}: more than ${max} items`
  for (let i = 0; i < v.length; i++) { const e = item(v[i], `${p}[${i}]`); if (e) return e }
  return null
}
const anyList = (max: number): Check => (v, p) => Array.isArray(v) && v.length <= max ? null : `${p}: array of at most ${max} expected`
const object = (fields: Record<string, Check>, optional: string[] = []): Check => (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return `${p}: object expected`
  const record = v as Record<string, unknown>
  for (const key of Object.keys(record)) if (!(key in fields)) return `${p}.${key}: unknown field`
  for (const [key, check] of Object.entries(fields)) {
    if (!(key in record)) { if (optional.includes(key)) continue; return `${p}.${key}: missing` }
    const e = check(record[key], `${p}.${key}`)
    if (e) return e
  }
  return null
}

const ID = /^[A-Za-z0-9_-]{1,100}$/
const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const KEY = /^[A-Za-z0-9_-]{43}$/
const BRANCH = /^claude\/task-[A-Za-z0-9_-]{1,100}$/
const text = (max: number) => str(max)

const commandData: Record<CommandType, Check> = {
  start: object({
    task_id: str(100, ID), attempt: int(1), round: int(1), title: text(300), brief: text(40_000), brief_sha256: str(64, SHA256),
    repository: object({ url: str(500, /^https:\/\//), base_ref: text(200), base_commit: str(40, SHA1) }),
    branch: str(120, BRANCH),
    limits: object({ max_seconds: int(1), idle_seconds: int(1), question_wait_seconds: int(1) }),
    model: object({ pi_model: text(200), fallback_tiers: anyList(20) }),
    checks: list(object({ name: text(100), command: text(2_000), timeout_seconds: int(1) }), 20),
    telemetry: object({ heartbeat_seconds: int(5), progress_mode: oneOf('summary', 'events') }),
    credentials: bool,
  }),
  credentials: object({ ephemeral_public_key: str(43, KEY), nonce: str(16, BASE64URL), ciphertext: str(48_000, BASE64URL) }),
  instruct: object({ round: int(2), text: text(32_000), mode: oneOf('next_round', 'interrupt') }),
  answer: object({ question_id: str(100, ID), text: text(8_000) }),
  stop: object({ reason: text(1_000), send_bundle: bool }),
  renew: object({ token: text(4_000), exp: int(1) }),
}

const telemetryData: Record<TelemetryType, Check> = {
  heartbeat: object({
    state: oneOf('waiting_start', 'running', 'waiting_answer', 'checking', 'bundling', 'stopping', 'finished'),
    round: int(0), last_command_seq: int(0), elapsed_seconds: num, token_exp: int(0), pi_alive: bool, public_key: str(43, KEY),
  }, ['public_key']),
  progress: object({
    round: int(0),
    items: list(object({ at: int(0), kind: oneOf('tool', 'say', 'error', 'usage', 'diff', 'warning'), text: text(1_024) }), 50),
  }),
  question: object({ question_id: str(100, ID), round: int(1), text: text(4_096), options: list(text(200), 10) }, ['options']),
  bundle_part: object({ round: int(1), index: int(0), count: int(1), data: str(BUNDLE_PART_MAX, /^[A-Za-z0-9+/]*={0,2}$/) }),
  result: object({
    round: int(1),
    exit_reason: oneOf('completed', 'failed', 'timeout', 'idle', 'stopped', 'lost_contact', 'token_expired', 'worker_error'),
    pi_exit_code: nullable(int(0)), summary: text(8_192), branch: str(120, BRANCH), head_commit: nullable(str(40, SHA1)),
    base_commit: str(40, SHA1),
    bundle: nullable(object({ sha256: str(64, SHA256), bytes: int(1), parts: int(1) })),
    diff_stat: object({ files: int(0), insertions: int(0), deletions: int(0) }),
    checks: list(object({ name: text(100), exit_code: nullable(int(0)), duration_seconds: num, output_tail: text(2_048) }), 20),
    models: list(object({ provider: text(100), model: text(200), input_tokens: int(0), output_tokens: int(0), cost_usd: num }), 20),
    cost_usd: num, duration_seconds: num, truncated: list(text(100), 20),
  }),
}

function parse<T>(value: unknown, schemas: Record<string, Check>): Parsed<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'message: object expected' }
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string' || !Object.hasOwn(schemas, type)) return { ok: false, error: `type: unknown ${String(type)}` }
  const error = object({
    v: (v, p) => v === MESSAGE_VERSION ? null : `${p}: version ${MESSAGE_VERSION} expected`,
    id: str(100, ID), type: str(20), task: str(100, ID), channel: str(100, ID), sent_at: int(0), data: schemas[type]!,
  })(value, 'message')
  return error ? { ok: false, error } : { ok: true, message: value as T }
}

export const parseCommand = (value: unknown): Parsed<Command> => parse<Command>(value, commandData)
export const parseTelemetry = (value: unknown): Parsed<Telemetry> => parse<Telemetry>(value, telemetryData)

/** Builds an envelope with a fresh id. */
export function envelope<T extends string, D>(type: T, task: string, channel: string, data: D, now = Date.now()): Envelope<T, D> {
  return { v: MESSAGE_VERSION, id: crypto.randomUUID(), type, task, channel, sent_at: now, data }
}
