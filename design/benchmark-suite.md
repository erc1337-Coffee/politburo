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
   sprite tree without the source repository's `.git` or history. Initialize
   Git, run setup and make one synthetic commit, S. Before launch, make a
   private bare clone, `trusted.git`, without hardlinks to the sprite tree.
2. Give `sprite-start` the copied brief and cap. Wait for the sprite's exit
   file, up to the cap plus 60 seconds. No exit file means no record.
3. Export a binary patch against S. The runner reads the work tree but
   does not copy it or use its Git repository. A temporary Git directory
   and index use objects from `trusted.git`. The runner inspects tracked
   paths and unignored entries, skipping nested `.git` entries and pruning
   ignored directories. It includes regular files and deletions, skips and
   counts special files such as FIFOs, and checks modes in the written Git
   tree before making the patch. Unreadable ignore metadata fails export.
   An exported symlink or non-regular Git mode
   blocks the run as `refused_symlink`; any other export or patch application
   failure is `refused_export`. A blocked record has `check: not_run` and no
   churn. The runner exits zero without grading or running setup again.
4. Apply the same patch to two independent clones of `trusted.git`, each
   checked out at S. The stats tree has only the sprite's change. In the
   grading tree, restore the golden files from `goldenRef` without following
   symlinks. Only then run setup to recreate ignored output such as
   `node_modules`, and run the golden command. Discard check output. Exit
   zero is a pass, independent of the sprite's exit code.
5. After grading, run `sprite-usage.mjs` with the stats tree and S. Append
   its `bench-run@1` rows with the task ID, check name, verdict and prior
   rating. The collector uses the sprite name for the record ID and the log
   for serving model and thinking. A split log can yield more than one row.
   The runner prints one line with the run name and verdict, plus a refusal
   code or a `skipped_special` count when applicable.

Use Node 22. For example, from the repo root:

```sh
node tools/bench/suite/run.mjs --task serve-responder-flag --rep 1
```

Use `--model`, `--thinking` and `--rep` to choose a cell and repetition.
`--max-seconds` overrides the manifest cap. `--out` defaults to `results.jsonl`.
`--work` chooses where the runner keeps the sprite tree, `trusted.git`,
export directory, stats and grading trees, and private homes. It leaves
these artifacts in place for inspection. `--sprites` selects
where the runner reads logs. This must match where the launcher writes.
Tests inject `BENCH_SPRITE_START` and `BENCH_REPO` and shorten the exit-file
grace period with `BENCH_RC_GRACE_SECONDS`.
Do not check in results, working copies or launcher logs. The runner needs
both historical commits locally. The test gate skips only the Git object
check when a shallow checkout lacks those commits; it does not fetch.

## Child environment

Every child gets the same allowlist: `PATH`, `LANG`, `LC_ALL`, `TZ`, `TERM`
and `TMPDIR` if set. `PI_MODEL` and `PI_THINKING` come only from the runner's
flags. `HOME` is a private mode-0700 directory under `--work`; the launcher
gets a separate home from the grader. `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`
and `XDG_DATA_HOME` are generated paths inside the private per-run `HOME`,
not values from the runner's environment. The runner adds Git isolation
variables only to its own Git commands.

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
Churn counts the exported changes, including new files and deletions,
relative to S. Neither grading setup nor golden files count. Report the
pass rate and Wilson interval, median and p90 time and tokens, and tokens
per changed line with their source run IDs, not as a leaderboard.

The archive and delayed golden restore keep the answer out of the supplied
working tree. Export is a read of a live tree, not an atomic filesystem
snapshot. Once the patch is captured, the runner never reads the sprite tree
again, so later writes cannot change the patch or receive golden files.
Private directories are not an OS sandbox against processes running as the
same user. Keep the source checkout and prior run artifacts outside what the
sprite can access. `sprite-start` writes `.out` and `.jsonl.err` files that
can hold raw diagnostics; the suite does not read them. The suite does not
rule out prior exposure or measure resistance to checker tampering.
