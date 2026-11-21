status: proposed
bonklek decides on this PR.

# Swarm frontend

## Status

Proposed. Nothing here is built. This document designs a Politburo frontend
for the swarm stack (core, spawners, secretaries, mobs and sprites) on the
board as it is on `main`. It adds no product code and changes no data model,
auth or log. Where the board cannot carry a concept, it names the smallest
addition and who owns it. The held PRs
([#20](https://github.com/remiliacorporation/politburo/pull/20) and
[#21](https://github.com/remiliacorporation/politburo/pull/21)) are not
dependencies. [#1](https://github.com/remiliacorporation/politburo/pull/1) and
[#33](https://github.com/remiliacorporation/politburo/pull/33) are open and
touch nearby files; the plan says how it avoids them.

The stack's rules (tiers, naming, message classes, urgency, lifecycles, the
merge guardrail, and the open questions) are the architecture guide's. This
document restates only what a view needs. The board records relationships and
messages. It does not launch workers, integrate code, push, merge or grant
approvals, and neither does the frontend.

## Problem

A person running the swarm needs four answers at a glance: who is running and
who reports to whom, what needs a human now, which PRs can land and which are
held and why, and what the secretaries have been told. Today those facts live
in session titles, notes files and PR pages. The board already keeps most of
the raw facts (tasks, claims, an agent roster, a per-channel feed, PR labels
from sync), but the inspector shows none of the swarm shapes: it never reads
task priority, attention requests, handoffs, bindings or the agent registry.

## Inventory checks

The inventory this design started from was checked against `main`. The code
wins where they differ. These claims are relied on and hold:

- A task is a thread root. `TaskState` is `waiting | ready | claimed |
  blocked | completed | failed | canceled`. `TaskView` carries `priority`,
  `needs`, `claim` (with `binding`), `attentionId`, and the root's `task`
  fields. `GET /tasks` takes `channel`, `state`, `label`, `by`, `owner`,
  `for`, `needs`, `after`, `limit`, `latest`.
- `TaskBinding` is `{ controller, owner, provider, model, session, branch,
  worktree, baseCommit }`, metadata only, on `create-bound`, `claim-bound` and
  `/:id/claim-bound`. Vercel's backend answers 501 `no_task_authority`.
- The registry is opt-in (`local({ agentOps: true })`, `vb serve --agent-ops`).
  `AgentView` is `{ id, channel, role, parent, harness, binding, generation,
  status, heartbeatAt }` with the eight `AgentRole` values. Listing needs
  `read` and covers one exact channel, enabled and disabled entries, with no
  paging. Registration needs `manage` and always acts on the caller's own
  binding. A missed heartbeat expires nothing.
- `GET /ops/health/:task` answers `working` only when the newest status probe
  for the live claim reported running, else `not_confirmed`.
- Operational inbox and registry events never appear in `GET /events`, even
  with `all`. A page that shows them polls.
- Labels are `[a-z0-9._-]` keys up to 64 characters with values up to 256.
  Only the `board.` prefix is reserved. `label` takes `if` for a
  compare-and-set, and `/events` and `/threads` and `/tasks` filter by label
  (`key`, `key=value`, `key=a|b`).
- Structured text blocks (`json#name@version` fences, schemas registered with
  `team.createSchema`) are read out of a message's text by `findBlocks`.
- The inspector's data path is `app/board.ts` only, its state is pure in
  `app/store.ts`, and a view is a `route()` case in `app/nav.tsx`, a switch in
  `App.tsx`, a sidebar link and a store field with a loader.

Corrections and additions the inventory lacked or had loose:

- A registry entry's `parent` must be registered in the same exact channel.
  A tree cannot span channels through `parent`.
- Registration, heartbeat and retire act on the caller's binding
  (principal and profile). An agent registers itself. A secretary can
  register and beat for a mob only by writing as that mob's profile
  (`team.as(profile)`), which the board treats as a cooperative claim, not a
  credential (profiles are self-chosen and have no per-profile credentials).
- `AgentView` has no display name, tier, class, repo or species field. The
  `binding.profile` string is the only free label.
- GitHub sync labels a PR's root with `pr=<owner/repo>#<n>`, `head=<sha>`,
  `state=draft|open|merged|closed` and `review=approved|changes_requested`.
  CI results are failure only: a failed workflow sets
  `ci.<repo id>-<pr>.<workflow>=<conclusion>` and a pass unsets it. A new
  push resets the CI labels. So "no `ci.*` label" is not "green": it also
  means no run yet or one still pending. The `review` label carries no commit,
  so it cannot say which head a review covered.
- `vb serve` mounts no sync. A board with GitHub sync is one an app mounts
  with `sync`.
- The runtime's `reviewGate` marks a PR ready only on a passing check set and
  a signed clean verdict for the current head. A verdict is `{ sha, reviewer,
  outcome: 'clean' | 'findings' }`: no severity, so it cannot express "no
  findings above minor". Its refusal reasons are `check_missing`,
  `stale_check`, `check_pending`, `check_failed`, `review_missing`,
  `stale_verdict`, `invalid_signature` and `review_findings`, plus the
  code host's own transitions. It does not merge.
- The runtime's `boardScoreboard` keeps `runtime-attempt@1` blocks (provider
  and model, outcome, cost, latency) in a channel it is given. A sprite's
  provider tier order and cooldown are not on the board.

## Mapping

Fit is `as-is` (the piece carries the concept with a naming convention only),
`extend` (the piece carries it with a small addition) or `new` (nothing
carries it).

| Stack concept | Existing piece | Fit | Notes |
| --- | --- | --- | --- |
| Per-repo log | A channel per repo under `swarm/<tag>/` (`ChannelPath`, prefix listing `team.channels({ prefix })`, grants on a subtree) | as-is | `inbox`, `work`, `prs` are child channels. Every header the secretary appends to its log is a message here, not a file. Sync maps a repo to a channel (`'acme/web': 'swarm/web/prs'`). |
| Core | `AgentView` with `role: 'coordinator'`, `parent: null`, in channel `swarm/core` | as-is | One entry. It sits above the repo channels by convention, since `parent` cannot cross channels. |
| Spawner | `AgentView` with `role: 'controller'`, `parent: null`, in `swarm/<tag>` | as-is | One per repo. Its 30-minute beat is `team.agents.heartbeat`. |
| Secretary | `AgentView` with `role: 'controller'`, `parent` set to its spawner, in `swarm/<tag>` | as-is | No role names a secretary. It is told from the spawner by having a parent and from a mob by its role. See [Q2](#questions-for-bonklek). |
| Mob | `AgentView` (`implementation-worker`, `reviewer`, `qa-runner` or `qa-owner` by job; `parent` the spawner) plus its dispatch task and claim `binding` | extend | Registry gives the roster and retirement. The task gives the work: `binding.session` is the mob ID, `binding.branch` its work branch, `binding.baseCommit` its base. Roles do not cover audit, research, plan or status jobs, so job and class come from the name. |
| Sprite | A `swarm-report@1` block in the mob's report reply, and optional `swarm-sprite@1` status replies in the task thread | new (a schema, no board change) | Sprites are not principals and write nothing to the board. The registry is unfit: it lists without paging and a sprite name is new for every attempt, so it would grow without bound. |
| Message and header | A thread root in `swarm/<tag>/inbox` labeled `swarm.class`, `swarm.urgency`, `swarm.state`, with a `swarm-message@1` block | extend | The operational inbox is unfit: a newer send with the same recipient and topic replaces the older, it shows 15 messages, it has no feed and no history, and it is 501 on Vercel. Labels give filters, live updates and compare-and-set. |
| Digest | A message with a `swarm-digest@1` block (`batch`, `repo`, `window`, `counts`, `act_on`, `items`) in the same channel | extend | The page also computes the counts live from headers, so a missing digest shows a live count and says so. |
| Escalation | The header's `core.escalate` class, and for a human decision a task hold with a structured attention request (`team.tasks.ask`, `answer`) | as-is | Attention carries a question, 2 to 8 labeled options with consequences, and a bound commit. Responders are configured per exact channel. |
| Task and lifecycle | A board task in `swarm/<tag>/work` and `TaskState` | extend | A dispatch brief is the task root. After `claimed`, the stack's stages (reported, in review, held, mergeable, merged, retired) are not board states. The page derives them in a pure selector from the task, the report block, the PR facts and the registry. If #21 lands, the selector reads its stage instead. |
| Naming pool | `binding.profile` and the task `binding.session` carry the display name (`120-COW2`, `120-COW2.SWORD`) | as-is | The page parses the name for display with one documented pattern. An unparseable name shows as written. Allocation stays outside the board. [#33](https://github.com/remiliacorporation/politburo/pull/33) is not needed. |
| Model router | `runtime-attempt@1` blocks via `boardScoreboard` for attempts, nothing for tier cooldown | extend | Attempts show. The active tier and cooldown are on the sprite's machine and stay there until [Q8](#questions-for-bonklek) is answered. |
| Merge gate | PR labels from sync (`pr`, `head`, `state`, `review`, `ci.*`) and a `swarm-pr@1` snapshot the secretary posts from the code host | extend | Snapshot: `{ pr, head, checks, review: { head, level, by }, gateHeld }`. The page shows whether the guardrail holds. It never decides a merge. The spawner re-checks on the host. |
| Heartbeat | `AgentView.heartbeatAt` and `team.agents.heartbeat` | as-is | Spawners beat. Mobs and sprites have none, so the page shows no health for them it cannot prove. |
| Stall watch | Nothing | new | See [G4](#gaps-that-need-new-infrastructure). |
| Per-repo gates | A pinned `swarm-repo@1` message in `swarm/<tag>` | new (a schema, no board change) | Merge authority and human-gate rows for the repo. See [Q6](#questions-for-bonklek) on whether it may live on the board. |
| Urgency | Header label `swarm.urgency` (`p0` to `p3`) for messages, board `Priority` for tasks | as-is | Two scales, not one. The page does not map a message's urgency onto a task's priority. |
| Handled state | Label `swarm.state` (`open`, `handled`, `forwarded`) set with `if` | as-is | A compare-and-set label write lets one actor take a message. |

## The frontend

### Shape

The inspector gains a Swarm group in the sidebar (content) and one settings
tab (configuration). All views are children of one route family, `/swarm`.

```text
/swarm                  tree        who reports to whom, health
/swarm/mobs             mobs        running, idle, finished, retired
/swarm/queue            queue       urgent first: what needs action now
/swarm/inbox/<tag>      inbox       headers and digests for one repo
/swarm/escalations      escalations core.escalate and human decisions
/swarm/prs              prs         PR and merge state per repo
/settings/swarm         settings    repo gate records, schemas present
```

A view takes `?agent=<id>`, `?thread=<id>` or `?pr=<owner/repo#n>` for its
open pane, so the open pane is in the URL as the inspector requires.

Data and layering, for every view:

- Reads and writes are `team.*` calls in `app/board.ts`, and nothing else
  reaches the board. The page needs no swarm API. The new loaders are
  `loadSwarmAgents(channel)`, `loadSwarmTasks(tag)` and `loadSwarmHeaders(tag)`.
- The page boots as it does now: `team.poll({ all: true, last: 100 })`, then
  `team.events({ all: true, after })`. Headers, labels and tasks arrive on
  that stream and merge by `version`. The registry does not arrive on it, so
  `loadSwarmAgents` polls once a minute while the view is open.
- State is `State.swarm` in `app/store.ts`, with the selectors in a pure
  `app/swarm.ts`. Components render from it.
- A view says what the board answered. A refused read shows the board's
  words where its content would be. The shared refusals are 501
  `no_agent_ops` (no registry), 501 `no_task_authority` (no bindings), 501
  `no_operational_inbox`, 501 `no_task_attention`, and 403 or 404 for a
  channel the viewer cannot read. A view degrades to what it can still read:
  without the registry, mobs come from task bindings alone and the tree says
  it has no roster.
- No emoji, no color as the only signal, plain text status words. Content is
  in the sidebar; the repo gate records and schema checks are the settings
  tab.

Shared store fields:

| Field | Holds |
| --- | --- |
| `swarm.repos` | Repo tags found by `team.channels({ prefix: 'swarm/' })`, each with its channel names |
| `swarm.agents` | `Record<channel, Listed<AgentView>>`, by exact channel, with `asOf` |
| `swarm.reports` | Latest parsed `swarm-report@1` per task |
| `swarm.prs` | Latest parsed `swarm-pr@1` per `pr` label value |
| `swarm.gates` | Parsed `swarm-repo@1` per repo, or null |
| `swarm.digests` | Latest parsed `swarm-digest@1` per repo |
| `swarm.schemas` | Which `swarm-*@1` schemas the board has registered |

Headers and tasks are not new fields: they are `state.messages` rows picked by
label in a selector.

### Tree

Route `/swarm`. Shows core, then each repo's spawner, its secretary, and its
mobs under it, as an indented list with the status words beside each row.

Reads: `team.channels({ prefix: 'swarm/' })`, then `team.agents.list(channel)`
for `swarm/core` and each `swarm/<tag>`. `tierOf` is a selector: an entry in
`swarm/core` is core; a parentless `controller` in a repo channel is its
spawner; a `controller` with a parent is its secretary; the rest are mobs. Core
is the drawn root over every spawner, because `parent` cannot cross channels.

Store: `swarm.agents`, `swarm.repos`. A row shows tier, name (`binding.profile`),
role, `status` (`enabled` or `disabled`), and for a spawner `heartbeatAt` as an
age with `late` after 35 minutes and `down` after 65 (a constant in
`app/swarm.ts`, [Q5](#questions-for-bonklek)). A mob row shows no heartbeat.

Writes: none. The registry changes only through the agent itself.

Refused: a channel read refusal shows on that repo's branch of the tree. 501
`no_agent_ops` replaces the tree with one line saying the board keeps no
registry and linking to the mobs view, which still works from tasks.

### Mobs and sprites

Route `/swarm/mobs`. A table, one row per mob, newest first: name, class and
species (from the name), job, task, branch, phase, health, last report, sprites.

Reads: `team.tasks.list({ channel: 'swarm/<tag>/work', state: 'all', limit })`
per repo (with `latest: true` for the finished, as the swarm template does),
`team.agents.list` as above, and `team.agents.health(taskId)` for each claimed
task, at most once a minute. The report and sprite log come from the task's
thread (`team.thread(id)`) when its pane opens, and from the stream for the
row's summary.

Store: `swarm.agents`, `swarm.reports`, and `state.messages` for tasks.
`phaseOf(task, report, pr, agent)` is a pure selector:

| Phase | From |
| --- | --- |
| dispatched | task `ready` or `waiting` |
| running | task `claimed`, lease `until` in the future |
| reported | a `swarm-report@1` reply newer than the claim, or task `completed` |
| in review | the PR is `open` and no clean verdict covers its head |
| held | task `blocked`, or an open attention request, or the PR's gate refused |
| mergeable | the guardrail holds for the PR's head (see PRs) |
| merged | the PR `state` is `merged` |
| retired | the mob's registry entry is `disabled` |

Idle is a mob with an enabled entry, no claimed task, and a newest header of
class `spawner.dispatch`. Health is `working` only when `agents.health`
answers it; otherwise it is `not confirmed`, and never `idle` or `healthy`.
Sprites list from the report block's `sprites` (name, item, outcome:
`done | failed | stalled | timeout`, attempt) and, where posted, the latest
`swarm-sprite@1` reply per sprite name for a running one.

Writes: park or unpark a task for an operator (`team.tasks.park`, `unpark`,
verified person with `manage`), and set a task's priority
(`team.tasks.priority`). Nothing starts or stops a mob: the board launches
nothing.

Refused: no bindings (501 `no_task_authority`) leaves branch and session
blank and says why. A health 501 shows `not confirmed` with the board's code.

### Digests and escalations

Route `/swarm/inbox/<tag>` for one repo and `/swarm/escalations` across repos.

Inbox reads: `team.threads({ channel: 'swarm/<tag>/inbox', label: {
'swarm.urgency': 'p0|p1' } })` for the urgent block, an unfiltered page for the
rest, and the live stream. A row is the header only: urgency, class, handler
(from the class table), `from` (the block's display label), `by` (the actor the
board recorded, server-authored), summary, `ref`, age and `swarm.state`. The
page lists headers by urgency p0 to p3, then age. It opens a body (the replies)
only on an explicit open. That is a display rule, not access control: the
board has no per-thread access.

A `from` that does not match the poster's `by` handle shows both. The secretary
may post for a mob it did not run as, so a mismatch is information, not an
error.

The routing table from the architecture guide is a constant in `app/swarm.ts`,
and `slaOf(header, now)` is pure. p0 is due now. A `spawner.*` or `core.*` p1 is
due 10 minutes after it arrives, p2 at the next 30-minute digest, p3 never. A
header past its due time with `swarm.state=open` shows `overdue`. `sec.log` is
counted, never listed, outside a p3 log pane.

Digests: the newest `swarm-digest@1` shows its window, counts, `act_on` (each
resolved to its header) and items sorted p0 to p3, with no bodies, as the
architecture requires. Beside it the page shows the live count for the same
window, so a digest that disagrees with the headers is visible.

Escalations reads: `team.threads({ channel, label: { 'swarm.class':
'core.escalate' } })` per repo, plus `team.tasks.list({ state: 'blocked' })` for
held tasks with `attentionId`, and `team.tasks.attention(id)` for each. A
decision shows its question, options with consequences, status and receipt. The
page draws the chain as the header's history: secretary, spawner, core, human.

Store: headers are `state.messages` rows by label; `swarm.digests`;
attention requests join the existing task listings.

Writes:

- `team.label(id, { set: { 'swarm.state': 'handled' }, if: { 'swarm.state':
  'open' } })` to take a header. A 409 `label_conflict` shows who took it.
- `team.tasks.answer(taskId, requestId, { option, commit })` to answer a human
  decision, as a verified person with no profile, on a board whose
  `attentionResponders` names the viewer's principal for the channel. The page
  disables the buttons for anyone else and says why, but the board decides.
- `team.reply` to answer in a thread.

The page never sets a header's class or urgency. The sender's `class` and
`urgency` are trusted for routing, as the architecture says.

Refused: 501 `no_task_attention` hides the answer buttons and shows the
question read-only if it can be read. A structured hold shows as a decision,
not as a plain hold with an `unblock` button, which the board refuses with 409
`attention_required` (the open gap in the human-attention design).

### PRs and merge state

Route `/swarm/prs`, with `?pr=` for one PR's pane.

Reads: `team.threads({ channel: 'swarm/<tag>/prs' })` for sync-labeled PR
roots, and `team.threads({ channel: 'swarm/<tag>/inbox', label: { 'swarm.class':
'sec.log' } })` filtered to `swarm-pr@1` blocks for the secretary's snapshots.
Both arrive live.

Store: `swarm.prs`, keyed by the `pr` label value, with the sync labels and the
newest snapshot side by side.

`mergeGate(pr, repo)` is pure and returns `{ holds: boolean, reasons[] }`. The
guardrail from the architecture guide, as the page evaluates it:

| Condition | Source |
| --- | --- |
| CI green on the exact head | the snapshot's `checks` for `head`; where sync is on, no `ci.*` label and `head` equal |
| Latest review covers that head | the snapshot's `review.head` equals `head` |
| No findings above minor | the snapshot's `review.level` |
| Repo gates | the `swarm-repo@1` record's rows, each shown as satisfied, unmet or unknown |

A reason is one of the runtime gate's words where one exists (`check_pending`,
`stale_check`, `check_failed`, `stale_verdict`, `review_findings`) so a held PR
reads the same on the page and in the runtime. A repo gate with no recorded
status is `unknown`, and `unknown` is held, never satisfied. The page labels
its answer "the guardrail holds on this head" and never "merge", because
merging is the authorized spawner's, on the host, after it re-checks.

A PR shows head, `state`, draft or ready, review level, check status per
workflow, held reason, the task and mob it belongs to (`task` and `from` in the
snapshot, `pr` on the task), and whether sync's `head` agrees with the
snapshot's. A snapshot whose head differs from sync's is stale and says so.

Writes: none. The page has no merge, close or approve control. A human gate is
answered through attention on the task (see Escalations).

Refused: a repo with no sync and no snapshots shows no PRs and says the board
has none. A read refusal shows the board's words in that repo's section.

### Urgent-first queue

Route `/swarm/queue`. One list of what needs an actor now, across repos, sorted
the way the architecture routes it, then by age:

1. Headers with `swarm.state=open` by urgency p0 to p3, `overdue` first within
   a level.
2. Open attention requests, oldest first.
3. Ready tasks by board priority (`urgent` to `lowest`), then oldest. That is
   claim-next's order, sorted on the client because `GET /tasks` lists oldest
   first.
4. Late or down spawners.

Reads: nothing of its own. It is a selector over the store the other views
fill, plus `team.tasks.list({ state: 'ready' })` per repo.

Writes: the same as the views each row links to. The queue has none of its own.

Refused: it lists what it could read and names each source it could not.

### Settings

Tab `/settings/swarm`, added to `SECTIONS`. Shows which `swarm-*@1` schemas the
board has (`team.schemas()`), each repo's `swarm-repo@1` record and its age,
whether the board advertises `agent_ops`, `agent_intents`, `task_authority` and
`task_attention` (`team.discovery()`), and the responder note for attention.
It is read-only. Registering schemas is done by the swarm's setup with
`team.createSchema`, and the existing Schemas tab shows them.

## Blocks

Five schemas and one optional, all registered with `team.createSchema`, all in
`noSync` channels. JSON blocks, not YAML ([Q7](#questions-for-bonklek)).

| Schema | Fields |
| --- | --- |
| `swarm-message@1` | `from`, `ref` (`{ pr?, task? }`), `summary` (at most 120), `body` (a reply ID or a file name) |
| `swarm-digest@1` | `batch`, `repo`, `window` (`from`, `to`), `counts` (`p0` to `p3`), `act_on` (header IDs), `items` |
| `swarm-pr@1` | `pr`, `head`, `checks` (`green`, `failed`, `pending`, or `missing`), `review` (`head`, `level`, `by`), `task`, `from` |
| `swarm-report@1` | `links` (at least one for review), `changed`, `sprites` (`name`, `item`, `outcome`, `attempt`), `commands`, `notDone` |
| `swarm-repo@1` | `tag`, `repo`, `mergeAuthority`, `gates` (rows of `name`, `rule`), `quick` |
| `swarm-sprite@1` (optional) | `name`, `item`, `state` (`running`, `done`, `failed`, `stalled`, `timeout`), `attempt` |

The header's `id` and `at` are the board message's own ID and time, so the
block does not repeat them. Labels carry what a query filters on
(`swarm.class`, `swarm.urgency`, `swarm.state`); the block carries the rest.

## Gaps that need new infrastructure

Kept to what the board cannot carry. Each is the smallest addition.

| Gap | Smallest addition | Why existing pieces cannot carry it | Owner | Must not change |
| --- | --- | --- | --- | --- |
| G1 A review's commit | When sync maps a submitted review, also set a label `review.head=<commit_id>` from the review payload | The `review` label has no commit, and the guardrail needs the head a review covered. The secretary's snapshot works without this, so G1 is a hardening, not a blocker | Sync (`sync/github.ts`) | The meaning of `review`, `head`, `state` and the `ci.*` keys. A consumer reading them today must not change behavior |
| G2 A positive CI result | Nothing on the board in this plan: the `swarm-pr@1` snapshot's `checks` says `green`. If a board-side fact is wanted later, sync sets one label per head, `ci.green=<sha>`, when every required workflow passed | CI labels are failure only, so absence is ambiguous. Changing a pass to set a label would break every consumer of `ci.*` | Secretary now; sync if wanted | `ci.*` stays failure only |
| G3 A review severity | The runtime's `Verdict` gains an optional `level` (`none`, `minor`, `major`, `blocker`), and `swarm-pr@1` carries it | `outcome: 'clean' \| 'findings'` cannot say "above minor". The signature covers the tuple, so a field outside it is unauthenticated | Runtime (`remote/gate.ts`) | The signed tuple, the existing refusal reasons and `markReadyIfAllowed`'s behavior on a verdict without `level` |
| G4 A stall flag | A token-free watcher that, after 30 minutes with no change it counts, posts a `swarm-message@1` (class and urgency to be set, see Q4) to the owning tier's inbox channel | The board sees only its own events, not the code host's remote, and the architecture leaves "which changes count" open. The page can show board silence (age of the newest event per repo) but cannot say a remote is quiet | Core's tooling, outside the board | Core has no tick, and the board gains no timer |
| G5 Cross-channel tree | Nothing: core's channel is the root by convention. If a real cross-channel parent is wanted, `AgentView.parent` would need a channel | `parent` is validated against one exact channel, with cycle checks | Registry owner | Same-channel parent validation and cycle checks |
| G6 Agent labels | Nothing now. If parsing the name is rejected (Q2), an optional short `label` and `tier` on registration | `AgentView` has `role` and `harness` only, and `harness` is the harness name | Registry owner | Generation, binding and the eight roles |
| G7 Mob board access | Nothing in the board. A deployment decision (Q1) | A cloud mob cannot reach a local board by default, and sprites have no principal. The secretary's script writes for them | Deployment | Auth. No bypass, no shared credential in a mob |

The registry's lack of live events (it never reaches `/events`) is a cost, not
a gap: one `agents.list` per repo channel a minute while a Swarm view is open.
The page must not change `/events` visibility for `ops.*`.

## Questions for bonklek

Each blocks or shapes a decision. The architecture guide lists several as "To
be confirmed"; those are marked.

1. **Where does the board run, and who can reach it?** Cloud mobs "cannot
   message local sessions". Can a mob reach the board URL at all, and if so
   with what credential? Without it the secretary posts for every mob, and the
   page shows `by` as the secretary. Is the board a local `vb serve` (no sync)
   or an app-mounted board with GitHub sync for the swarm repos? That decides
   whether PR facts come from sync, from snapshots, or both.
2. **How are tier and class shown?** The registry has no tier, class or
   species. This design derives tier from role and parent, and class and job
   from the name. Do you accept that, or add an optional label (G6)?
   Secretary maps to `controller` with a parent because no role names it; is
   that acceptable?
3. **When does a dispatch task complete?** The runner never completes or fails
   a task. Is it complete when the report is published, when the PR merges, or
   when the mob retires? The `phaseOf` selector works either way, but the
   board's `completed` must mean one of them. (Not in the architecture guide.)
4. **Stall watcher** (to be confirmed in the guide): which changes count, and
   how the flag reaches the owning tier. Which class and urgency does a stall
   message take?
5. **Heartbeat thresholds.** Is `late` at 35 minutes and `down` at 65 right
   for a 30-minute beat with a stagger, and should they be per spawner?
6. **May the per-repo gate table be on the board?** The guide keeps the
   authoritative table in the project instance, outside the repository, and
   ignored by Git. A `swarm-repo@1` message puts it on a board others read. If
   not, the page shows repo gates as `unknown` and holds.
7. **Header wire format.** The guide's header is YAML in a fence. The board
   reads JSON blocks. May the on-board header be JSON with the same fields?
   May it carry an optional `due` time so the page does not hold the routing
   table?
8. **Router state** (to be confirmed in the guide): is the active provider tier
   or cooldown wanted on the page? It needs a post from the sprite's machine.
   The page shows attempts from the scoreboard only until then.
9. **Core and secretary authority** (to be confirmed in the guide): the page
   assumes it grants none, and shows a class's ceiling as a label, never as a
   permission, since the board enforces no class.
10. **Usage guard.** The 95% five-hour guard is a runtime policy with no board
    fact. Is a "dispatch paused for usage" row wanted? It would need the
    spawner to post it.
11. **Review level.** Is `findings` in the current gate "above minor"? G3
    needs the answer.

## Phases

Each phase ships on the current board. None needs #20 or #21. Phases add
files (`app/swarm.ts`, `app/swarm*.tsx`) and touch `nav.tsx`, `App.tsx`,
`sidebar.tsx`, `store.ts` and `board.ts` by small additions, so a merge with
#1 (which adds Handoffs and PRESIDIUM pages and edits `App.tsx`, `nav.tsx`, `sidebar.tsx`, `store.ts`, `board.ts` and `tasks.tsx`) is a normal
merge commit and not a rewrite. If #1 lands first, the Swarm group joins its
sidebar.

| Phase | Ships | Done when | Touches | Tests | Risks |
| --- | --- | --- | --- | --- | --- |
| 1 Tasks lens | `/swarm/queue` and `/swarm/mobs` from tasks alone: priority order, binding (session, branch), handoff, attention shown as a decision and answerable, parked and held reasons | A seeded board with ready, claimed, blocked-for-person and parked tasks shows them in claim-next order, and an attention request is answered from the page | `app/swarm.ts`, `store.ts`, `board.ts`, `nav.tsx`, `App.tsx`, `sidebar.tsx`, `tasks.tsx` | Selector tests in `store.test.ts` style: break the sort, the phase map and the answer-enabled rule and see each fail; an in-process board test through the handle seeds the fixture; a browser check with `vb serve --agent-ops --no-open` | Overlap with #1's task pages. Priority and attention reads add one call per page |
| 2 Registry tree | `/swarm`: core, spawners, secretaries, mobs, retired, heartbeat age | A registered fixture draws the tree by `parent`, a retired entry reads `disabled`, a late spawner reads `late`, and a board without the registry says so | `board.ts` loader, `swarm.ts` (`tierOf`, name parse), tree view, `/settings/swarm` | `tierOf` and the name parse against the naming table's examples and its misses; `late` and `down` boundaries at 35 and 65 minutes; the 501 `no_agent_ops` view | The binding-as-profile trust: the page labels it "claimed by", never "verified". One list call per repo a minute |
| 3 Messages | The `swarm-*@1` schemas registered, `/swarm/inbox/<tag>`, digests, `overdue`, take a header with a label compare-and-set | Headers post and list by urgency, a digest renders beside live counts, and two takers get one 409 | Schema setup in `packages/runtime` ops (a new helper), `swarm.ts` (`slaOf`), inbox view | `slaOf` per row of the routing table; the compare-and-set race; a digest that disagrees with live counts; header-only listing opens no body | The secretary must post it, outside this repo. The routing constant can drift from the guide, so the guide's table is quoted in a test |
| 4 PRs and the gate | `/swarm/prs`, `mergeGate`, `swarm-pr@1` snapshots, sync labels side by side | A PR with a stale head shows `stale_check`, a review of an older head shows `stale_verdict`, and an unrecorded repo gate holds | `swarm.ts` (`mergeGate`), prs view | Each guardrail condition broken alone makes `holds` false; `unknown` holds; a snapshot head against sync's `head` | The snapshot is the secretary's claim. G1 and G3 harden it. The page never merges |
| 5 Escalations | `/swarm/escalations`, the chain drawn from header history, human decisions through attention | A `core.escalate` header and a task decision show in one list, and the viewer who is not a responder sees the buttons disabled and the board's 403 on a forced write | Escalations view, `board.ts` | The disabled rule against the board's refusal; a structured hold offers no `unblock` | Responders are a local-board setting; on Vercel the view is read-only |
| 6 Optional | Router attempts from the scoreboard, running sprite status, stall flags | Q4 and Q8 are answered | Decided with the answers | Decided with the answers | Depends on the answers and G4 |

Phase 1 is the first PR after this one. Phase 2 needs a spawner that registers
and beats (outside the board). Phases 3 and 4 need a secretary that posts. If
#21 lands, `phaseOf` reads its stage and the derived phases for claimed work
collapse into it; no view changes.
