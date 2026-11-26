# Orchestrator

The orchestrator runs on the LAN and accepts no inbound connection. It claims
ready board tasks, starts one remote worker for each task attempt, exchanges
commands and telemetry with that worker through `@remilia/politburo-relay`,
chooses the next step and opens the draft pull request in the same repository.

Each attempt starts from a launch directory: a clone of the repository at the base commit,
without a remote, plus the worker client (`packages/worker`) committed in `.politburo/` on a local
branch. `claude --cloud` runs there with `CCR_FORCE_BUNDLE=1` and uploads it, so the session needs
no GitHub access. The session runs the client as `WORKER_RELAY_PROTOCOL.md` describes.

Workers hold no GitHub credential. A worker commits on its task branch
and sends the commits as a git bundle in `bundle_part` messages before its `result`. When the
next step is `publish`, the orchestrator checks the bundle digest, checks that the commits
descend from the base commit, pushes the branch without force and opens the draft PR.

A channel that links no repository has a local bare repository in the state directory
(`channel_repositories/`). Its tasks start from `main`, and the orchestrator merges the bundle into
`main`: forward when possible, else with a merge commit. A conflict keeps the work on the task branch.

Run it with `swarm orchestrator serve --config FILE`. `check` validates the
configuration and the party routes; `status` prints the live attempts.

## Wake sources

One tick runs at a time. These wake it:

| Source | Kind |
| --- | --- |
| Board events (long-poll feed) | event |
| Telemetry of a live attempt (relay SSE) | event, handled at once |
| The next due time: lease renewal, worker token renewal, watchdog | timer, set after each tick |
| Sweep every `sweep_seconds` (default 30) | interval, catches missed events |

A tick: board pause check, pending relay commands, lease and token renewal and
watchdog for each live attempt, then admission of new ready tasks.

## Attempt states

`claimed` → `launching` → `awaiting_contact` → `running` ⇄ `waiting_answer` →
`deciding` → `publishing` → `settled`. `stopping` → `lost` on silence;
`uncertain` when a launch result is unknown (never relaunched automatically).

## Files

| Path | Contents |
| --- | --- |
| `service.ts` | The loop, admission, attempt states, telemetry handling, settlement |
| `config.ts` | YAML configuration (snake_case) over defaults |
| `state.ts` | SQLite state: attempts, telemetry cursors, seen message ids, command outbox; instance lock |
| `usage-ledger.ts` | Appends one dispatch per attempt (tier `mob`) and one usage record per model row of each round result to the party's spend ledger (`ledger.file`, default `/ledger/ledger.sqlite`). The file is open only during a write, so the board can read it. |
| `relay-client.ts` | Token minting, command POST, telemetry SSE with resume and backoff, relay statistics |
| `operations.ts` | Events and snapshot for the operations view: types, sizes, times, states; never message content |
| `operations-server.ts` | Read-only status server on 127.0.0.1 (`operations.port`, default 4780): `GET /state`, `GET /events` (SSE), `GET /attempts/{id}/events` |
| `launcher.ts` | Worker prompt and the `claude --cloud` launch provider |
| `policy.ts` | Next step after a result (pluggable) and the hard limits around it |
| `github.ts` | Repository reads and the draft PR (head and base in one repository) |
| `git.ts` | Bare mirrors and local channel repositories; launch directories; applies a worker's git bundle and pushes the task branch (never forced) or merges it into a local `main` |
| `worker-files.ts` | The worker client files each launch directory receives in `.politburo/` |
| `worker-credentials.ts` | The routes as the worker runs them (`anthropic` becomes `claude-cli`, through `claude --print` on the subscription, unless `ANTHROPIC_API_KEY` is set) and their provider variables (`CLAUDE_CODE_OAUTH_TOKEN`, `OPENROUTER_API_KEY`), sent sealed for the public key in the worker heartbeat |
| `launch.ts`, `journal.ts` | Launch a session once, record it, recover after a restart |
| `stages/` | Review stages and the evidence gate (not connected yet) |
| `cli.ts` | `serve`, `status`, `check` |

## Configuration

```yaml
state_directory: /orchestrator
board_profile: orchestrator
party_file: /party/party_configuration.yaml
relay: { signing_key_file: /orchestrator/keys/relay_signing_key.pem }
```

Every other setting has a default in `config.ts`. The relay address comes from `RELAY_URL`. Credentials come from the environment:
`GITHUB_TOKEN` (reads, push, draft PR) and `CLAUDE_CODE_OAUTH_TOKEN` (`claude --cloud`).
