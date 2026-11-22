import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runName } from '../run.mjs';
import { verifyModes } from '../export.mjs';
import { validRating } from '../../record.mjs';

const here = path => fileURLToPath(new URL(path, import.meta.url));
const repo = here('../../../../');
const suite = 'tools/bench/suite';
const env = { PATH: process.env.PATH };
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
// Record only presence and comparisons, never an environment value.
const observe = `
const fs = require('node:fs'), path = require('node:path'), e = process.env;
const obs = (...parts) => path.join(e.OBS, ...parts);
const note = (file, value) => fs.writeFileSync(obs(file), JSON.stringify(value));
const present = key => Object.hasOwn(e, key) ? 'present' : 'absent';
const home = () => ({ isolated: e.HOME !== obs('runner-home') && path.dirname(e.HOME) === obs('work')
  && (fs.statSync(e.HOME).mode & 0o777) === 0o700,
  xdg: ['CONFIG', 'CACHE', 'DATA'].every(key => path.dirname(e['XDG_' + key + '_HOME']) === e.HOME) });
`;
function treeDigest(root, { lstatSync, readFileSync, readdirSync, readlinkSync }, join, createHash) {
  const hash = createHash('sha256');
  function walk(rel) {
    const file = join(root, rel), stat = lstatSync(file);
    const type = stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'special';
    const content = type === 'link' ? readlinkSync(file)
      : type === 'file' ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
    hash.update(JSON.stringify([rel, type, stat.mode, content]));
    if (type === 'dir') for (const child of readdirSync(file).sort()) walk(join(rel, child));
  }
  walk('.');
  return hash.digest('hex');
}

const digest = path => treeDigest(path, { lstatSync, readFileSync, readdirSync, readlinkSync }, join, createHash);

