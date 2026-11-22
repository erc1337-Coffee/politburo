import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runName } from '../run.mjs';
import { validRating } from '../../record.mjs';

const here = path => fileURLToPath(new URL(path, import.meta.url));
const repo = here('../../../../');
const suite = 'tools/bench/suite';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = path => JSON.parse(readFileSync(path, 'utf8'));

const tasks = json(join(repo, suite, 'tasks.json'));
const objectExists = ref => spawnSync('git', ['cat-file', '-e', ref], { cwd: repo, env, stdio: 'ignore' }).status === 0;

test('the suite has three rated tasks and clean briefs', () => {
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map(t => t.id)).size, 3);
  for (const t of tasks) {
    assert.match(t.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(t.title.trim());
    for (const ref of [t.base, t.goldenRef]) assert.match(ref, /^[a-f0-9]{40}$/);
    assert.ok(t.goldenFiles.length);
    assert.ok(t.goldenCommand.length && t.goldenCommand.every(x => typeof x === 'string'));
    assert.ok(Array.isArray(t.setup) && t.setup.every(a => Array.isArray(a) && a.length && a.every(x => typeof x === 'string')));
    assert.ok(Number.isSafeInteger(t.timeCapSeconds) && t.timeCapSeconds > 0);
    assert.ok(validRating(t.rating));
    assert.equal(t.rating.ratedBy, '218-BEE7');
    assert.equal(t.briefFile, `${suite}/briefs/${t.id}.md`);
    const brief = readFileSync(join(repo, t.briefFile), 'utf8');
    assert.match(brief.trimEnd(), /Do not commit, do not read any git history beyond the working tree\.$/);
    assert.doesNotMatch(brief, /\b(?:describe|test)\s*\(/);
    for (const file of t.goldenFiles) {
      assert.ok(!brief.includes(basename(file)), `${t.id} brief names a golden file`);
    }
  }
});

test('every golden file was added by its recorded merge', t => {
  if (git(repo, 'rev-parse', '--is-shallow-repository') === 'true'
    && tasks.some(task => !objectExists(task.base) || !objectExists(task.goldenRef))) {
    return t.skip('historical commits not available in shallow checkout');
  }
  for (const task of tasks) {
    for (const ref of [task.base, task.goldenRef]) assert.equal(git(repo, 'cat-file', '-t', ref), 'commit');
    assert.equal(git(repo, 'rev-parse', `${task.goldenRef}^1`), task.base);
    for (const file of task.goldenFiles) {
      assert.equal(git(repo, 'cat-file', '-t', `${task.goldenRef}:${file}`), 'blob');
      assert.equal(spawnSync('git', ['cat-file', '-e', `${task.base}:${file}`], { cwd: repo, env, stdio: 'ignore' }).status, 128);
    }
  }
});

test('run names normalize slugs and label omitted settings', () => {
  const name = runName('serve-swarm-flag', 'Provider/Model:V2.0', 'HIGH_EFFORT', 5, 17);
  assert.match(name, /^[a-z0-9._-]+$/);
  assert.equal(name, 'bench.serve-swarm-flag.provider-model-v2.0.high_effort.r5.17');
  assert.equal(runName('task', undefined, undefined, 1, 18), 'bench.task.default.default.r1.18');
});

