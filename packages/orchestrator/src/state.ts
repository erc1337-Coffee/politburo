// Orchestrator state: one SQLite file. It is the recovery authority for attempts;
// the board stays the authority for task state, the launch journal for launches.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type AttemptState =
  | 'claimed' | 'launching' | 'awaiting_contact' | 'running' | 'waiting_answer'
  | 'deciding' | 'publishing' | 'stopping' | 'lost' | 'uncertain' | 'settled'

export const LIVE_STATES: readonly AttemptState[] = ['claimed', 'launching', 'awaiting_contact', 'running', 'waiting_answer', 'deciding', 'publishing', 'stopping']

export interface AttemptRecord {
  attemptId: string
  taskId: string
  attemptNo: number
  channel: string
  boardChannel: string
  repository: string
  branch: string
  baseCommit: string
  state: AttemptState
  round: number
  claimEpoch: number
  claimToken: string
  session: string | null
  createdAt: number
  launchedAt: number | null
  lastContactAt: number | null
  workerTokenExp: number
  stopSentAt: number | null
  telemetrySeq: number
  costUsd: number
  questionId: string | null
  questionAt: number | null
  outcome: string | null
  prUrl: string | null
}

const COLUMNS: Record<keyof AttemptRecord, string> = {
  attemptId: 'attempt_id', taskId: 'task_id', attemptNo: 'attempt_no', channel: 'channel', boardChannel: 'board_channel',
  repository: 'repository', branch: 'branch', baseCommit: 'base_commit', state: 'state', round: 'round',
  claimEpoch: 'claim_epoch', claimToken: 'claim_token', session: 'session', createdAt: 'created_at', launchedAt: 'launched_at',
  lastContactAt: 'last_contact_at', workerTokenExp: 'worker_token_exp', stopSentAt: 'stop_sent_at', telemetrySeq: 'telemetry_seq',
  costUsd: 'cost_usd', questionId: 'question_id', questionAt: 'question_at', outcome: 'outcome', prUrl: 'pr_url',
}
const KEYS = Object.keys(COLUMNS) as Array<keyof AttemptRecord>
const NUMERIC = new Set<keyof AttemptRecord>(['attemptNo', 'round', 'claimEpoch', 'createdAt', 'launchedAt', 'lastContactAt', 'workerTokenExp', 'stopSentAt', 'telemetrySeq', 'costUsd', 'questionAt'])

export interface PendingCommand { id: string; channel: string; body: string }

/** Work a person asked for in a task thread that no running worker took: the next attempt of the task does it. */
export interface FollowupRequest { id: string; taskId: string; text: string; createdAt: number; attemptId: string | null }

export class StateStore {
  readonly #db: DatabaseSync

  constructor(path: string) {
    this.#db = new DatabaseSync(path)
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, channel TEXT NOT NULL UNIQUE,
        board_channel TEXT NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL, base_commit TEXT NOT NULL,
        state TEXT NOT NULL, round INTEGER NOT NULL, claim_epoch INTEGER NOT NULL, claim_token TEXT NOT NULL,
        session TEXT, created_at INTEGER NOT NULL, launched_at INTEGER, last_contact_at INTEGER,
        worker_token_exp INTEGER NOT NULL, stop_sent_at INTEGER, telemetry_seq INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, question_id TEXT, question_at INTEGER, outcome TEXT, pr_url TEXT
      );
      CREATE INDEX IF NOT EXISTS attempts_task ON attempts (task_id);
      CREATE TABLE IF NOT EXISTS seen_messages (channel TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (channel, id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, channel TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS followup_requests (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, attempt_id TEXT
      );
      CREATE INDEX IF NOT EXISTS followup_requests_task ON followup_requests (task_id);
    `)
  }

  insert(record: AttemptRecord): void {
    const columns = KEYS.map((key) => COLUMNS[key])
    this.#db.prepare(`INSERT INTO attempts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...KEYS.map((key) => record[key] as string | number | null))
  }

  update(attemptId: string, change: Partial<AttemptRecord>): void {
    const keys = (Object.keys(change) as Array<keyof AttemptRecord>).filter((key) => key !== 'attemptId')
    if (keys.length === 0) return
    this.#db.prepare(`UPDATE attempts SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(', ')} WHERE attempt_id = ?`)
      .run(...keys.map((key) => change[key] as string | number | null), attemptId)
  }