function fixture(t, mode, timeout = 10_000) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-suite-test-')));
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
  writeFileSync(join(cwd, 'obsolete'), 'obsolete\n');
  writeFileSync(join(cwd, 'setup-location'), 'not set up\n');
  writeFileSync(join(cwd, '.gitignore'), 'ignored\nignored-link\nignored-dir/\n');
  mkdirSync(join(cwd, 'swap'));
  writeFileSync(join(cwd, 'swap/file'), 'tracked\n');
  writeFileSync(join(cwd, '.gitattributes'), 'added export-ignore\n');
  const base = commit();
  writeFileSync(join(cwd, 'answer'), 'fixed');
  mkdirSync(join(cwd, 'checks'));
  writeFileSync(join(cwd, 'checks/golden.cjs'), `${observe}
note('golden', { cwd: process.cwd(), secret: present('BENCH_FIXTURE_SECRET_TOKEN'), ...home(),
  setupHere: fs.readFileSync('setup-location', 'utf8') === process.cwd(),
  goldenInstalledBeforeSetup: fs.existsSync('setup-saw-golden') });
console.log('check stdout');
console.error('check stderr');
if (e.MODE === 'straggler') {
  const stop = Date.now() + 2000;
  while (!fs.existsSync(obs('straggler-done')) && Date.now() < stop)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  if (!fs.existsSync(obs('straggler-done')) || fs.existsSync('obsolete')) process.exit(1);
}
process.exitCode = fs.readFileSync('answer', 'utf8') === 'fixed' &&
  fs.readFileSync('ignored', 'utf8') === 'fixed' && fs.existsSync('added') &&
  !fs.existsSync('pipe') && !fs.existsSync('ignored-dir') && !fs.existsSync('ignored-link') ? 0 : 1;
`);
  const goldenRef = commit();
  const setup = `${observe}
fs.appendFileSync(obs('setup'), present('BENCH_FIXTURE_SECRET_TOKEN') + '\\n');
const answer = fs.readFileSync('answer');
fs.writeFileSync('setup-location', process.cwd());
if (fs.existsSync('checks/golden.cjs') && fs.readFileSync('checks/golden.cjs', 'utf8').includes('process.exitCode'))
  fs.writeFileSync('setup-saw-golden', 'yes');
fs.writeFileSync('ready', answer);
fs.writeFileSync('ignored', answer);
`;
  const task = { id: 'fixture', title: 'Fixture', base, goldenRef, goldenFiles: ['checks/golden.cjs'],
    goldenCommand: ['node', 'checks/golden.cjs'], setup: [['node', '-e', setup]],
    timeCapSeconds: 1, briefFile: `${suite}/briefs/fixture.md`, rating };
  mkdirSync(join(cwd, suite, 'briefs'), { recursive: true });
  writeFileSync(join(cwd, suite, 'tasks.json'), JSON.stringify([task]));
  writeFileSync(join(cwd, task.briefFile), 'Fixture brief.\n');
  const launcher = join(dir, 'fake-sprite-start'), sprites = join(dir, 'sprites');
  const out = join(dir, 'records.jsonl'), work = join(dir, 'work');
  mkdirSync(join(dir, 'runner-home'));
  mkdirSync(join(dir, 'outside'));
  writeFileSync(join(dir, 'outside/golden.cjs'), 'untouched');
  const outsideBefore = digest(join(dir, 'outside'));
  writeFileSync(join(dir, 'monitor'), '#!/bin/sh\ntouch "$OBS/outside/monitor-ran"\n', { mode: 0o700 });
  // Observe the real collector at process startup, without replacing it.
  const preload = join(dir, 'collector-probe.cjs');
  writeFileSync(preload, `${observe}
if (process.argv[1]?.endsWith('/sprite-usage.mjs')) {
  const index = process.argv.indexOf('--worktree');
  note('collector', { secret: present('BENCH_FIXTURE_SECRET_TOKEN'),
    worktree: index < 0 ? null : process.argv[index + 1], afterGolden: fs.existsSync(obs('golden')) });
}
`);
  writeFileSync(join(dir, 'launcher-probe.cjs'), `${observe}
note('launcher', { cwd: process.cwd(), secret: present('BENCH_FIXTURE_SECRET_TOKEN'), ...home(),
  allowed: present('FIXTURE_ACCESS'), git: present('GIT_FIXTURE_SENTINEL'), bench: present('BENCH_REPO'),
  launcherConfig: present('BENCH_SPRITE_START'), grace: present('BENCH_RC_GRACE_SECONDS'),
  invalid: present('FIXTURE-BAD'), unset: present('UNSET_FIXTURE'),
  path: e.PATH?.split(path.delimiter)[0] === obs('bin'),
  gradingAlreadyExists: fs.readdirSync(obs('work')).some(name => name.startsWith('bench-grade-')) });
`);
  writeFileSync(join(dir, 'tree-probe.cjs'), `${observe}
${treeDigest.toString()}
note('sprite-digest', treeDigest(process.cwd(), fs, path.join, require('node:crypto').createHash));
`);
  const pinned = mode === 'pass';
  writeFileSync(launcher, `#!/bin/sh
set -eu
[ -f ready ] && [ -s "$2" ] || exit 9
[ ! -e checks/golden.cjs ] && [ "$(git rev-parse --show-toplevel)" = "$PWD" ] || exit 9
node "$OBS/launcher-probe.cjs"
[ "$3" = "$EXPECTED_CAP" ] && [ "\${PI_MODEL-unset}" = "$EXPECTED_MODEL" ] && [ "\${PI_THINKING-unset}" = "$EXPECTED_THINKING" ] || exit 9
printf 'sprite stdout\n'
printf 'sprite stderr\n' >&2
[ "$MODE" != fail-start ] || exit 9
cp "$FIXTURE_LOG" "$SPRITES/$1.jsonl"
if [ "$MODE" = pass ] || [ "$MODE" = straggler ] || [ "$MODE" = objects ] ||
   [ "$MODE" = ignored-fifo ] || [ "$MODE" = fifo ] || [ "$MODE" = nested ]; then
  printf fixed > answer; printf 'one\ntwo\n' > added; mkdir checks; printf 'mine\n' > checks/golden.cjs
  ln checks/golden.cjs "$OBS/sprite-original"
fi
if [ "$MODE" = unstaged ] || [ "$MODE" = one-line ]; then printf fixed > answer; fi
if [ "$MODE" = unstaged ]; then
  printf 'new\n' > added; printf 'not work\n' > ignored; ln -s "$OBS/missing-target" ignored-link
  rm obsolete
fi
if [ "$MODE" = objects ]; then
  mv .git/objects moved-objects; ln -s "$PWD/moved-objects" .git/objects
  printf '/moved-objects/\\n' >> .gitignore
fi
if [ "$MODE" = ignored-fifo ]; then mkdir ignored-dir; mkfifo ignored-dir/pipe; fi
if [ "$MODE" = fifo ]; then mkfifo pipe; fi
if [ "$MODE" = bad-ignore ]; then mkfifo .gitignore.tmp; mv -f .gitignore.tmp .gitignore; fi
if [ "$MODE" = binary ]; then printf '\\000\\377\\002' > binary; chmod +x binary; fi
if [ "$MODE" = nested ]; then
  git init -q --template= nested-dir
  git init -q --template= --separate-git-dir="$OBS/outside/admin" nested-file
  git -C nested-dir config core.fsmonitor "$OBS/monitor"
  git -C nested-file config core.hooksPath "$OBS/outside"
  printf 'kept\\n' > nested-dir/content; printf 'kept\\n' > nested-file/content
fi
if [ "$MODE" = straggler ]; then rm obsolete; fi
if [ "$MODE" = symlink ]; then
  rm -r swap; ln -s "$OBS/outside" swap
  printf '/swap\\n' >> .gitignore
fi
if [ "$MODE" = unstaged ] || [ "$MODE" = objects ]; then node "$OBS/tree-probe.cjs"; fi
if [ "$MODE" != no-rc ]; then (
  printf '${pinned ? '3' : '0'}\n' > "$SPRITES/$1.pending"; mv "$SPRITES/$1.pending" "$SPRITES/$1.rc"
  if [ "$MODE" = straggler ]; then
    for i in $(seq 200); do [ ! -e "$OBS/golden" ] || break; sleep 0.01; done
    printf late > answer; mv checks saved-checks; ln -s "$OBS/outside" checks
    touch "$OBS/straggler-done"
  fi
) & fi
`, { mode: 0o700 });
  const passEnv = 'OBS,FIXTURE_LOG,SPRITES,MODE,EXPECTED_MODEL,EXPECTED_THINKING,EXPECTED_CAP,NODE_OPTIONS,'
    + 'HOME,XDG_CONFIG_HOME,XDG_CACHE_HOME,XDG_DATA_HOME,PI_MODEL,PI_THINKING,GIT_FIXTURE_SENTINEL,BENCH_REPO,BENCH_SPRITE_START,BENCH_RC_GRACE_SECONDS,FIXTURE-BAD,UNSET_FIXTURE';
  const result = spawnSync(process.execPath, [here('../run.mjs'), '--task', task.id, '--work', work, '--out', out, '--sprites', sprites,
    ...(pinned ? ['--model', 'Requested/Model', '--thinking', 'high', '--rep', '2', '--max-seconds', '3'] : [])],
  { cwd: dir, encoding: 'utf8', timeout, env: { PATH: [join(dir, 'bin'), process.env.PATH].join(':'), BENCH_REPO: cwd, BENCH_SPRITE_START: launcher,
    BENCH_PASS_ENV: passEnv + (pinned ? ',FIXTURE_ACCESS' : ''), HOME: join(dir, 'runner-home'),
    XDG_CONFIG_HOME: join(dir, 'runner-home'), XDG_CACHE_HOME: join(dir, 'runner-home'), XDG_DATA_HOME: join(dir, 'runner-home'),
    OBS: dir, NODE_OPTIONS: `--require=${preload}`,
    BENCH_FIXTURE_SECRET_TOKEN: 'placeholder', GIT_FIXTURE_SENTINEL: 'placeholder',
    FIXTURE_ACCESS: 'placeholder', 'FIXTURE-BAD': 'placeholder',
    BENCH_RC_GRACE_SECONDS: '0', FIXTURE_LOG: here('../../test/fixtures/single.jsonl'), SPRITES: sprites, MODE: mode,
    PI_MODEL: 'ignored', PI_THINKING: 'ignored', EXPECTED_MODEL: pinned ? 'Requested/Model' : 'unset',
    EXPECTED_THINKING: pinned ? 'high' : 'unset', EXPECTED_CAP: pinned ? '3' : '1' } });
  if (result.error) throw result.error;
  return { result, out, work, sprites, base, goldenRef, dir, outsideBefore, launcher: existsSync(join(dir, 'launcher')) ? json(join(dir, 'launcher')) : null };
}

