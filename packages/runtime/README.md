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

## Remote work

`localGit({ repoDir, identity })` exchanges UTF-8 text files (up to 64 KiB)
under `remote/<agent>/brief`, `control`, `inbox`, and `status`. Use a Git
repo root and keep exchange branches out of the worktree. Read returns the
file and the head it came from. Pass that head to `write`, or `null` to
create a branch with an empty tree. A stale write throws `RefConflict`;
read again before retrying. The store never fetches or pushes. Sync with
ordinary fast-forward Git pushes and fetches. Use `refs/heads/<branch>` on
both sides of the refspec; remote-tracking refs are not read by the store.

```ts
import { ghCodeHost, localGit, reviewGate, watchRemote } from '@remilia/politburo-runtime'
import type { GhOptions, Verdict } from '@remilia/politburo-runtime'

async function pollWork(repoDir: string, token: string, key: Uint8Array,
    verdicts: readonly Verdict[], withHeadLock: GhOptions['withHeadLock']) {
  const refs = localGit({ repoDir, identity: { name: 'Worker', email: 'worker@example.test' } })
  const host = ghCodeHost({ repo: 'acme/web', base: 'main', requiredCheckNames: ['ci'], token, withHeadLock })
  const watcher = watchRemote({ refs, host })
  const result = await watcher.poll({
    statusBranch: 'remote/worker/status', branch: 'work/worker', title: 'Finish worker task',
  })
  if (result.status === 'checked') {
    const gate = reviewGate({ host, key, checkFor: watcher.checkFor, verdictsFor: () => verdicts })
    return gate.markReadyIfAllowed(result.pr)
  }
  return result
}
```

- The worker writes `{"state":"finished"}` to `status.json` after publishing
  its work branch. A missing file or `{"state":"working"}` does nothing.
  Keep one watcher owner per work branch. Polls reuse the existing PR even
  if it has closed. Check results are held by SHA in the watcher instance.
- The GitHub adapter uses `gh` with a caller-supplied token or `exec`. It
  reads the named GitHub check runs for the exact commit; configure CI to
  run on PRs or pushes. It does not dispatch workflows.
- Reviewers call `signVerdict({ sha, reviewer, outcome }, key)`. Pass a
  shared secret from the caller, not from the exchange files. The gate
  returns a typed refusal unless there is a pass and a valid clean verdict
  on the current SHA. A later push needs its own check and review. The gate
  does not convert an already-ready PR back to draft.
- GitHub has no atomic compare-head-and-mark-ready operation. The adapter
  refuses with `readiness_unfenced` unless `withHeadLock` excludes **all**
  head updates through the transition. A local mutex does not fence pushes
  on GitHub. Use a host-enforced immutable head or a coordinated write path
  that can also keep the head fenced if the mutation outcome is uncertain.