  get(attemptId: string): AttemptRecord | null {
    const row = this.#db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId)
    return row ? toRecord(row as Record<string, unknown>) : null
  }

  live(): AttemptRecord[] {
    const marks = LIVE_STATES.map(() => '?').join(', ')
    return (this.#db.prepare(`SELECT * FROM attempts WHERE state IN (${marks}) ORDER BY created_at`).all(...LIVE_STATES) as Array<Record<string, unknown>>).map(toRecord)
  }

  forTask(taskId: string): AttemptRecord[] {
    return (this.#db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt_no').all(taskId) as Array<Record<string, unknown>>).map(toRecord)
  }

  all(limit = 100): AttemptRecord[] {
    return (this.#db.prepare('SELECT * FROM attempts ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>).map(toRecord)
  }

  /** Records a telemetry message id; false when it was seen already (a retried POST). */
  markSeen(channel: string, id: string): boolean {
    return Number(this.#db.prepare('INSERT OR IGNORE INTO seen_messages (channel, id) VALUES (?, ?)').run(channel, id).changes) === 1
  }

  /** Runs `fn` in one transaction, so a message's effect and its cursor are stored together. */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  queue(command: PendingCommand, now: number): void {
    this.#db.prepare('INSERT OR IGNORE INTO outbox (id, channel, body, created_at) VALUES (?, ?, ?, ?)').run(command.id, command.channel, command.body, now)
  }

  pending(): PendingCommand[] {
    return this.#db.prepare('SELECT id, channel, body FROM outbox ORDER BY created_at, rowid').all() as unknown as PendingCommand[]
  }

  sent(id: string): void {
    this.#db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
  }

  addFollowup(request: Omit<FollowupRequest, 'attemptId'>): void {
    this.#db.prepare('INSERT OR IGNORE INTO followup_requests (id, task_id, text, created_at) VALUES (?, ?, ?, ?)').run(request.id, request.taskId, request.text, request.createdAt)
  }

  /** The requests no attempt took yet, oldest first; of one task, or of all. */
  pendingFollowups(taskId?: string): FollowupRequest[] {
    const rows = (taskId === undefined
      ? this.#db.prepare('SELECT * FROM followup_requests WHERE attempt_id IS NULL ORDER BY created_at, rowid').all()
      : this.#db.prepare('SELECT * FROM followup_requests WHERE attempt_id IS NULL AND task_id = ? ORDER BY created_at, rowid').all(taskId)) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: String(row.id), taskId: String(row.task_id), text: String(row.text), createdAt: Number(row.created_at), attemptId: null }))
  }

  /** The attempt that does the requests. */
  takeFollowups(ids: string[], attemptId: string): void {
    const statement = this.#db.prepare('UPDATE followup_requests SET attempt_id = ? WHERE id = ?')
    for (const id of ids) statement.run(attemptId, id)
  }

  /** When the task's newest request was made, or null; attempts before it do not count against the attempt limit. */
  lastFollowupAt(taskId: string): number | null {
    const row = this.#db.prepare('SELECT MAX(created_at) AS at FROM followup_requests WHERE task_id = ?').get(taskId) as { at: number | null } | undefined
    return row?.at === null || row?.at === undefined ? null : Number(row.at)
  }

  dropChannel(channel: string): void {
    this.#db.prepare('DELETE FROM outbox WHERE channel = ?').run(channel)
    this.#db.prepare('DELETE FROM seen_messages WHERE channel = ?').run(channel)
  }

  close(): void {
    this.#db.close()
  }
}

function toRecord(row: Record<string, unknown>): AttemptRecord {
  const record = {} as Record<string, unknown>
  for (const key of KEYS) {
    const value = row[COLUMNS[key]]
    record[key] = value === null || value === undefined ? null : NUMERIC.has(key) ? Number(value) : String(value)
  }
  return record as unknown as AttemptRecord
}

/** One orchestrator per state directory: a lock file with the holder's pid. A stale lock (dead pid) is taken over. */
export function acquireLock(path: string): () => void {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => { try { unlinkSync(path) } catch { /* already gone */ } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = Number(readFileSync(path, 'utf8').trim())
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new Error(`another orchestrator holds ${path} (pid ${holder})`)
      unlinkSync(path)
    }
  }
  throw new Error(`cannot take ${path}`)
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
