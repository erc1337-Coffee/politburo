status: proposed
bonklek decides on this PR.

## Problem

The existing [`Protocol`](../packages/board/src/api/protocol.ts) leases tasks
and settles claims. It does not supervise runs or require a reviewed commit.
On [`local()`](../packages/board/src/server/local.ts),
[`settle`](../packages/board/src/server/tasks.ts) can complete a task and ready
its dependents in one append.

## Proposal

Add a separate Node package at `packages/runtime` for the harness and the
fixture-only first slice. It uses board's public handle, not its tables or
A2. For later managed work, the server task contract owns lifecycle, gates,
and priority. Extend [`boardContract`](../packages/board/src/contract/contract.ts)
and check moves in the task server's conditional append. Labels are filters
or projections, never authority.

### Harness methods (proposed shapes, not SDK calls)

```text
HarnessKind = pi | codex-cli | claude-cloud | subprocess
WorkSpec = immutable { repo, baseSha, briefRef, briefSha256, allowedPaths[],
                       limits: { wallMs, maxCostMicros }, requiredCheckIds[] }
Start = { attemptId, taskId, claimEpoch, work: WorkSpec, provider, model? }
RunRef = opaque adapter handle (not a credential)
State = starting | running | stopping | exited | failed | canceled
Observation = { state: State, cursor, events[], usage: { costMicros } | null }
Result = { outcome: exited | failed | canceled, exitCode?, failure?,
           headSha?, artifacts: [{ ref, sha256 }], usage: { costMicros } | null }
Failure = transient | quota | provider_access | timeout | verification | lost

start(Start) -> RunRef
observe(RunRef, { after?, limit }) -> Observation
send(RunRef, { id, text }) -> accepted | unsupported | not_running
cancel(RunRef) -> void                      # requests stop, does not confirm it
collect(RunRef) -> Result | not_terminal
```

| Contract | Rule |
| --- | --- |
| Identity and replay | One attempt ID per routed try. Same start or send ID and payload does not repeat side effects within the adapter's supported lifetime. Different payload under the same ID conflicts. Reconcile an uncertain start before retrying. |
| State | `starting` → `running` → `exited` or `failed`; Cancel requests enter `stopping` until stop is confirmed, then `canceled` unless the run already ended. Terminal state and collected result stay fixed. An observation error is not an exit. Observations are bounded and resume from the opaque cursor. |
| Adapters | Pi maps session events, prompts and abort. Codex CLI maps process output and uses session input where supported. Claude cloud maps remote session status and control where supported. Subprocess maps output, stdin, process exit and process-tree stop. |

### Managed work boundaries (follow-up, not part of the first slice)

The first slice uses existing task methods and adds no HTTP routes. The
methods and routes below are proposed additions to `Protocol` and [`routes`](../packages/board/src/api/routes.ts).
The types they reuse are defined in `routes.ts`.

| Surface | Shape or invariant |
| --- | --- |
| Task creation | New tasks in server-configured channels start `proposed`, including single create, adoption, and batch. Reject create-and-claim there. Preserve [`batchPlan`](../packages/board/src/contract/task-batch.ts) validation, atomicity and retry semantics. |
| `claimManagedTask`, `POST /runtime/tasks/claim` | `ClaimReadyTaskInput` → `{ task: MessageView, claim: TaskClaim }` or `{ task: null }`. Use existing assignment and owner eligibility. Pick highest authorized priority (1 to 5, 5 highest), then oldest. Managed dispatch starts paused. No claim while paused or without resolved dependencies. |
| `moveManagedTask`, `POST /runtime/tasks/:id/move` | `{ ifVersion, op, ...opFields }` → `{ task: MessageView }`. `authorize` freezes `WorkSpec` at `proposed` → `ready`. `priority` sets the level. `renew` extends the lease; release or expiry returns the task to `ready` or `repair`, whichever it was claimed from. `submit` takes the claim proof, attempt ID and exact head SHA, moves `claimed` → `review`, and closes the lease. `verdict` moves `review` → `approved` on passing checks and a clean verdict for that head, or → `repair` on requested changes. `repair` can be claimed again and needs fresh evidence on resubmission. `finish` moves `approved` → `done` after the server checks the evidence. `resolveEdge` takes a prerequisite ID and accepted evidence; process exit does not resolve an edge. |
| Routing and capacity | Bind route (provider/model), controller and run to the immutable spec and claim epoch. Enforce the wall limit and validate base and changed paths before accepting a submission. Cancel on claim loss. Ignore late results. Retry by failure class after cooldown and within reserved cost; never mark work done. Stop dispatch at 95% of the provider account's five-hour window and wake to recheck at reset. Missing usage blocks paid dispatch. Reserve expiring worker, build, QA and review slots before launch, including host-wide slots for heavy checks. Do not reuse a slot until stop or enforced expiry. |
| Remote work and review | Carry briefs, control, inbox and status on scoped git refs for `acme/web`. Pin brief contents by commit and digest. Check signer, generation and expiry on control writes; refs do not grant authority. A runtime watcher opens a draft PR. It runs checks on the exact head and marks ready only on a passing required check set and a signed clean verdict from a separate reviewer for that head. A new head invalidates both. No merge. |