for (const verdict of ['pass', 'fail']) test(`runner records golden ${verdict} and keeps subprocess output private`, t => {
  const { result, out, dir, launcher } = fixture(t, verdict);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const golden = json(join(dir, 'golden'));
  assert.deepEqual({ launcher: launcher.secret, golden: golden.secret, collector: json(join(dir, 'collector')).secret,
    setup: readFileSync(join(dir, 'setup'), 'utf8').trim().split('\n') },
  { launcher: 'absent', golden: 'absent', collector: 'absent', setup: ['absent', 'absent'] });
  for (const child of [launcher, golden]) assert.ok(child.isolated && child.xdg, 'private HOME and XDG directories');
  assert.equal(launcher.path, true);
  assert.equal(launcher.allowed, verdict === 'pass' ? 'present' : 'absent');
  for (const key of ['invalid', 'unset', 'git', 'bench', 'launcherConfig', 'grace']) assert.equal(launcher[key], 'absent', key);
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

test('grading counts unstaged and untracked work without changing any sprite bytes', t => {
  const { result, out, dir, launcher } = fixture(t, 'unstaged');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(digest(launcher.cwd), json(join(dir, 'sprite-digest')), 'sprite tree and .git must be unchanged');
  assert.deepEqual(json(out).changes, { files: 3, linesAdded: 2, linesRemoved: 2 });
});

for (const mode of ['noop', 'one-line']) test(`directory-dependent setup does not count as work (${mode})`, t => {
  const { result, out, dir, launcher } = fixture(t, mode);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(out).changes, mode === 'noop'
    ? { files: 0, linesAdded: 0, linesRemoved: 0 } : { files: 1, linesAdded: 1, linesRemoved: 1 });
  const golden = json(join(dir, 'golden'));
  assert.equal(golden.setupHere, true);
  assert.equal(golden.goldenInstalledBeforeSetup, true);
  const stats = json(join(dir, 'collector')).worktree;
  assert.equal(readFileSync(join(stats, 'setup-location'), 'utf8'), launcher.cwd);
  assert.ok(!existsSync(join(stats, 'setup-saw-golden')));
  assert.equal(git(golden.cwd, 'rev-parse', 'HEAD'), git(launcher.cwd, 'rev-parse', 'HEAD'));
});

test('grading a snapshot ignores a late edit and symlink swap in the sprite tree', t => {
  const { result, out, dir, work, launcher } = fixture(t, 'straggler');
  assert.ok(existsSync(join(dir, 'straggler-done')), 'straggler ran after exit');
  assert.equal(readFileSync(join(dir, 'outside/golden.cjs'), 'utf8'), 'untouched');
  const golden = json(join(dir, 'golden'));
  assert.notEqual(golden.cwd, launcher.cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(dirname(golden.cwd), work);
  assert.equal(lstatSync(golden.cwd).mode & 0o777, 0o700);
  assert.equal(launcher.gradingAlreadyExists, false);
  assert.equal(readFileSync(join(launcher.cwd, 'answer'), 'utf8'), 'late');
  assert.equal(readlinkSync(join(launcher.cwd, 'checks')), join(dir, 'outside'));
  const original = join(launcher.cwd, 'saved-checks/golden.cjs');
  assert.equal(readFileSync(original, 'utf8'), 'mine\n');
  assert.equal(lstatSync(original).ino, lstatSync(join(dir, 'sprite-original')).ino, 'runner never replaced the sprite file');
  const row = json(out);
  assert.equal(row.check.result, 'pass');
  assert.deepEqual(row.changes, { files: 4, linesAdded: 4, linesRemoved: 2 });
});

test('absolute .git/objects symlink leaves the sprite and outside trees unchanged', t => {
  const { result, out, dir, launcher, outsideBefore } = fixture(t, 'objects');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(out).check.result, 'pass');
  assert.equal(readlinkSync(join(launcher.cwd, '.git/objects')), join(launcher.cwd, 'moved-objects'));
  assert.equal(digest(launcher.cwd), json(join(dir, 'sprite-digest')));
  assert.equal(digest(join(dir, 'outside')), outsideBefore);
});

for (const mode of ['ignored-fifo', 'fifo']) test(`grades with a ${mode} present`, { timeout: 4000 }, t => {
  const { result, out, launcher, dir } = fixture(t, mode, 3000);
  assert.equal(result.status, 0, result.stderr);
  const note = mode === 'fifo' ? '  skipped_special=1' : '';
  assert.match(result.stdout, new RegExp(`^run  [\\w.-]+  pass${note}\\n$`));
  assert.equal(json(out).check.result, 'pass');
  const pipe = mode === 'fifo' ? 'pipe' : 'ignored-dir/pipe';
  assert.ok(lstatSync(join(launcher.cwd, pipe)).isFIFO());
  assert.ok(!existsSync(join(json(join(dir, 'collector')).worktree, pipe)));
});

function inodes(dir) {
  const result = new Set();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isDirectory()) for (const inode of inodes(path)) result.add(inode);
    if (stat.isFile()) result.add(`${stat.dev}:${stat.ino}`);
  }
  return result;
}

