import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fields, requireThat, thinkingLevel, validModel, validRating } from '../record.mjs';
import { exportPatch, refusedSymlink } from './export.mjs';

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
const buffered = { maxBuffer: 64 * 1024 * 1024 };
const pipeInput = { stdio: ['pipe', 'pipe', 'ignore'] };
const goldenName = ([bin, ...args]) => bin === 'pnpm' && args.includes('exec') ? args[args.indexOf('exec') + 1] : bin;

function privateDir(work, prefix) {
  const dir = mkdtempSync(join(work, prefix));
  chmodSync(dir, 0o700);
  return dir;
}

function childEnv(work, o) {
  const home = privateDir(work, 'bench-home-');
  const env = Object.assign(Object.create(null), { HOME: home, XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data') });
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'TMPDIR', ...(process.env.BENCH_PASS_ENV ?? '').split(',')]) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/^(GIT_|BENCH_)/.test(key) && !(key in env)
      && key !== 'PI_MODEL' && key !== 'PI_THINKING' && process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (o.model != null) env.PI_MODEL = o.model;
  if (o.thinking != null) env.PI_THINKING = o.thinking;
  return env;
}

function loadTask(repo, id, git, env) {
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

function goldenPath(cwd, file) {
  requireThat(realpathSync(cwd) === cwd);
  let dir = cwd;
  for (const part of file.split('/').slice(0, -1)) {
    dir = join(dir, part);
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat) requireThat(stat.isDirectory());
    else mkdirSync(dir);
  }
  return join(cwd, file);
}

