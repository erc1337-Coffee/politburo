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

## Routed attempts

`createRouter` takes a server-owned executor and a list of provider/model pairs
with per-attempt token cost caps in micros. It reads `boardScoreboard` once per
call and ranks by `quality`, `cost`, or `latency`. Specify the task's budget,
paths, base commit, and required checks in `work`; the router freezes that
contract across retries. The router returns a verified candidate or a stopped
reason. It does not change the task state or own its claim.

```ts
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { boardScoreboard, createRouter, registerScoreboardSchema } from '@remilia/politburo-runtime'

const team = board({ backend: local({ memory: true }) })
const writer = team.as('router')
await registerScoreboardSchema(team) // setup with schema-registration permission
const scoreboard = boardScoreboard({ board: writer, channel: 'runtime/scoreboard', author: (await writer.me()).actor })
const route = createRouter({
  scoreboard,
  models: [{ provider: 'fixture', model: 'small', maxCostMicros: 10 }],
  maxAttempts: 2,
  cooldownMs: { quota: 30_000, auth: 60_000, timeout: 5_000 },
  probeTimeoutMs: 1_000,
  execute: async () => ({ outcome: 'bad-output', costMicros: 0 }), // fake, no provider call
})
const outcome = await route({
  taskId: 'fixture-task', mode: 'quality',
  work: {
    repo: 'acme/web', baseSha: '1'.repeat(40), briefRef: 'fixture-brief', briefSha256: '2'.repeat(64),
    allowedPaths: ['src/', 'README.md'], requiredCheckIds: ['test'],
    limits: { wallMs: 30_000, maxCostMicros: 20 },
  },
})
console.log(outcome.status, await scoreboard.read())
```

Use a dedicated scoreboard channel and restrict its writers. Attempt samples
are ordinary, unsynced board blocks, attributed by the board. Reads ignore
other actors and use the latest 100 messages by default. The same writer can
replay an attempt ID without double counting it.

The executor owns cancellation, in-flight cost enforcement, and evidence from
an actual checkout and verifier. A returned result must mean the run stopped.
On `execution-uncertain` or a board write error, reconcile the previous run
before calling again. Use a caller-held lease around routing; the existing
`runTask` helper is not a routed executor and its fixture adapters do not meter
tokens or produce verification evidence. The budget covers one call and its
retries. Cooldowns and access incidents are in memory. An auth incident gets
one access probe after cooldown, if configured; only a successful probe clears
it. A failed probe leaves the provider unavailable in that router instance.

## ops

`refill` drafts up to 15 proposed tasks when the ready queue runs low. `scanDiff` and `preflight` refuse added lines with tokens, keys, or emails. `createInstance` writes a self-hosted instance directory with no credentials. `writeResumePacket` and `appendAttempt` keep resume packets and an attempt ledger as plain files.

## Dispatch policies

```ts
import { capacity, localUsage, usageGuard } from '@remilia/politburo-runtime'

const guard = usageGuard(localUsage({ file: '/var/run/politburo/usage.json' }))
const pool = capacity({
  limits: { worker: 4, build: 2, qa: 2, review: 1 },
  heavy: { directory: '/var/run/politburo/slots', slots: 2 },
})
// Pass usageGuard: guard and capacity: { policy: pool, kind: 'build', heavy: true }
// to runTask alongside the normal runner options.
```

Both policies are optional and run before a board claim. The usage guard reads
`{ "usedFraction": 0.95, "resetAt": 1767243600000 }` for the five-hour window;
`resetAt` is Unix time in milliseconds. It returns `usage_blocked` at 95% or
more until that time. An expired snapshot doesn't block the new window. A read
or parse error rejects dispatch. Use a custom `UsageSource` or pass
`{ command, args }` to `localUsage` to read JSON from a trusted local command's
stdout. The adapter passes `PATH` and `HOME`, uses no shell, and calls no API.

Share one capacity policy instance for per-kind limits. The default run kind is
`worker`. Mark heavy work explicitly with `heavy: true`. For machine-wide
heavy slots, configure all processes with the same trusted local directory and
slot count. A full pool returns `capacity_unavailable` without waiting. If a
process is killed before cleanup, remove any stranded slot directory only after
confirming its run is no longer active.

The runner releases capacity on every outcome, including errors and lease loss.
If the lease is lost during start, a runner with a reservation waits for start
to reject or to return a ref it can cancel before it frees the reservation.