test('grades and collects in separate, independent clones', t => {
  const { result, dir, work, launcher } = fixture(t, 'pass');
  assert.equal(result.status, 0, result.stderr);
  const grade = json(join(dir, 'golden')).cwd;
  const { worktree: stats, afterGolden } = json(join(dir, 'collector'));
  assert.equal(afterGolden, true);
  assert.equal(new Set([stats, grade, launcher.cwd]).size, 3);
  const spriteInodes = inodes(launcher.cwd);
  for (const clone of [stats, grade]) {
    assert.equal(dirname(clone), work);
    assert.equal(lstatSync(clone).mode & 0o777, 0o700);
    assert.ok(lstatSync(join(clone, '.git/objects')).isDirectory());
    assert.equal(lstatSync(join(clone, '.git/objects/info/alternates'), { throwIfNoEntry: false }), undefined);
    assert.ok([...inodes(clone)].every(inode => !spriteInodes.has(inode)), 'no sprite hardlinks');
  }
  assert.equal(readFileSync(join(stats, 'checks/golden.cjs'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(launcher.cwd, 'checks/golden.cjs'), 'utf8'), 'mine\n');
  assert.match(readFileSync(join(grade, 'checks/golden.cjs'), 'utf8'), /process\.exitCode/);
});

test('skips nested .git directories and gitfiles without executing their config', t => {
  const { result, out, dir } = fixture(t, 'nested');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(out).check.result, 'pass');
  assert.ok(!existsSync(join(dir, 'outside/monitor-ran')));
  for (const tree of [json(join(dir, 'collector')).worktree, json(join(dir, 'golden')).cwd]) {
    for (const nested of ['nested-dir', 'nested-file']) {
      assert.equal(readFileSync(join(tree, nested, 'content'), 'utf8'), 'kept\n');
      assert.ok(!existsSync(join(tree, nested, '.git')));
    }
  }
});

