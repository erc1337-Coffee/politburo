import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fields, requireThat, thinkingLevel, validModel, validRating } from '../record.mjs';

const PREFIX = 'bench', SUITE = 'tools/bench/suite';
const slug = value => value == null ? 'default' : value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
export function runName(id, model, thinking, rep, unixSeconds) {
  return `${PREFIX}.${slug(id)}.${slug(model)}.${slug(thinking)}.r${rep}.${unixSeconds}`;
}

const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const text = x => typeof x === 'string' && x.trim() && !/[\0\r\n]/.test(x);
const argv = x => Array.isArray(x) && text(x[0]) && x.every(s => typeof s === 'string' && !s.includes('\0'));
const treePath = x => text(x) && x.split('/').every(part => /^[a-z0-9_.-]+$/i.test(part)
  && !['.', '..', '.git'].includes(part.toLowerCase()));
const integer = (x, min = 1) => /^\d+$/.test(String(x)) && Number.isSafeInteger(Number(x)) && Number(x) >= min;
const quiet = { stdio: 'ignore' };
const capture = { stdio: ['ignore', 'pipe', 'ignore'] };
// Do not let inherited Git routing or object-store overrides reach the scratch repo.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, args, options) => execFileSync('git', args, { cwd, env, ...capture, ...options });
const goldenName = ([bin, ...args]) => bin === 'pnpm' && args.includes('exec') ? args[args.indexOf('exec') + 1] : bin;

function loadTask(repo, id) {
  const matches = JSON.parse(readFileSync(join(repo, SUITE, 'tasks.json'), 'utf8')).filter(x => x.id === id);
  const [task] = matches;
  requireThat(matches.length === 1 && /^[a-z0-9][a-z0-9-]*$/.test(id) && text(task.title)
    && sha(task.base) && sha(task.goldenRef) && task.base !== task.goldenRef
    && task.briefFile === `${SUITE}/briefs/${id}.md`
    && Array.isArray(task.goldenFiles) && task.goldenFiles.length && task.goldenFiles.every(treePath)
    && new Set(task.goldenFiles).size === task.goldenFiles.length
    && argv(task.goldenCommand) && /^[a-z0-9_.-]+$/i.test(goldenName(task.goldenCommand) ?? '')
    && Array.isArray(task.setup) && task.setup.every(argv)
    && Number.isSafeInteger(task.timeCapSeconds) && integer(task.timeCapSeconds)
    && validRating(task.rating) && task.rating.ratedBy === '218-BEE7'
    && text(task.rating.reason) && !/[\\/]/.test(task.rating.reason));
  for (const ref of [task.base, task.goldenRef]) requireThat(git(repo, ['cat-file', '-t', ref]).toString().trim() === 'commit');
  requireThat(git(repo, ['rev-parse', `${task.goldenRef}^1`]).toString().trim() === task.base);
  for (const file of task.goldenFiles) {
    requireThat(git(repo, ['cat-file', '-t', `${task.goldenRef}:${file}`]).toString().trim() === 'blob');
    requireThat(spawnSync('git', ['cat-file', '-e', `${task.base}:${file}`], { cwd: repo, env, ...quiet }).status === 128);
  }
  requireThat(readFileSync(join(repo, task.briefFile), 'utf8').trim());
  return task;
}

async function reserveName(o, sprites) {
  for (;;) {
    const name = runName(o.task, o.model, o.thinking, Number(o.rep ?? 1), Math.floor(Date.now() / 1000));
    const prefix = join(sprites, name), lock = `${prefix}.bench-lock`;
    try { mkdirSync(lock); }
    catch (e) { if (e.code !== 'EEXIST') throw e; await sleep(100); continue; }
    if (!['', '.rc', '.jsonl', '.out'].some(suffix => existsSync(prefix + suffix))) return { name, prefix, lock };
    rmdirSync(lock);
    await sleep(100);
  }
}

