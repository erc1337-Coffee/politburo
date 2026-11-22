import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseSprite } from '../sprite-usage.mjs';
import { rollup } from '../rollup.mjs';
import { sanitize } from './make-fixtures.mjs';

const fixtures = new URL('./fixtures/', import.meta.url);
const fixture = name => readFileSync(new URL(`${name}.jsonl`, fixtures), 'utf8');
const from = (name, options) => parseSprite(fixture(name), { name, rc: 0, ...options });
const lines = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const start = '2025-01-01T00:00:00.000Z', end = '2025-01-01T00:00:10.125Z';
const tokens = { in: 12, out: 4, reasoning: 2, cached: 7 };
const missing = { in: null, out: null, reasoning: null, cached: null };
const changes = { files: 1, linesAdded: 2, linesRemoved: 3 };
const proxies = { files: 1, lines: 5, reviewRounds: 2, failedChecks: 3, retries: 4 };
const options = { repo: 'acme/web', task: 't1', parent: 'mob1', reviewRounds: 2, failedChecks: 3,
  retries: 4, changes, check: 'pass', checkCommand: 'verify' };

test('record has every bench-run field and expected value type', () => {
  assert.deepEqual(from('single', options), [{
    schema: 'bench-run@1', runId: 'single', level: 'sprite', parentId: 'mob1', taskId: 't1', repo: 'acme/web',
    model: { provider: 'p1', name: 'm1' }, byModel: null, thinking: 'low', startedAt: start,
    endedAt: '2025-01-01T00:00:02.000Z', wallSeconds: 2, activeSeconds: 2, turns: 1, toolCalls: 0,
    tokens, costMicros: 31, outcome: { state: 'done', reason: null }, changes, reviewRounds: 2,
    check: { result: 'pass', command: 'verify' }, coverage: { tokens: 'complete' },
    complexity: { rating: null, proxies }, sprites: null,
  }]);
});

test('served models get separate records and usage', () => {
  assert.deepEqual(from('multi').map(r => [r.runId, r.model, r.tokens]), [
    ['multi~1', { provider: 'p1', name: 'm1' }, tokens],
    ['multi~2', { provider: 'p1', name: 'm2' }, { ...tokens, in: 3 }],
  ]);
});

test('only message_end counts, once by response ID or fallback', () => {
  const single = fixture('single');
  for (const text of [single, fixture('restart'), single.repeat(2).replace(/"responseId":"r1",/g, '')]) {
    const [r] = parseSprite(text, { name: 's', rc: 0 });
    assert.deepEqual([r.turns, r.tokens, r.costMicros], [1, tokens, 31]);
  }
});

test('no assistant usage means null counts and cost', () => {
  const [r] = from('unknown');
  assert.deepEqual([r.tokens, r.costMicros, r.coverage.tokens], [missing, null, 'none']);
});

test('exit status and final assistant error determine outcome unless blocked', () => {
  for (const [rc, state, reason] of [[0, 'done', null], [124, 'failed', 'timeout'], [125, 'failed', 'idle'],
    [130, 'canceled', null], [137, 'canceled', null], [143, 'canceled', null], [4, 'failed', 'exit 4']]) {
    assert.deepEqual(from('single', { rc })[0].outcome, { state, reason });
  }
  assert.deepEqual(from('error')[0].outcome, { state: 'failed', reason: 'model_error' });
  assert.deepEqual(from('error', { outcome: 'blocked', reason: 'waiting' })[0].outcome, { state: 'blocked', reason: 'waiting' });
});

test('active time clips and subtracts the union of parallel tool waits', () => {
  const wait = (toolCallId, offset, durationMs) => [
    { type: 'tool_execution_end', toolCallId, durationMs },
    { type: 'message_end', message: { role: 'toolResult', toolCallId, timestamp: Date.parse(start) + offset } },
  ];
  function collect(first, second) {
    return parseSprite(fixture('single') + lines([...wait('c1', 4000, first), ...wait('c2', 6000, second)]), { name: 'tools', rc: 0 })[0];
  }
  const r = collect(3000, 4000);
  assert.deepEqual([r.wallSeconds, r.activeSeconds, r.toolCalls], [6, 1, 2]);
  assert.equal(collect(7000, 4000).activeSeconds, 0);
  assert.equal(collect(undefined, 4000).activeSeconds, null);
});

