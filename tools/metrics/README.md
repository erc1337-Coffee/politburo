# Judge metrics

**Climbers must not edit anything in `tools/metrics/`.** The judge is outside
what a climber may change. Run it from a trusted copy against the commit being
judged; the scripts ignore uncommitted changes in the measured repository.

## Fork thinness

```sh
tools/metrics/fork-thinness.sh [--repo PATH] [--head REF] [--upstream-url URL_OR_PATH] [--upstream-branch BRANCH]
```

Counts lines added under `packages/board/src` between the merge base and the
selected head, plus additions in six hot files and the number of upstream
commits not reachable from head. Requires Bash, Git, and `timeout`. Defaults:
the repository containing the script, `HEAD`, and `main` at
`https://github.com/vercel/board.git`. Fetches into a disposable clone. The
metric depends on upstream being reachable; a binary diff row is an error.

```json
{
  "metric": "fork_thinness",
  "value": 7,
  "unit": "lines added in packages/board/src vs merge base with upstream/main",
  "lines_added_src": 7,
  "lines_added_hot": 3,
  "hot_files": {
    "packages/board/src/conformance/index.ts": 1,
    "packages/board/src/cli/main.ts": 2,
    "packages/board/src/server/tasks.ts": 0,
    "packages/board/src/cli/commands.ts": 0,
    "packages/board/src/api/routes.ts": 0,
    "packages/board/src/server/serve.ts": 0
  },
  "commits_behind_upstream": 2,
  "head": "<sha>",
  "merge_base": "<sha>",
  "upstream": "<sha>"
}
```

## Time to first claim

```sh
node tools/metrics/time-to-first-claim.mjs [--repo PATH_OR_URL] [--head REF] [--timeout SECONDS]
```

Times the fresh clone, frozen install, board build, and handoff on a disposable
loopback board with `--agent-ops`. The local principal queues the fixture. The
registered `demo-worker` profile claims it, replies with the candidate, and
completes it. These are distinct board identities under one local principal,
not separate security principals. `claim` includes registration; `complete`
includes the reply. Every spawned command counts once, including Git ref
resolution, checkout, and `serve`. In-process polling and environment setup
are not commands.

Requires Node 22, Git, and the checkout's pnpm version. Defaults: the repository
containing the script, `HEAD`, and a 1200-second deadline. The head must be
available in a normal fresh clone (for example a branch, tag, or reachable SHA).
Network speed, dependency availability, and machine load affect timings. Use a
trusted repository: this metric runs its dependency install and build.

```json
{
  "metric": "time_to_first_claim",
  "value": 14.5,
  "unit": "seconds from fresh clone to second identity completing a claimed task",
  "seconds": 14.5,
  "commands": 11,
  "phases": {
    "clone": 0.5,
    "install": 7.3,
    "build": 5.5,
    "serve_ready": 0.3,
    "create": 0.2,
    "claim": 0.3,
    "complete": 0.4
  },
  "head": "<sha>"
}
```

## Exit codes and tests

Both scripts exit `0` with exactly one JSON document on stdout, or `1` with
empty stdout and one `error: <reason>` line on stderr. The judge never replays
raw child logs.

Run the offline CLI tests with `node --test tools/metrics/test/`.
