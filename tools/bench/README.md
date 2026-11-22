# Benchmark records

Use Node 22 from the repository root. Both commands emit only `bench-run@1`
JSONL to stdout. Supply IDs and short, content-free labels, not transcripts,
paths, or credentials. Check commands are names only; neither tool runs them.

```sh
node tools/bench/sprite-usage.mjs sprite1 --repo acme/web --task t1 > sprite.jsonl
node tools/bench/rollup.mjs --level task --id t1 --repo acme/web \
  --started 2025-01-01T00:00:00Z --ended 2025-01-01T00:00:10Z sprite.jsonl
```

For example, one two-second sprite with one turn and 12 input tokens yields
`turns: 1`, `tokens.in: 12`, `sprites.count: 1` and `sprites.wallSeconds: 2`
in the task record. The task's own `wallSeconds` is 10.

- **Collect:** `--dir` overrides the launcher's default sprites directory. The
  session directory provides only a file count for retries. Pair `--worktree`
  with `--base` for Git change counts. Use `--outcome blocked --reason TEXT` for
  a caller-declared block. Models use the provider and name that served turns;
  tool calls belong to the model that initiated the wait. Active time excludes
  the union of tool waits and is null if a wait cannot be timed.
- **Roll up:** use `--level mob|task|pr|spawner` and one or more JSONL files.
  Keep inputs disjoint except for repeated records with the same run ID. Model
  slices share one physical sprite's time and change counts. Usage adds only
  known counts and stays separate in `byModel`. `--mob-session claude` marks
  coverage partial. Aggregate active time is unknown without attention data;
  `sprites.activeSeconds` sums the known sprite times.
- Both accept `--parent`, `--task`, `--review-rounds`, `--failed-checks`, and
  `--check pass|fail|not_run` with optional `--check-command NAME`. Roll-ups
  accept `--outcome done|failed|blocked|canceled` with `--reason TEXT` as needed.
- **Exit codes:** `0` success; `2` invalid arguments or input (including a
  missing log); `3` collector only, no exit-code file yet. Errors emit no records.

## Rate before running

Judge five axes from the brief: scope (function to subsystem), components
(files and packages), design decisions (none to a new contract), risk (docs or
tests, internal, user-visible, auth/data/integrity), and novelty (familiar to
unprecedented here). Give one overall score 1–5 and an effort size: S under
about an hour of engineer time, M about a day, L longer. Attach the rating to
an aggregate with `--complexity-score`, `--complexity-size`,
`--complexity-reason` (one line), `--rated-by`, and `--rated-at` (ISO time).
Afterward, compare it against changes, review rounds, failed checks and retries.

## Build a benchmark

Fix a task set with an ID, base commit, brief, golden check outside the agent's
reach, time cap and rating for each task. Run each model and thinking-level pair
at least five times per task, with one sprite in a fresh worktree at the base.
Only the runner pins models. Group by complexity; report pass rate with a Wilson
interval, median and p90 wall seconds and tokens, and tokens per changed line.
Name the source run IDs for every reported number. Use sprite records for
model-grouped reporting.
