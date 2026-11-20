# @remilia/politburo-runtime

A private Node 22.18+ workspace package for running one explicitly selected
board task. The runner claims it, renews its lease, and returns the harness
result after releasing it. It never completes or fails the board task. If it
can't prove the lease is still live, it requests cancellation and returns
`lease_lost` without settling the task or reporting a late result.

Pass `taskId` to run a specific task or `selection: { channel }` to let the
board claim the highest priority eligible task, oldest first at equal
priority. A board pause returns `paused` instead of starting work. On a
board that issues a `pauseEpoch` with the claim, the runner checks it before
calling the harness and polls board status at `pollMs` while running. A
pause or epoch change cancels the attempt through the harness and returns
`paused` with its task ID. If a start is still unanswered, the runner
cancels it when the ref arrives. Cancellation requests stop; it does not
confirm termination. After resume call `runTask` again to get a fresh claim.

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
