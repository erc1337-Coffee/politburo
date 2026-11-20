status: proposed
bonklek decides on this PR

## Problem

Gap 2 in TIGERYARD-PARITY: `vb tasks block --kind needs_input|awaiting_approval`
records a reason and ends the claim. A reply binds neither option nor commit.
`unblock` neither checks the reply nor routes work. See
[SPEC.md: Blocking for a person](../SPEC.md#blocking-for-a-person),
[`TaskHoldKind`](../packages/board/src/contract/schemas.ts#L170-L175), and
[`BlockTaskBody`](../packages/board/src/api/routes.ts#L392-L400).

## Proposal

Keep one current request on the task root. Bind it to the lifecycle contract's
recorded commit and generation, not a live Git head. A later gate may spend the
receipt only against that same work.

Proposed wire shapes use `Ref`, `MessageView.revision`, `TaskClaim`, and
`TaskView` from [`api/routes.ts`](../packages/board/src/api/routes.ts), and
`Author` from [`contract/schemas.ts`](../packages/board/src/contract/schemas.ts).

```ts
type WorkRef = { commit: string; generation: number } // full object ID, not a branch or short SHA
type AttentionDraft = {
  kind: 'needs_input' | 'awaiting_approval'
  question: string
  context: string
  options: { id: string; label: string; consequence: string; next: 'resume' | 'cancel' }[]
  evidence: { message: Ref; revision: number }[] // live messages in this task's thread
  expiresAt: string                           // future ISO instant
  work: WorkRef
  revision: number                            // root revision the requester read
}
type RequestAttentionBody = AttentionDraft & {
  claim?: Pick<TaskClaim, 'epoch' | 'token'>
  replaces?: Ref                              // current request ID, if replacing one
}
type AttentionAnswerBody = { option: string; commit: string }
type AttentionReceipt = {
  option: string
  by: Author                                  // server-authored, as is the requester
  at: string
  routedTo: 'ready' | 'waiting' | 'canceled'    // state at the answer, not today's state
}
type AttentionView = AttentionDraft & { id: Ref; by: Author } & (
  | { status: 'pending' | 'stale' | 'canceled' }
  | { status: 'answered'; receipt: AttentionReceipt }
)
```

Strict bodies. Use `storable` text, `TaskNote` limits for question, label and
consequence, and at most 4,000 characters of context. Take 2 to 8 options with
distinct IDs of up to 64 characters, and 1 to 8 evidence refs. Fetch no URLs.

| Route | New `Protocol` method | Input besides path refs | Answer |
| --- | --- | --- | --- |
| `POST /tasks/:id/attention` | `requestTaskAttention` | `RequestAttentionBody` | 201 `{ task: MessageView, attention: AttentionView }` |
| `GET /tasks/:id/attention` | `taskAttention` | none | 200 `{ attention: AttentionView \| null }` |
| `POST /tasks/:id/attention/:requestId/answer` | `answerTaskAttention` | `AttentionAnswerBody` | 200 `{ task: MessageView, attention: AttentionView }` |

Add to [`routes`](../packages/board/src/api/routes.ts#L1199),
[`Protocol`](../packages/board/src/api/protocol.ts), and the handle's `tasks`.
`TaskView.attentionId?: Ref` points to the latest request.

| Write or condition | Checks and effect |
| --- | --- |
| Open from ready, waiting, or claimed | Match work, root revision and evidence revisions. Record an immutable request ID and the task epoch. Set `blocked` with the question as its reason. End any claim. |
| Open on a plain human hold | The same snapshot checks apply. Owner or channel `manage` can convert a `needs_input` or `awaiting_approval` hold. Other holds, including `edited`, are not converted. |
| Replace a pending or stale request | Owner or channel `manage` must name the current ID in `replaces`. Check the new snapshot as on open. Keep the hold. The old ID is stale. |
| Answer a pending request | Match the current ID, commit, work generation, task epoch, root revision and live evidence revisions. On each write attempt, require server time strictly before `expiresAt`. An unknown option is 400 `invalid_request`. |
| Route `resume` | Clear the hold. Set `ready` if current prerequisites are met, or `waiting` if not. Keep the assignment. If another lifecycle gate bars the route, return 409 `attention_route_blocked` and write nothing. Never restore the old lease. |
| Route `cancel` | Clear the hold and cancel with the option's consequence as the reason. Dependents stay waiting. |
| Expired, changed, replaced, canceled, or already answered | Refuse the answer with 409 `attention_stale`. Expiry or a changed snapshot leaves the task blocked. Reread for the latest status or receipt. |
| Legacy `unblock`, cancel, or root delete | `unblock` on a structured hold returns 409 `attention_required`. Cancel or delete closes an unanswered request in the same write. |

Reuse [`server/tasks.ts`](../packages/board/src/server/tasks.ts)'s `changeTask`,
`fenced` and `satisfied`. Recheck one snapshot per
[`appendFrom`](../packages/board/src/server/writes.ts#L620-L626) attempt.
Add `task.attention_requested` and `task.attention_answered` to
[`BoardEvent`](../packages/board/src/contract/events.ts). Each folds into
[`Task`](../packages/board/src/contract/folds.ts#L19) with its hold or route.
History stays in the log. No watcher applies answers. Never log claim tokens.

## Trust model

[`Policy.identify`](../packages/board/src/server/policy.ts) supplies
[`Identity`](../packages/board/src/server/backend.ts#L15-L19).
[`grantAccess`](../packages/board/src/server/grants.ts#L129-L146) accounts for
channel grants, caps and token narrowing. [`ProjectIdentity`](../packages/board/src/server/identity.ts)
names the host project and team. Discovery is not caller proof.

| Action | Server checks |
| --- | --- |
| Read | All routes need `read` on the task's channel. An unreadable root is 404. Details and events use the same channel filter. |
| Open or replace | As `block`: a live `epoch` and `token` for a claimed task, otherwise its owner (`ownedBy`, with `post` or `label`) or channel `manage`. An option that cancels also needs the existing cancel authority, even with a claim. |
| Answer | Effective `read` and `post` in the channel, and a verified `person` acting as itself whose principal ID is in the server-configured `attention-responder` role for that channel. Neither `manage` nor a claim substitutes for the role. |

Roles add no channel access. A profile, handle, sync author, or request field
cannot confer the role. Do not give agents a responder's credential. Grants
are checked per request, not in a transaction across the access and board logs.

## Migration and compat

No backfill. Plain holds and replies still work. Replies never answer a request.
Replay with [`foldMessages`](../packages/board/src/contract/folds.ts) into
versioned tables and [`messagesReducer`](../packages/board/src/contract/reducers.ts).
Keep `board.task` derived. Upgrade all writers before enabling writes.

Enable on `local()` first. `http()` forwards to the authority. If discovery
omits `task_attention: true`, do not send a structured write. Updated
unsupported backends, including `vercel()`, return 501 `no_task_attention`.
Do not fall back to a plain hold.

## Tests

Add an optional conformance group beside
[`tasks.block`](../packages/board/src/conformance/index.ts#L1458-L1475).
Use real HTTP for races, a controlled clock for expiry, and distinct verified
principals. Skip the feature checks on unsupported boards.

| Check | Expected result |
| --- | --- |
| Open with a live claim, then try the old token and both claim paths | Old token is `claim_lost`. No claim while held. |
| Race two answers, then resend the winner | One receipt and one routed transition in the feed. The loser and resend get `attention_stale`. |
| Expire, edit root or evidence, change work, replace, or cancel | Old answer is `attention_stale` with no write. Test both generations of the same commit. |
| Resume with an unmet need, resume with all met, cancel | Answer and destination show together. Cancel releases no dependent. |
| Try read-only scope, wrong principal, profile, label, or synced reply | No answer. Unreadable task is 404. Legacy unblock cannot lift the structured hold, even for `manage`. |
| Replay the log; read an old task; call an unsupported backend | Same receipt and task state after replay. Plain block and unblock still work. Unsupported writes make no change. |

## Alternatives

| Decision | Alternative and cost |
| --- | --- |
| Enforce lifecycle, gates and priority in the server task contract. | Labels plus convention save contract changes, but anyone with `label` can write ordinary labels. Even label `if` cannot check a commit, responder or route. Reserved `board.*` labels stay derived. |
| Keep any runtime in a separate package. | Putting it in `packages/board` couples dispatch and provider changes to the board package. It widens the diff from upstream `vercel/board`. |
| Allow roles as a fork-only extension. | Existing grants alone avoid role config, but require broad `manage` or let ordinary posters answer. |

For roles, amend [SPEC.md:4172](../SPEC.md#L4172) (`Accounts, login, sessions,
roles, and moderating others' messages`) and
[764–768](../SPEC.md#L764-L768) (`Authorization in v1`) to name the fork-only
task action check. Keep profile permissions and channel grants unchanged.
For attention, add exceptions at [3625–3628](../SPEC.md#L3625-L3628),
[3687–3689](../SPEC.md#L3687-L3689), [3698](../SPEC.md#L3698),
[3874–3887](../SPEC.md#L3874-L3887), [4015–4016](../SPEC.md#L4015-L4016),
[4041–4044](../SPEC.md#L4041-L4044), and [4134–4137](../SPEC.md#L4134-L4137).
The structured fields are not a general task `data` field.

## Open questions

- Should a channel cap the request lifetime?
- Should the inspector surface expired requests before other holds?

## Slices

1. Add event and view shapes against the lifecycle work binding. Test replay.
2. Add local open, read, and replace behind a disabled feature flag.
3. Add the responder check and atomic answer. Add race and stale checks.
4. Wire HTTP, discovery and the SDK. Run conformance over HTTP before opt-in.
5. Add CLI commands to open, read and answer.

Leave [`batchPlan` and `BatchNeed`](../packages/board/src/contract/task-batch.ts)
unchanged. Batch creation does not open requests.
