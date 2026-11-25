// Files of one worker run, outside the repository: $HOME/.politburo_worker/<channel>/.
// Every write goes to a temporary file first and is then renamed.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CommandCursor {
  /** The relay sequence number of the last command that was carried out. */
  lastSeq: number
  /** Envelope ids of carried-out commands, newest last. */
  processed: string[]
}

const PROCESSED_KEPT = 500

export class WorkerFiles {
  readonly directory: string

  constructor(channel: string, root = process.env.POLITBURO_WORKER_HOME ?? join(homedir(), '.politburo_worker')) {
    this.directory = join(root, channel)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    chmodSync(this.directory, 0o700)
  }

  path(name: string): string {
    return join(this.directory, name)
  }

  #write(name: string, text: string, mode = 0o600): void {
    const file = this.path(name)
    writeFileSync(`${file}.tmp`, text, { mode })
    renameSync(`${file}.tmp`, file)
  }

  #read(name: string): string | null {
    try {
      return readFileSync(this.path(name), 'utf8')
    } catch {
      return null
    }
  }

  readToken(): string | null {
    return this.#read('token')?.trim() || null
  }

  writeToken(token: string): void {
    this.#write('token', `${token}\n`)
  }

  readCursor(): CommandCursor {
    try {
      const value = JSON.parse(this.#read('cursor.json') ?? '') as CommandCursor
      if (Number.isSafeInteger(value.lastSeq) && Array.isArray(value.processed)) return value
    } catch { /* first run */ }
    return { lastSeq: 0, processed: [] }
  }

  writeCursor(cursor: CommandCursor): void {
    this.#write('cursor.json', JSON.stringify({ lastSeq: cursor.lastSeq, processed: cursor.processed.slice(-PROCESSED_KEPT) }))
  }

  readJson<T>(name: string): T | null {
    try {
      return JSON.parse(this.#read(name) ?? '') as T
    } catch {
      return null
    }
  }

  writeJson(name: string, value: unknown): void {
    this.#write(name, JSON.stringify(value))
  }

  /** One status line for the `status` command and for the session operator. */
  status(line: string): void {
    appendFileSync(this.path('status.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  }

  exists(name: string): boolean {
    return existsSync(this.path(name))
  }
}