function unlinkIfPresent(file) {
  try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function cloneWithPatch(work, prefix, trusted, patch, git) {
  const cwd = privateDir(work, prefix);
  git(cwd, ['clone', '--no-hardlinks', '--no-local', '--template=', trusted, '.']);
  if (patch.length) git(cwd, ['apply', '--binary', '--index', '--whitespace=nowarn'], { ...pipeInput, input: patch });
  return cwd;
}

function openOutput(path) {
  const parent = dirname(path);
  requireThat(realpathSync(parent) === parent);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const entry = fstatSync(fd);
    requireThat(entry.isFile() && entry.nlink === 1 && realpathSync(path) === path);
    const current = lstatSync(path);
    requireThat(current.dev === entry.dev && current.ino === entry.ino);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function collect({ name, sprites, task, env, out }, check, churn, note) {
  const { score, size, reason, ratedBy, ratedAt } = task.rating;
  const collector = fileURLToPath(new URL('../sprite-usage.mjs', import.meta.url));
  const rows = execFileSync(process.execPath, [collector, name, '--dir', sprites, ...churn,
    '--task', task.id, '--check', check, '--check-command', goldenName(task.goldenCommand),
    '--complexity-score', String(score), '--complexity-size', size, '--complexity-reason', reason,
    '--rated-by', ratedBy, '--rated-at', ratedAt], { env, ...capture });
  for (let offset = 0; offset < rows.length;) offset += writeSync(out, rows, offset, rows.length - offset);
  console.log(`run  ${name}  ${check}${note ? `  ${note}` : ''}`);
  return 0;
}

async function run(o, repo, task, grace, work, git, env, out) {
  const sprites = resolve(o.sprites ?? join(sep, 'tmp', 'sprites'));
  mkdirSync(sprites, { recursive: true });
  const dir = privateDir(work, 'bench-'), sprite = join(dir, 'tree');
  mkdirSync(sprite);
  const archive = git(repo, ['archive', task.base], buffered);
  const setup = cwd => {
    for (const [cmd, ...args] of task.setup) execFileSync(cmd, args, { cwd, env, ...quiet });
  };
  const initBase = cwd => {
    execFileSync('tar', ['-xf', '-'], { cwd, env, input: archive, stdio: ['pipe', 'ignore', 'ignore'] });
    git(cwd, ['init', '--template=']);
    git(cwd, ['add', '-f', '--all']);
    setup(cwd);
    // Tracked setup output belongs to the base, not to the sprite's changes.
    git(cwd, ['add', '--all']);
    git(cwd, ['-c', 'user.name=Benchmark', '-c', 'user.email=bench@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Benchmark base']);
    return git(cwd, ['rev-parse', 'HEAD']).toString().trim();
  };
  const base = initBase(sprite);
  const trustedDir = privateDir(work, 'bench-trusted-'), trusted = join(trustedDir, 'trusted.git');
  git(trustedDir, ['clone', '--bare', '--no-hardlinks', '--no-local', '--template=', sprite, trusted]);
  const brief = join(dir, 'brief.md');
  copyFileSync(join(repo, task.briefFile), brief);
  const launcher = process.env.BENCH_SPRITE_START ? resolve(process.env.BENCH_SPRITE_START) : 'sprite-start';
  const { name, prefix, lock } = await reserveName(o, sprites);
  try {
    const cap = Number(o['max-seconds'] ?? task.timeCapSeconds), wait = (cap + grace) * 1000;
    const deadline = performance.now() + wait;
    execFileSync(launcher, [name, brief, String(cap)], { cwd: sprite, env: childEnv(work, o), timeout: wait, ...quiet });
    while (!existsSync(`${prefix}.rc`)) {
      if (performance.now() >= deadline) return 1;
      await sleep(Math.min(100, deadline - performance.now()));
    }
    const measurement = { name, sprites, task, env, out };
    let stats, cwd, skipped;
    try {
      const exported = exportPatch(privateDir(work, 'bench-export-'), sprite, trusted, base, git, env);
      skipped = exported.skipped;
      stats = cloneWithPatch(work, 'bench-stats-', trusted, exported.patch, git);
      cwd = cloneWithPatch(work, 'bench-grade-', trusted, exported.patch, git);
      for (const file of task.goldenFiles) {
        const target = goldenPath(cwd, file);
        const entry = lstatSync(target, { throwIfNoEntry: false });
        requireThat(!entry || entry.isFile());
        unlinkIfPresent(target);
        writeFileSync(target, git(repo, ['show', `${task.goldenRef}:${file}`]), { flag: 'wx' });
      }
    } catch (error) {
      const reason = error.message === refusedSymlink ? refusedSymlink : 'refused_export';
      return collect(measurement, 'not_run', ['--outcome', 'blocked', '--reason', reason], reason);
    }
    setup(cwd);
    const [cmd, ...args] = task.goldenCommand;
    const verdict = spawnSync(cmd, args, { cwd, env, ...quiet });
    if (verdict.error) throw verdict.error;
    const check = verdict.status === 0 ? 'pass' : 'fail';
    return collect(measurement, check, ['--worktree', stats, '--base', base], skipped ? `skipped_special=${skipped}` : '');
  } finally { rmdirSync(lock); }
}

async function main() {
  let o, repo, grace;
  try {
    ({ values: o } = parseArgs({ options: fields('task model thinking rep out work sprites max-seconds'.split(' '), () => ({ type: 'string' })) }));
    const slash = o.model?.indexOf('/') ?? -1;
    grace = Number(process.env.BENCH_RC_GRACE_SECONDS ?? 60);
    requireThat(o.task && (o.model == null || (slash > 0 && validModel({ provider: o.model.slice(0, slash), name: o.model.slice(slash + 1) })))
      && (o.thinking == null || thinkingLevel(o.thinking)) && integer(o.rep ?? 1) && integer(o['max-seconds'] ?? 1)
      && [o.out, o.work, o.sprites].every(x => x == null || text(x)) && integer(grace, 0) && grace <= 60);
    repo = resolve(process.env.BENCH_REPO ?? fileURLToPath(new URL('../../../', import.meta.url)));
  } catch { console.error('error: invalid suite arguments or manifest'); return 2; }
  try {
    const requestedWork = resolve(o.work ?? tmpdir());
    mkdirSync(requestedWork, { recursive: true });
    const work = realpathSync(requestedWork), env = childEnv(work, o);
    const gitEnv = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const git = (cwd, args, options) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
      { cwd, env: gitEnv, ...capture, ...options });
    let task;
    try { task = loadTask(repo, o.task, git, env); }
    catch { console.error('error: invalid suite arguments or manifest'); return 2; }
    let out;
    try { out = openOutput(resolve(o.out ?? 'results.jsonl')); }
    catch { console.error('error: invalid suite output destination'); return 2; }
    try { return await run(o, repo, task, grace, work, git, env, out); }
    finally { closeSync(out); }
  } catch { console.error('error: benchmark run did not produce a record'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