test('binary patch preserves executable file contents in both clones', t => {
  const { result, out, dir } = fixture(t, 'binary');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(out).changes, { files: 1, linesAdded: 0, linesRemoved: 0 });
  for (const cwd of [json(join(dir, 'collector')).worktree, json(join(dir, 'golden')).cwd]) {
    const file = join(cwd, 'binary');
    assert.deepEqual(readFileSync(file), Buffer.from([0, 255, 2]));
    assert.equal(lstatSync(file).mode & 0o100, 0o100);
  }
});

test('a special file in place of ignore metadata refuses export without running grading setup', { timeout: 4000 }, t => {
  const { result, out, dir } = fixture(t, 'bad-ignore', 3000);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^run  [\w.-]+  not_run  refused_export\n$/);
  assert.deepEqual(json(out).outcome, { state: 'blocked', reason: 'refused_export' });
  assert.equal(json(out).changes, null);
  assert.equal(readFileSync(join(dir, 'setup'), 'utf8'), 'absent\n');
});

test('post-write export validation rejects a symlink mode', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-mode-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '--template=');
  const oid = git(dir, 'hash-object', '-w', '--', '.git/HEAD');
  git(dir, 'update-index', '--add', '--cacheinfo', `120000,${oid},link`);
  const tree = git(dir, 'write-tree');
  assert.doesNotThrow(() => verifyModes(Buffer.alloc(0)));
  const empty = execFileSync('git', ['mktree'], { cwd: dir, env, input: '' }).toString().trim();
  assert.throws(() => verifyModes(Buffer.from(git(dir, 'diff-tree', '--raw', '-r', '-z', empty, tree))), /refused_symlink/);
  assert.doesNotThrow(() => verifyModes(Buffer.from(git(dir, 'diff-tree', '--raw', '-r', '-z', tree, empty))));
});