test('roll-up keeps models, sums known leaves once, and uses its own clock', () => {
  const [a, b] = from('multi', options), [c] = from('unknown');
  const o = { level: 'task', id: 'task1', started: start, ended: end };
  const r = rollup([a, a, b, c], o);
  assert.deepEqual([r.model, r.turns, r.tokens, r.costMicros, r.wallSeconds, r.coverage.tokens],
    [null, 3, { in: 15, out: 8, reasoning: 4, cached: 14 }, 62, 10.125, 'partial']);
  assert.deepEqual(r.sprites, { count: 2, wallSeconds: 5, activeSeconds: 5 });
  assert.deepEqual(r.complexity.proxies, proxies);
  assert.deepEqual(r.byModel, [
    { provider: 'p1', name: 'm1', turns: 2, toolCalls: 0, costMicros: 31, tokens },
    { provider: 'p1', name: 'm2', turns: 1, toolCalls: 0, costMicros: 31, tokens: { ...tokens, in: 3 } },
  ]);
  const nested = rollup([r, r], { ...o, level: 'pr', id: 'pr1' });
  assert.deepEqual([nested.byModel, nested.sprites, nested.tokens, nested.coverage.tokens],
    [r.byModel, r.sprites, r.tokens, 'partial']);
  const unknown = rollup([c], o);
  assert.deepEqual([unknown.tokens, unknown.costMicros, unknown.coverage.tokens], [missing, null, 'none']);
  assert.equal(rollup([a], o).coverage.tokens, 'complete');
  assert.equal(rollup([a], { ...o, level: 'mob', mobSession: 'claude' }).coverage.tokens, 'partial');
});

test('fixtures and generator retain only safe fields and values', () => {
  for (const file of readdirSync(fixtures)) {
    const text = readFileSync(new URL(file, fixtures), 'utf8');
    const rows = text.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(JSON.parse(JSON.stringify(sanitize(text))), rows);
    JSON.stringify(rows, (key, value) => {
      if (typeof value === 'string') assert.match(value, /^(?!.*\b(?:prompt|token)\b)[^/\\]{0,64}$/i);
      return value;
    });
  }
  const input = { type: 'message_end', message: { role: 'assistant', content: 'sample', responseId: 'sample' } };
  assert.equal(lines(sanitize(lines([input]))), lines([{ type: 'message_end', message: { role: 'assistant', responseId: 'r1' } }]));
});

test('CLIs emit only records, distinguish running from missing, and reject invalid JSONL', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invoke = (script, ...args) => spawnSync(process.execPath,
    [fileURLToPath(new URL(`../${script}.mjs`, import.meta.url)), ...args], { encoding: 'utf8' });
  const sprite = name => invoke('sprite-usage', name, '--dir', dir);
  const file = (name, text) => { const path = join(dir, name); writeFileSync(path, text); return path; };
  const exited = (result, code) => assert.deepEqual([result.status, result.stdout], [code, '']);
  exited(sprite('missing'), 2);
  file('multi.jsonl', fixture('multi'));
  exited(sprite('multi'), 3);
  file('multi.rc', '0\n');
  mkdirSync(join(dir, 'multi'));
  file('multi/a', ''); file('multi/b', '');
  const run = sprite('multi');
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, lines(from('multi', { retries: 1 })), '']);
  const task = input => invoke('rollup', '--level', 'task', '--id', 'task1', '--started', start, '--ended', end, input);
  const rolled = task(file('runs.jsonl', run.stdout + run.stdout));
  assert.equal(rolled.status, 0);
  assert.equal(JSON.parse(rolled.stdout).turns, 2);
  exited(task(file('bad.jsonl', run.stdout + '{"schema":"bench-run@1"}\n')), 2);
});

test('a sprite record carries the brief author\'s rating, and an invalid rating is refused', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'one.jsonl'), fixture('single'));
  writeFileSync(join(dir, 'one.rc'), '0\n');
  const rate = score => spawnSync(process.execPath, [fileURLToPath(new URL('../sprite-usage.mjs', import.meta.url)), 'one',
    '--dir', dir, '--complexity-score', score, '--complexity-size', 'M', '--complexity-reason', 'one small module',
    '--rated-by', 'author', '--rated-at', '2025-01-01T00:00:00Z'], { encoding: 'utf8' });
  const ok = rate('3');
  assert.deepEqual([ok.status, JSON.parse(ok.stdout).complexity.rating], [0, {
    score: 3, size: 'M', reason: 'one small module', ratedBy: 'author', ratedAt: '2025-01-01T00:00:00.000Z' }]);
  assert.deepEqual([rate('9').status, rate('9').stdout], [2, '']);
});
