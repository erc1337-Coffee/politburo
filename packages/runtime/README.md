# @remilia/politburo-runtime

A private Node 22.18+ workspace package for running one explicitly selected
board task. The runner claims it, renews its lease, and returns the harness
result after releasing it. It never completes or fails the board task. If it
can't prove the lease is still live, it requests cancellation and returns
`lease_lost` without settling the task or reporting a late result.

```ts
import { createHash } from 'node:crypto'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { pi, runTask } from '@remilia/politburo-runtime'

const team = board({ backend: local({ memory: true }) })
const brief = 'Summarize this fixture.'
const { task } = await team.tasks.create('fixtures', brief)
const outcome = await runTask({
  board: team, taskId: task.id, provider: 'pi',
  harness: pi({ readBrief: () => brief, idleMs: 30_000, models: ['codex-cursor'] }),
  work: {
    repo: 'acme/web', baseSha: '0'.repeat(40), briefRef: task.id,
    briefSha256: createHash('sha256').update(brief).digest('hex'),
    allowedPaths: [], limits: { wallMs: 60_000, maxCostMicros: 0 }, requiredCheckIds: [],
  },
})
```

- `fake()` is in memory. `subprocess({ command, args })` runs a fixed command
  with stdin and stdout/stderr. `pi()` verifies the brief digest and writes a
  private task file; it defaults to `pi-task <task-file> [max-seconds]` with the
  selected model in `PI_MODEL`. Use `args` for wrappers that select models by
  flags. It retries eligible failures with the next model, within one wall
  deadline, and has no live stdin.
- The process adapters require POSIX and use a temporary working directory,
  a scrubbed environment, and process-group termination. Pi takes an explicit
  `env` object if the command needs it. Only run trusted commands: a process
  group and temporary home are not a sandbox. Output is returned verbatim to
  the caller, not logged; commands must not print secrets.
- Replay and output cursors last for the adapter instance. Output is paged but
  retained in memory; use this slice for bounded fixtures. Cancel requests
  stop; collect confirms it. There is no checkout, cost enforcement, artifact
  validation, or task settlement. `@remilia/politburo-runtime/conformance`
  exports the shared Node test suite for adapters.

## Controller loop

`runController()` follows the event long-poll on a board handle bound to the
agent's inbox principal. It reads `operationalInbox` after each feed page,
including empty pages: the generic feed does not expose private inbox mail.
Feed requests are serial and start at least one configured long-poll interval
apart, even when a page returns early.

Pass the agent's inbox address, roles, a `parentOf(agent)` adapter, a monotonic
clock, and an abort signal. The registry adapter maps the inbox identity to the
registration and returns the immediate parent's inbox address or `null`.
The loop records `seen` before calling `wake`. Return `'acted'` only after the
work is done. Returning nothing or throwing leaves the message eligible for
escalation. The board authors receipts and escalation provenance.

The deadline starts when the loop first observes an unacted message, even if
the handler is still running. At the deadline the loop checks the inbox once
more. It sends one reference to the immediate parent only if the message is
still visible and unacted. It does not forward private message text. The check
and send are separate board calls, not an atomic operation. Wake and escalation
deduplication are local to the invocation. The loop does not persist checkpoints
or coordinate multiple instances.