const rating = { score: 4, size: 'S', reason: 'Fixture rating.', ratedBy: '218-BEE7', ratedAt: '2025-01-01T00:00:00.000Z' };
function fixture(t, mode) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-suite-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '--template=');
  const commit = () => {
    git(cwd, 'add', '--all');
    git(cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--no-gpg-sign', '-m', 'Fixture');
    return git(cwd, 'rev-parse', 'HEAD');
  };
  writeFileSync(join(cwd, 'answer'), 'base');
  const base = commit();
  writeFileSync(join(cwd, 'answer'), 'fixed');
  writeFileSync(join(cwd, 'golden.mjs'), `import { readFileSync } from 'node:fs';
console.log('check stdout');
console.error('check stderr');
process.exitCode = readFileSync('answer', 'utf8') === 'fixed' ? 0 : 1;
`);
  const goldenRef = commit();
  const task = { id: 'fixture', title: 'Fixture', base, goldenRef, goldenFiles: ['golden.mjs'],
    goldenCommand: ['node', 'golden.mjs'], setup: [['node', '-e', "require('node:fs').writeFileSync('ready', '')"]],
    timeCapSeconds: 1, briefFile: `${suite}/briefs/fixture.md`, rating };
  mkdirSync(join(cwd, suite, 'briefs'), { recursive: true });
  writeFileSync(join(cwd, suite, 'tasks.json'), JSON.stringify([task]));
  writeFileSync(join(cwd, task.briefFile), 'Fixture brief.\n');
  const launcher = join(dir, 'fake-sprite-start'), sprites = join(dir, 'sprites');
  const out = join(dir, 'records.jsonl'), work = join(dir, 'work');
  writeFileSync(launcher, `#!/bin/sh
set -eu
[ -f ready ] && [ -s "$2" ] || exit 9
[ ! -e golden.mjs ] && [ "$(git rev-parse --show-toplevel)" = "$PWD" ] || exit 9
[ "$3" = "$EXPECTED_CAP" ] && [ "\${PI_MODEL-unset}" = "$EXPECTED_MODEL" ] && [ "\${PI_THINKING-unset}" = "$EXPECTED_THINKING" ] || exit 9
printf 'sprite stdout\n'
printf 'sprite stderr\n' >&2
[ "$MODE" != fail-start ] || exit 9
cp "$FIXTURE_LOG" "$SPRITES/$1.jsonl"
if [ "$MODE" = pass ]; then printf fixed > answer; printf 'one\ntwo\n' > added; printf 'mine\n' > golden.mjs; fi
if [ "$MODE" != no-rc ]; then (sleep 0.1; printf '%s\n' "$RC" > "$SPRITES/$1.rc") & fi
`, { mode: 0o700 });
  const pinned = mode === 'pass';
  const result = spawnSync(process.execPath, [here('../run.mjs'), '--task', task.id, '--work', work, '--out', out, '--sprites', sprites,
    ...(pinned ? ['--model', 'Requested/Model', '--thinking', 'high', '--rep', '2', '--max-seconds', '3'] : [])],
  { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { ...env, BENCH_REPO: cwd, BENCH_SPRITE_START: launcher,
    BENCH_RC_GRACE_SECONDS: '0', FIXTURE_LOG: here('../../test/fixtures/single.jsonl'), SPRITES: sprites, MODE: mode, RC: pinned ? '3' : '0',
    PI_MODEL: 'ignored', PI_THINKING: 'ignored', EXPECTED_MODEL: pinned ? 'Requested/Model' : 'unset',
    EXPECTED_THINKING: pinned ? 'high' : 'unset', EXPECTED_CAP: pinned ? '3' : '1' } });
  if (result.error) throw result.error;
  return { result, out, work, sprites, base, goldenRef };
}

for (const verdict of ['pass', 'fail']) test(`runner records golden ${verdict} and keeps subprocess output private`, t => {
  const { result, out } = fixture(t, verdict);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const slug = verdict === 'pass' ? 'requested-model.high.r2' : 'default.default.r1';
  const name = result.stdout.match(/^run  (bench\.[a-z0-9._-]+)  (pass|fail)\n$/);
  assert.ok(name, 'one summary line');
  assert.equal(name[2], verdict);
  assert.ok(name[1].startsWith(`bench.fixture.${slug}.`));
  const row = json(out);
  assert.equal(row.schema, 'bench-run@1');
  assert.equal(row.runId, name[1]);
  assert.equal(row.taskId, 'fixture');
  assert.deepEqual(row.check, { result: verdict, command: 'node' });
  assert.deepEqual(row.complexity.rating, rating);
  assert.deepEqual(row.model, { provider: 'p1', name: 'm1' });
  assert.equal(row.thinking, 'low');
  // A file the sprite created counts as a change; the restored golden file does not.
  // The sprite's own file at the golden path counts (1 line), the restored golden file does not.
  assert.deepEqual(row.changes, verdict === 'pass' ? { files: 3, linesAdded: 4, linesRemoved: 1 } : { files: 0, linesAdded: 0, linesRemoved: 0 });
  // The verdict does not follow the sprite's exit code.
  assert.deepEqual(row.outcome, verdict === 'pass' ? { state: 'failed', reason: 'exit 3' } : { state: 'done', reason: null });
});

test('a sprite without an exit file times out before any golden file is restored', t => {
  const { result, out, work, sprites } = fixture(t, 'no-rc');
  assert.ok(readdirSync(sprites).some(file => file.endsWith('.jsonl')), 'sprite did start');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(join(work, readdirSync(work)[0], 'tree/golden.mjs')));
  assert.ok(!existsSync(out));
});

test('a launcher error reports exit 1 without a record', t => {
  const { result, out } = fixture(t, 'fail-start');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not produce a record/);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(out));
});

test('the work repo has one synthetic commit and none of the source commits', t => {
  const { result, work, base, goldenRef } = fixture(t, 'pass');
  assert.equal(result.status, 0, result.stderr);
  const cwd = join(work, readdirSync(work)[0], 'tree');
  assert.equal(git(cwd, 'rev-list', '--all', '--count'), '1');
  assert.equal(git(cwd, 'show', 'HEAD:answer'), 'base');
  assert.equal(git(cwd, 'remote'), '');
  for (const ref of [base, goldenRef]) {
    assert.equal(spawnSync('git', ['cat-file', '-e', ref], { cwd, env, stdio: 'ignore' }).status, 1);
  }
});
