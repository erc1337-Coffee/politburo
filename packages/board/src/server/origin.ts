// Where a write comes from and how to answer it, as a backend receives it: no write path here,
// so the protocol's types can name it without loading the local board's engine.
import type { WriteSource } from './middleware.ts'

/** Where a write came from: `middleware` is the middleware's own client, which skips it. */
export type Via = WriteSource | { kind: 'middleware' }

/**
 * How a write reaches the middleware: where it's from, and how to answer there. `schedule` marks a
 * schedule's send, which a backend's own schedules set in-process: no request carries it.
 */
export type WriteOrigin = {
  via?: Via
  respond?: (text: string) => Promise<void>
  schedule?: { id: number; n: number }
  /** The work epoch in which this in-process schedule send was admitted. Never taken from HTTP. */
  scheduleEpoch?: number
  /** Epoch held before screening a local create-and-claim. Never taken from HTTP. */
  claimEpoch?: number
}
