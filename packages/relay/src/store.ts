// Message buffer: one SQLite file. Each channel direction is an append-only
// list with its own sequence numbers. Rows expire and are purged.
import { DatabaseSync } from 'node:sqlite'
import type { Direction } from './protocol.ts'

export interface StoredMessage {
  seq: number
  at: number
  /** The message as compact JSON text. */
  body: string
}

export class MessageStore {
  readonly #database: DatabaseSync

  constructor(path: string) {
    this.#database = new DatabaseSync(path)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS messages (
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (channel, direction, seq)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS messages_expiry ON messages (expires_at);
    `)
  }

  /** Stores one message and returns its sequence number. */
  append(channel: string, direction: Direction, body: string, at: number, expiresAt: number): number {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.#database
        .prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM messages WHERE channel = ? AND direction = ?')
        .get(channel, direction) as { last: number }
      const seq = Number(row.last) + 1
      this.#database
        .prepare('INSERT INTO messages (channel, direction, seq, at, expires_at, body) VALUES (?, ?, ?, ?, ?, ?)')
        .run(channel, direction, seq, at, expiresAt, body)
      this.#database.exec('COMMIT')
      return seq
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Messages after `after`, oldest first. Expired rows are never returned. */
  read(channel: string, direction: Direction, after: number, limit: number, now: number): StoredMessage[] {
    const rows = this.#database
      .prepare('SELECT seq, at, body FROM messages WHERE channel = ? AND direction = ? AND seq > ? AND expires_at > ? ORDER BY seq LIMIT ?')
      .all(channel, direction, after, now, limit) as Array<{ seq: number; at: number; body: string }>
    return rows.map((row) => ({ seq: Number(row.seq), at: Number(row.at), body: String(row.body) }))
  }

  count(channel: string, direction: Direction): number {
    const row = this.#database
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND direction = ?')
      .get(channel, direction) as { n: number }
    return Number(row.n)
  }

  deleteChannel(channel: string): number {
    return Number(this.#database.prepare('DELETE FROM messages WHERE channel = ?').run(channel).changes)
  }

  purgeExpired(now: number): number {
    return Number(this.#database.prepare('DELETE FROM messages WHERE expires_at <= ?').run(now).changes)
  }

  close(): void {
    this.#database.close()
  }
}
