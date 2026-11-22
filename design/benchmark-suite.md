status: proposed
bonklek decides on this PR

# Benchmark suite

This extends “How a benchmark is made” in [benchmarks.md](benchmarks.md).
The link resolves once that design is on main.

## The first tasks

[The manifest](../tools/bench/suite/tasks.json) fixes three tasks from real
changes. `id` and `title` identify each task. `base` is the full SHA of the
merge's first parent. `goldenRef` is the full SHA of the merge. `goldenFiles`
name the tests added by that merge, and `goldenCommand` runs them from the
working directory. `setup` and `goldenCommand` use argument arrays, not
shell strings. `briefFile` is the only task instruction the runner hands to
the sprite. `timeCapSeconds` caps the sprite. `rating` fixes score, size,
reason, rater and rating time before any run.

- `serve-responder-flag` exercises a repeatable CLI flag, identity validation
  and a change to an existing permission boundary without granting access.
- `serve-swarm-flag` links a CLI opt-in to local authorization and discovery.
  It checks a broader change on a related surface, with default behavior as
  a control.
- `claim-redirect-hardening` adds a different kind of task. A security
  contract has to hold across the handle, transports and inspector proxy.

## Matrix

Run each task for each requested model and thinking pair. Use the same
number of repetitions in every cell, at least five. Only the runner pins
those settings. An omitted setting uses the launcher's default. Keep the
requested matrix and manifest version with the run IDs so a comparison can
be repeated. Use serving model and thinking from the log for model reports.

The runner starts one cell repetition per invocation. Its name is
`bench.<id>.<modelslug|default>.<thinking|default>.r<rep>.<unix-seconds>`.
Slugs use lowercase ASCII letters, digits, dots, underscores and hyphens.
Other characters collapse to a hyphen. Wait for a fresh second on collision
rather than overwriting a log.

## One run

1. Validate the manifest entry. Extract `git archive <base>` into a fresh
   directory. Do not clone or link the real `.git`. Create one synthetic
   commit in the copy as the diff base and run setup there. The sprite
   cannot read the real change from the copy's Git history.
2. Give `sprite-start` the copied brief and cap. Wait for the sprite's exit
   file, up to the cap plus 60 seconds. No exit file means no record.
3. After the exit file appears, stage the sprite's work and snapshot that
   Git tree. Create a fresh mode-0700 grading directory under `--work`.
   Initialize it from the same base archive and setup, then overlay the
   snapshot, including deletions. Restore the golden files from `goldenRef`
   only in the grading tree, refusing symlinks at golden paths or their
   parents. Run setup again there to recreate ignored files such as
   `node_modules`, then run the golden command. The first suite runs Vitest
   against sources. Discard check output. Exit zero is a pass, independent
   of the sprite's exit code.
4. Restore the staged snapshot at tracked paths and remove any golden file
   that was not in it. Run `sprite-usage.mjs` in the grading tree with its
   synthetic diff base, task ID, check name, verdict and prior rating.
   Append its `bench-run@1` JSON lines to the output
   file. The collector sets `check` from the golden verdict and name and
   copies the manifest rating. It uses the sprite name for the record ID
   and the log for serving model and thinking. A split log may yield more
   than one row. The runner prints only the run name and verdict on success.

Use Node 22. For example, from the repo root:

```sh
node tools/bench/suite/run.mjs --task serve-responder-flag --rep 1
```

Use `--model`, `--thinking` and `--rep` to choose a cell and repetition.
`--max-seconds` overrides the manifest cap. `--out` defaults to `results.jsonl`.
`--work` chooses where the runner keeps the sprite tree, grading tree and
per-run home. It leaves them in place for inspection. `--sprites` selects
where the runner reads logs. This must match where the launcher writes.
Tests inject `BENCH_SPRITE_START` and `BENCH_REPO` and shorten the exit-file
grace period with `BENCH_RC_GRACE_SECONDS`.
Do not check in results, working copies or launcher logs. The runner needs
both historical commits locally. The test gate skips only the Git object
check when a shallow checkout lacks those commits; it does not fetch.

## Child environment

Every child gets the same allowlist: `PATH`, `LANG`, `LC_ALL`, `TZ`, `TERM`
and `TMPDIR` if set. `PI_MODEL` and `PI_THINKING` come only from the runner's
flags. `HOME` is a new mode-0700 directory under `--work`, with
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` pointing inside it.

Set `BENCH_PASS_ENV` to a comma-separated list of variable names, not
values. The runner copies set variables whose names match
`^[A-Za-z_][A-Za-z0-9_]*$`, ignoring `GIT_*`, `BENCH_*` and overrides to the
runner's model, thinking, home or XDG settings. This is how a launcher whose
credentials live under the real home gets access: supply the credentials
or a launcher-supported credential location in an operator-provided variable
and name it in `BENCH_PASS_ENV`. The real home and unlisted variables do not
cross. List only what the run needs: setup, grading and collection receive
those variables too.

## What this does not measure

Three tasks prove the pipeline. They cannot rank models or establish a
representative complexity curve. These tasks are related and historical.
A pass establishes only what the golden command covers. It does not score
maintainability, review effort, human waits or coordination across sprites.
Churn counts what the sprite left in the work tree, new files included, relative to the base after setup. Report the design's pass rate and
Wilson interval, median and p90 time and tokens, and tokens per changed line
with their source run IDs, not as a leaderboard.

The archive and delayed test copy prevent direct leakage in the supplied
working tree. Late writes in the sprite tree do not alter the captured
snapshot or receive the golden files. The fresh directory is not an OS
sandbox for processes running as the same user. `sprite-start` writes `.out`
and `.jsonl.err` files that can hold raw diagnostics; the suite does not read
them. Keep the source checkout and prior run artifacts outside what the
agent can access. The suite does not rule out prior exposure or measure
resistance to an agent seeking the answer or tampering with the checker.