test('a tracked directory swapped for a symlink is blocked before grading setup', t => {
  const { result, out, dir, outsideBefore } = fixture(t, 'symlink');
  assert.equal(digest(join(dir, 'outside')), outsideBefore);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^run  [\w.-]+  not_run  refused_symlink\n$/);
  assert.equal(readFileSync(join(dir, 'setup'), 'utf8'), 'absent\n', 'only pre-launch setup ran');
  assert.ok(!existsSync(join(dir, 'golden')));
  const row = json(out);
  assert.deepEqual(row.outcome, { state: 'blocked', reason: 'refused_symlink' });
  assert.deepEqual(row.check, { result: 'not_run', command: 'node' });
  assert.deepEqual(row.complexity.rating, rating);
  assert.equal(row.taskId, 'fixture');
  assert.equal(row.changes, null);
  assert.equal(json(join(dir, 'collector')).worktree, null);
});

test('a sprite without an exit file times out before any golden file is restored', t => {
  const { result, out, sprites, dir, launcher } = fixture(t, 'no-rc');
  assert.ok(readdirSync(sprites).some(file => file.endsWith('.jsonl')), 'sprite did start');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(join(launcher.cwd, 'checks/golden.cjs')));
  assert.ok(!existsSync(join(dir, 'golden')));
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
  const { result, launcher, base, goldenRef } = fixture(t, 'pass');
  assert.equal(result.status, 0, result.stderr);
  const cwd = launcher.cwd;
  assert.equal(git(cwd, 'rev-list', '--all', '--count'), '1');
  assert.equal(git(cwd, 'show', 'HEAD:answer'), 'base');
  assert.equal(git(cwd, 'remote'), '');
  for (const ref of [base, goldenRef]) {
    assert.equal(spawnSync('git', ['cat-file', '-e', ref], { cwd, env, stdio: 'ignore' }).status, 1);
  }
});
