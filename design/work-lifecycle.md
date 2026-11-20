status: proposed
bonklek decides on this PR

# Work lifecycle and authority

## Problem

Tigeryard parity gap 1: tasks can be claimed without scoping. `complete`
settles a lease and releases dependents; only failed tasks can reopen. See
[`createTasks` in `server/tasks.ts`](../packages/board/src/server/tasks.ts)
and [SPEC: Tasks](../SPEC.md#tasks). Discussion is not commit evidence.

## Proposal

Extend the root's [`Task` and `foldMessages`](../packages/board/src/contract/folds.ts)
with typed `task.work_*` events and board-wide `work.control` in
[`boardContract`](../packages/board/src/contract/contract.ts). Use
[`appendFrom`](../packages/board/src/server/writes.ts) at the authority:
decide and append at one log head; reread on conflict. `board.task` stays
reserved and derived, never a gate.

Proposed shapes (wire IDs are strings; times are server UTC):

```ts
type Phase = 'proposed' | 'scoped' | 'handoff' | 'review' | 'qa' | 'repair'
           | 'approved' | 'done' | 'rejected' | 'canceled'
type Priority = 1 | 2 | 3 | 4 | 5 // 1 highest; default 3
type Gate = 'submission' | 'tests' | 'review' | 'browserQA' | 'acceptance' | 'publication'
type ActorKey = { principal: string; actor: string }
type Scope = { project: string; repo: string; rootRevision: number; policyVersion: string }
type ProjectPolicy = { browserQA: boolean; acceptance: boolean; publication: boolean }
// All three switches default to false. The scoped policy version fixes them.
type Assignment = {
  controller: ActorKey; owner: ActorKey // owner of this run, not Task.owner
  provider: string; model: string; session: string
  branch: string; worktree: string; baseCommit: string
}
type Fence = { generation: number; pauseEpoch: number }
type LeaseProof = Fence & { token: string; session: string }
type Packet = { commit: string; packetPath: string; sha256: string }
type Handoff = Packet & { id: string; round: number; generation: number; by: Author }
type Evidence = {
  id: string; taskId: string; round: number; commit: string; gate: Gate
  verdict: 'pass' | 'fail'; artifactRef: string; by: Author; at: string; expiresAt: string | null
}
type Override = Pick<Evidence, 'id' | 'taskId' | 'round' | 'commit' | 'gate' | 'by' | 'at'>
              & { reason: string; expiresAt: string }
type EdgeRelease = { id: string; needId: string; evidenceId: string } // evidence belongs to needId
type WorkView = {
  phase: Phase; priority: Priority; round: number; generation: number
  scope: Scope | null; candidate: Handoff | null
  hold: { reason: string; by: Author } | null; claim: { worker: ActorKey; until: string } | null
}
type Control = { paused: boolean; pauseEpoch: number } // initial: true, 0
type Command = Fence & { id: string; taskId: string; expiresAt: string } // launch only
```

Add strict [route schemas](../packages/board/src/api/routes.ts),
[`Protocol`](../packages/board/src/api/protocol.ts) methods and SDK methods.
Use the existing [`Author`](../packages/board/src/contract/schemas.ts) type.
Paths are relative to `/work/v1`; task writes return `MessageView` with
`TaskView.work` unless noted. `ifVersion` matches `MessageView.version`.

| Route | Body or result |
| --- | --- |
| `GET /tasks/:id` | `?after=&limit=` → `{ task, history, cursor }`; authorized handoffs, evidence, overrides and edge releases |
| `POST /tasks/:id/move` | `{ action: 'scope' \| 'review' \| 'advance' \| 'sendBack' \| 'reopen' \| 'reject' \| 'cancel', ifVersion, rootRevision?, reason? }`; revision required for scope; reason required for send-back, reopen, reject, cancel |
| `POST /tasks/:id/priority` | `{ priority, ifVersion, proof?: LeaseProof }`; proof required for worker |
| `POST /tasks/:id/assign` | `{ for, ifVersion }`; scoper sets an owner profile or null; invalidates offer and lease |
| `POST /tasks/:id/bind` | `Omit<Assignment, 'controller'> & { ifVersion, pauseEpoch, expiresAt }`; store a one-use offer tied to this scope, round and worker |
| `POST /tasks/:id/claim`, `POST /tasks/claim` | Both take `{ pauseEpoch, lease? }`; next also takes `{ channel, label?, from?, wait? }`. Consume the offer → `{ task, claim: LeaseProof & { until }, assignment }` (or `{ task: null }` for next with none). |
| `POST /tasks/:id/{renew,release,submit}` | `LeaseProof` plus `{ lease? }`, `{}`, or `Packet` respectively |
| `POST /tasks/:id/{evidence,override}` | `{ commit, round, gate, verdict, artifactRef, expiresAt? }` or `{ commit, round, gate, reason, expiresAt }`; server supplies IDs, author and time |
| `POST /tasks/:id/{needs,resolve}` | `{ needs, ifVersion }` or `{ needId, evidenceId, ifVersion }` |
| `POST /tasks/:id/{park,unpark}` | `{ reason, ifVersion }` or `{ ifVersion }` |
| `GET /control`, `POST /control` | Admitted callers can read `Control`; an operator writes `{ paused, ifPauseEpoch, reason }` → `Control` |
| `POST /tasks/:id/commands`, `POST /commands/:id/take` | Controller queues `{ ...Fence, expiresAt }` against a live lease → `Command` (one per generation); same controller redeems once → `{ assignment }`. A runtime can claim before launch using a provisioned worker credential. |

| From → to | Server rule |
| --- | --- |
| new → proposed → scoped | Create, adopt and batch start proposed. Scoper pins the current root revision and the repo/policy of the project mapped to the root channel by the host; no create-and-claim. |
| scoped or repair → implementation (live lease on that phase) | Claim needs resolved edges, no hold, open control and a matching offer. Claim-next uses priority first, then existing assigned-before-pool and oldest-root tie breaks. Keep `for` and `from` semantics; labels may filter only. Release/expiry exposes the same phase without its lease. |
| implementation → handoff → review | Submit with a live proof; append an immutable handoff and submission evidence pointing to it, then close the lease in the same write. Reviewer starts review. |
| review → qa or approved | Passing tests and an independent review on the candidate; skip QA if neither browser QA nor acceptance is enabled. |
| qa → approved → done | Require enabled browser QA and acceptance to approve; require publication to mark done if enabled. |
| review / qa / approved → repair | Send back with a reason; retire the candidate and increment the round. |
| done / rejected → proposed | Reopen with a reason; increment the round, retire the candidate and require fresh scope. |
| Any nonterminal phase → rejected or canceled | Authorized reject or cancel with a reason; end any lease and pending dispatch. Deleting the root cancels open work and prevents use as a prerequisite. |

| Invariant | Check at authoritative write |
| --- | --- |
| Scope and gates | An open task's root edit (including sync) clears scope and candidate, ends the lease and returns it to proposed in a new round, retaining any hold. At each forward move recheck all gates due so far: latest verdict is a nonexpired pass, or an explicit nonexpired override for that gate, task, round and full commit ID. An override cannot invent a handoff. Expiry blocks future moves, not the recorded phase. |
| Evidence and handoff | Packet path is repo-relative at the named commit; digest is SHA-256 of the packet bytes. The recipient verifies the digest before use. Handoffs, attestations and overrides are append-only; overrides record who waived which gate and why. |
| Dependency | `resolve` needs a current, nonexpired passing evidence record (not an override) from the approved/done prerequisite's current candidate. Completion never writes a release. Reopen, send-back, deletion or superseded/expired evidence invalidates it. Check edges at claim, dispatch, renew, submit and advance. A lease pins release IDs; replacing one requires a fresh claim. Check cycles even through completed nodes. |
| Claim fence | Reuse the task's lease `epoch` as generation. On worker writes check the live lease, exact worker, session, generation, board pause epoch and secret hash. Rebind, park or retire the work ends the lease; a fresh claim advances generation. No token/hash in reads or feed. |
| Operator hold | Park overlays the phase, blocks moves other than cancel, and ends any offer, lease and pending dispatch. Unpark resumes the underlying phase (proposed if edited while parked), not its lease. Recheck guards on the next move. |
| Network pause | Pause advances the persisted board epoch, canceling pending commands and offers and fencing leases from the prior epoch. Resume revives none. Bind, claim, enqueue and take require the current unpaused epoch in the deciding append. Long polls keep their starting epoch. Take checks the live lease and is the dispatch boundary; already admitted work may still run but cannot write under the old lease. A message is never a launch ticket. |

## Trust model

Use verified [`Identity` / `VerifiedCaller`](../packages/board/src/server/backend.ts)
from [`createPolicy`](../packages/board/src/server/policy.ts) and effective
[`grantAccess`](../packages/board/src/server/grants.ts), including `x-board-can`.
The host maps channels to projects and pins roles to verified principal IDs.
Serialize grant edits with local lifecycle writes; recheck access against the
stored channel on each attempt, including long polls.

| Actor | Required authority in addition to an authenticated identity |
| --- | --- |
| Worker | `label`, matching controller offer and `for` if set. May only lower priority on its live claim. Use separate principals for privileged roles and untrusted workers; if workers share a principal, isolate profiles and tokens with the [sandbox policy](../packages/board/src/server/sandbox.ts). |
| Controller | Project controller role + `label`; offer and dispatch for its own bindings. Provider/model/session/branch/worktree/base commit are controller attestations, not credential claims. |
| Scoper | Project scoper role + `manage`; scope, assign, raise/lower priority, change needs, resolve edges (also `read` on prerequisite), reject, cancel and reopen. |
| Attesters | Gate-specific project role + `read` and `post`: CI for tests, reviewer for review, QA for browser QA, acceptor for acceptance, publisher for publication. Reviewer must differ from the submitter by principal. Reviewer starts review; reviewer or QA sends work back; scoper advances once gates pass. Submission is written only by the bound claimant. |
| Operators | Project operator + `manage` parks/unparks or overrides; separate board operator allowlist + `manage` everywhere controls pause. No implicit role for an owner, `manage`, or the board's deployment. |

Unreadable roots stay 404; missing and unreadable prerequisites look alike.
Redact cross-channel evidence pointers without `read`; limit runner metadata
to controller and claimant. Replies and sync imports cannot attest. Wrong
authority is 403; stale proofs, closed gates, or pause are 409 with no write.

## Migration and compat

Opt in per board on [`local()`](../packages/board/src/server/local.ts),
initially paused. [`http()`](../packages/board/src/server/backend-http.ts)
forwards to the authority. Advertise `workLifecycle: 1` in discovery;
unsupported backends (including [Vercel](../packages/board/src/server/backend-vercel.ts))
return `501 no_work_lifecycle` on new methods. Never emulate it in a client.

| At cutover | Behavior |
| --- | --- |
| Existing tasks | Stop writers, drain or revoke leases, then append a durable cutover marker and replayable per-root upgrades before reopening writes. Preserve IDs, threads, owner, `for`, needs and history. Waiting/ready/claimed/failed → proposed; blocked → proposed with hold; completed → historical done without evidence; canceled → canceled. All migrated edges start unresolved. Reopen historical done to supply evidence. |
| Existing readers | Add optional `TaskView.work`; keep `TaskState`/`board.task` as compatibility projections: hold → blocked; recorded lease → claimed; scoped/repair with releases recorded for all edges → ready; done → completed; rejected → failed; canceled → canceled; otherwise waiting. These hints may be stale with time, pause or changes to a prerequisite. |
| Existing writers | Keep create/adopt/batch and their retry semantics, but reject create-and-claim before writing. Old claim/renew/settle/block/assign/needs/reopen/cancel writes return `409 work_lifecycle_required` on enabled boards. Disable legacy timers and task side effects there, including edit/delete paths; use the new policy instead. No mixed-version writers or downgrade after cutover; disabled boards keep legacy semantics. |

## Tests

Add a capability-gated `work-lifecycle` group beside [`tasks` conformance](../packages/board/src/conformance/index.ts) and multi-principal HTTP tests in the [board harness](../packages/board/test/harness.ts).

| Check | Observable result |
| --- | --- |
| Authority and ordering | Create/adopt/batch cannot self-scope or claim; label edits do not change priority; lower-only worker; highest eligible wins and a concurrent claim has one winner. Narrowed, revoked, spoofed-profile and same-principal review attempts fail. |
| Gates and history | Wrong commit/round, expiry and a newer fail deny advance; optional gates can be enabled independently; override is visible; send-back and reopen cannot reuse old evidence; handoff bytes differing from the recorded digest are refused by the reader. |
| Dependencies | Completion leaves the edge closed; explicit resolution opens it; reopen/expiry closes it; edge replacement fences stale leases; unreadable refs and cycles are refused. |
| Fences | Rebind, park, expiry and pause/resume reject stale writes; unpark restores prior phase; race pause with claim and command take; replay an old command after resume and restart. |
| Compatibility | Upgraded log replays with the same roots, no invented evidence and no claim bypass; legacy `tasks` suite stays green on disabled boards; unsupported backends fail explicitly. |

## Alternatives

- **(a) Server task contract** over labels plus a convention. Anyone with
  `label` can write ordinary labels. Server enforcement costs API, fold and
  backend changes; the convention costs reliable gates, priority and fencing.
- **(b) Separate runtime package** over runtime inside `packages/board`.
  Separation costs a versioned API boundary; in-package runtime adds
  provider/process dependencies and more drift from upstream vercel/board.
- **(c) Fork-only lifecycle roles** over grants alone. Replace only
  [SPEC.md line 4172](../SPEC.md#L4172) under “Non-goals for v1” with:
  “Accounts, login, sessions, roles (except fork-only task lifecycle roles),
  and moderating others’ messages.” Roles cost policy administration;
  grants alone cost separation of duties.

## Open questions

- Who supplies each project's attesters and evidence TTLs?
- What audit retention is required before remote backends can opt in?

## Slices

1. Versioned contract, projections and cutover fixtures; keep activation disabled.
2. Role checks, scope, priority and fenced claims on local/HTTP.
3. Immutable handoffs, evidence gates, send-back and reopen.
4. Evidence-backed dependencies and operator park/unpark.
5. Pause and command fence, race/conformance coverage, then enable opt-in. No runtime in these PRs.
