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
3. Only after the sprite exits, copy the golden files from `goldenRef` into
   the copy. Run the golden command there after install and with any build
   it needs. The first suite runs Vitest against sources. Discard check
   output. Exit zero is a pass; a nonzero verdict is a fail, independent of
   the sprite's exit code.
4. Run `sprite-usage.mjs` with the synthetic diff base, task ID, check name,
   verdict and prior rating. Append its `bench-run@1` JSON lines to the output
   file. The collector sets `check` from the golden verdict and name and
   copies the manifest rating. It uses the sprite name for the record ID
   and the log for serving model and thinking. A split log may yield more
   than one row. The runner prints only the run name and verdict on success.

Use Node 22. For example, from the repo root:

```sh
node tools/bench/suite/run.mjs --task serve-responder-flag --rep 1
```

Use `--model`, `--thinking` and `--rep` to choose a cell and repetition.
`--max-seconds` overrides the manifest cap. `--out` defaults to `results.jsonl`;
`--work` chooses where scratch copies are kept. The runner leaves them for
inspection. `--sprites` selects the log directory to read, which must match
where the launcher writes. Tests inject `BENCH_SPRITE_START` and `BENCH_REPO`
and shorten the exit-file grace period with `BENCH_RC_GRACE_SECONDS`.
Do not check in results, working copies or launcher logs. The runner needs
both historical commits locally. The test gate skips only the Git object
check when a shallow checkout lacks those commits; it does not fetch.

## What this does not measure

Three tasks prove the pipeline. They cannot rank models or establish a
representative complexity curve. These tasks are related and historical.
A pass establishes only what the golden command covers. It does not score
maintainability, review effort, human waits or coordination across sprites.
Churn counts what the sprite left in the work tree, new files included, relative to the base after setup. Report the design's pass rate and
Wilson interval, median and p90 time and tokens, and tokens per changed line
with their source run IDs, not as a leaderboard.

The archive and delayed test copy prevent direct leakage in the supplied
working tree. A sprite subprocess that outlives its sprite could still write into the copy while the golden files are restored; grading in a second, runner-owned tree is a follow-up. The sprite and the golden check inherit the runner's environment, because the launcher needs the model's credentials from it; run the suite from a shell that holds nothing else. `sprite-start` writes the sprite's own `.out` and `.jsonl.err` files, which can hold raw diagnostics, under the sprites directory; they are never read or committed here. They do not sandbox the agent or rule out prior exposure to
this change. Keep the source checkout and prior run artifacts outside what
the agent can access. Do not treat this suite as a test of resistance to
an agent seeking the answer or tampering with the checker.