Reuse swarm's checkout and stop path in [`sandboxes.ts`](../templates/swarm/lib/sandboxes.ts)
and Pi session and lease handling in [`runner.ts`](../templates/swarm/sandbox/runner.ts).
Do not port its role or spend labels.

Reuse factory's thread-keyed wake with the event cursor as a delivery
idempotency key ([`wake.ts`](../templates/factory/agent/lib/wake.ts)) and repo
scoping ([`github.ts`](../templates/factory/lib/github.ts)). Its PR skills
do not enforce server gates.

## Trust model

[`createPolicy`](../packages/board/src/server/policy.ts) verifies the caller and
resolves [`Identity`](../packages/board/src/server/backend.ts).
[`grantAccess`](../packages/board/src/server/grants.ts) applies channel grants
and token narrowing. [`identity.ts`](../packages/board/src/server/identity.ts)
supplies project identity. Discovery is not caller proof.

Check the stored channel, not a channel from the request. Recheck current
access on dispatch and writes. Use [`accessNow`](../packages/board/src/server/policy.ts)
for stored principals and fail closed if it returns no access, including
for stored identities authenticated with a board token.

| Action | Required authority for managed work |
| --- | --- |
| Authorize, raise priority, finish, resolve an edge | Channel `manage`. Finish and edge resolution still need accepted evidence. |
| Claim, lower priority, renew, release, submit | Channel `label` and a controller role bound to the verified principal. Renew, release and submit also require the claim's bound principal and actor, live epoch and secret. |
| Record verdict | Channel `read`, reviewer role, separate principal from the submitter, and a trusted signature over task, attempt, head and verdict. Verify check provenance independently. |
| Run code | The controller keeps the claim secret. A sandbox gets a pinned profile and narrow scope via [`Board.sandboxPolicy`](../packages/board/src/server/board.ts) when needed. Withhold `/runtime` from credential injection in [`sandbox.ts`](../packages/board/src/server/sandbox.ts). A bare subprocess runs trusted fixtures only. |

Roles constrain existing access. They do not grant it. Bind them in trusted
channel configuration, not to a caller-selected profile, label or reply.

Store task decisions in the board log. Keep provider bookkeeping out of it.
[`attempts.ts`](../packages/board/src/server/attempts.ts) counts A2 retries,
not work attempts.

## Migration and compat with existing tasks

No backfill. Existing tasks keep their states, leases, dependency release
and oldest-first claim order. Keep the root and existing `TaskView.state`
vocabulary. Add an optional managed stage for new clients.

Legacy claims skip or reject managed tasks. Legacy writes, including
indirect task transitions from root edits or dependency completion, cannot
bypass managed gates. Managed dispatch requires `runtime_tasks: 1`, a
proposed field in `Discovery`. If it is absent, do not dispatch. The first
managed backend is the fork's `local()` over HTTP.

## Tests

| Scope | Conformance checks to add |
| --- | --- |
| First slice | Run shared conformance checks against a fake and a real fixture process: duplicate start/send, cursor order, early collect, stable result, timeout and child cancellation. Use the [board test harness](../packages/board/test/harness.ts) with real verification against its test issuer. On lease loss, the fixture stops and no settlement lands. |
| Managed follow-up | Race two claims over HTTP. Reject label and profile spoofing, legacy bypass, stale proof, revoked access, and wrong-head or unsigned verdicts. Test priority order and evidence-only edge release. Check that quota reset and slot release unblock dispatch without overbooking. Keep existing [task conformance](../packages/board/test/conformance.test.ts) passing. |

## Alternatives

| Decision | Alternative and cost |
| --- | --- |
| (a) Enforce rules in the server task contract | Labels plus convention avoid protocol changes, but anyone with `label` can rewrite ordinary labels. Clients can disagree or skip gates. Reserved `board.task` is a server projection. |
| (b) Keep runtime separate from `packages/board` | Putting it inside board couples provider dependencies and releases to the core and widens the diff from upstream. A separate package still needs a task contract extension for managed work. |
| (c) Allow fork-only runtime roles | Grants alone either give reviewers broader permissions or fail to distinguish controllers from reviewers. Under [Non-goals for v1 (SPEC.md:4169)](../SPEC.md#L4169), [SPEC.md:4172](../SPEC.md#L4172) reads “Accounts, login, sessions, roles, and moderating others' messages”. Amend that line only: replace “roles” with “roles (except fork-only managed runtime roles)”. |

## Open questions

Which providers expose reliable window usage and replayable events?
Which git host operation can mark ready with a head precondition? Without
one, leave the PR draft.

## Slices

Three small PRs deliver the first slice. No provider integrations,
scheduler, git watcher or managed task changes.

1. Add the runtime package, harness types, and fake adapter conformance.
2. Add the local subprocess adapter for a fixed fixture in a temporary directory. Pass no credentials.
3. Use the public handle's [`board.tasks.claim`](../packages/board/src/client/client.ts) for an explicitly selected task on a local test board. Run one fixture, use the returned claim's `renew` and `release` methods, and stop on lease loss without completing the task.