function copyGolden(repo, cwd, task) {
  requireThat(realpathSync(cwd) === cwd);
  for (const file of task.goldenFiles) {
    const target = join(cwd, file);
    // Create one directory at a time, without writing through a sprite's symlink.
    let dir = cwd;
    for (const part of file.split('/').slice(0, -1)) {
      dir = join(dir, part);
      if (!existsSync(dir)) mkdirSync(dir);
      requireThat(realpathSync(dir) === dir);
    }
    try { unlinkSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    writeFileSync(target, git(repo, ['show', `${task.goldenRef}:${file}`]), { flag: 'wx' });
  }
}

async function run(o, repo, task, grace) {
  const work = resolve(o.work ?? tmpdir()), sprites = resolve(o.sprites ?? join(sep, 'tmp', 'sprites'));
  const out = resolve(o.out ?? 'results.jsonl');
  mkdirSync(work, { recursive: true });
  mkdirSync(sprites, { recursive: true });
  const dir = mkdtempSync(join(realpathSync(work), 'bench-')), cwd = join(dir, 'tree');
  mkdirSync(cwd);
  const archive = git(repo, ['archive', task.base], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-'], { cwd, input: archive, stdio: ['pipe', 'ignore', 'ignore'] });
  git(cwd, ['init', '--template=']);
  git(cwd, ['add', '-f', '--all']);
  git(cwd, ['-c', 'user.name=Benchmark', '-c', 'user.email=bench@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Benchmark base']);
  for (const [cmd, ...args] of task.setup) execFileSync(cmd, args, { cwd, env, ...quiet });
  // Setup output (a lockfile touch, a build) belongs to the base, not to the sprite's changes.
  git(cwd, ['add', '--all']);
  git(cwd, ['-c', 'user.name=Benchmark', '-c', 'user.email=bench@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--amend', '--allow-empty', '--no-edit', '--no-gpg-sign']);
  const base = git(cwd, ['rev-parse', 'HEAD']).toString().trim();
  const brief = join(dir, 'brief.md');
  copyFileSync(join(repo, task.briefFile), brief);

  const launcher = process.env.BENCH_SPRITE_START ? resolve(process.env.BENCH_SPRITE_START) : 'sprite-start';
  const spriteEnv = { ...env };
  for (const key of ['BENCH_REPO', 'BENCH_SPRITE_START', 'BENCH_RC_GRACE_SECONDS', 'PI_MODEL', 'PI_THINKING']) delete spriteEnv[key];
  if (o.model != null) spriteEnv.PI_MODEL = o.model;
  if (o.thinking != null) spriteEnv.PI_THINKING = o.thinking;
  const { name, prefix, lock } = await reserveName(o, sprites);
  try {
    const cap = Number(o['max-seconds'] ?? task.timeCapSeconds), wait = (cap + grace) * 1000;
    const deadline = performance.now() + wait;
    execFileSync(launcher, [name, brief, String(cap)], { cwd, env: spriteEnv, timeout: wait, ...quiet });
    while (!existsSync(`${prefix}.rc`)) {
      if (performance.now() >= deadline) return 1;
      await sleep(Math.min(100, deadline - performance.now()));
    }
    // Stage the sprite's work so files it created count as changes; the golden files come after.
    git(cwd, ['add', '--all']);
    copyGolden(repo, cwd, task);
    const [cmd, ...args] = task.goldenCommand;
    const verdict = spawnSync(cmd, args, { cwd, env, ...quiet });
    if (verdict.error) throw verdict.error;
    const check = verdict.status === 0 ? 'pass' : 'fail';
    // Put back what the sprite had at each golden path, so restored test code is not counted as its change.
    for (const file of task.goldenFiles) {
      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd, env, ...quiet }).status === 0;
      if (tracked) git(cwd, ['checkout', '--', file]);
      else unlinkSync(join(cwd, file));
    }
    const { score, size, reason, ratedBy, ratedAt } = task.rating;
    const collector = fileURLToPath(new URL('../sprite-usage.mjs', import.meta.url));
    const rows = execFileSync(process.execPath, [collector, name, '--dir', sprites, '--worktree', cwd, '--base', base,
      '--task', task.id, '--check', check, '--check-command', goldenName(task.goldenCommand),
      '--complexity-score', String(score), '--complexity-size', size, '--complexity-reason', reason,
      '--rated-by', ratedBy, '--rated-at', ratedAt], { env, ...capture });
    appendFileSync(out, rows);
    console.log(`run  ${name}  ${check}`);
    return 0;
  } finally { rmdirSync(lock); }
}

async function main() {
  let o, repo, task, grace;
  try {
    ({ values: o } = parseArgs({ options: fields('task model thinking rep out work sprites max-seconds'.split(' '), () => ({ type: 'string' })) }));
    const slash = o.model?.indexOf('/') ?? -1;
    grace = Number(process.env.BENCH_RC_GRACE_SECONDS ?? 60);
    requireThat(o.task && (o.model == null || (slash > 0 && validModel({ provider: o.model.slice(0, slash), name: o.model.slice(slash + 1) })))
      && (o.thinking == null || thinkingLevel(o.thinking)) && integer(o.rep ?? 1) && integer(o['max-seconds'] ?? 1)
      && [o.out, o.work, o.sprites].every(x => x == null || text(x)) && integer(grace, 0) && grace <= 60);
    repo = resolve(process.env.BENCH_REPO ?? fileURLToPath(new URL('../../../', import.meta.url)));
    task = loadTask(repo, o.task);
  } catch { console.error('error: invalid suite arguments or manifest'); return 2; }
  try { return await run(o, repo, task, grace); }
  catch { console.error('error: benchmark run did not produce a record'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
