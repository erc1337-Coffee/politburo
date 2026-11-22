import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { benchStore, formatReport, isBenchRun, registerBenchSchema, report, type BenchRun } from '../src/index.ts'
import { benchCli } from '../src/bench/cli.ts'

const time = '2026-01-01T00:00:00.000Z'
const run = (runId: string, options: Partial<BenchRun> = {}): BenchRun => ({
  schema: 'bench-run@1', runId, level: 'sprite', parentId: null, taskId: 'fixture', repo: null,
  model: { provider: 'a', name: 'small' }, byModel: null, thinking: 'low', startedAt: time,
  endedAt: '2026-01-01T00:00:04.000Z', wallSeconds: 4, activeSeconds: 3.5, turns: 1, toolCalls: 2,
  tokens: { in: 8, out: 2, reasoning: null, cached: null }, costMicros: null,
  outcome: { state: 'done', reason: null }, changes: { files: 1, linesAdded: 1, linesRemoved: 1 }, reviewRounds: null,
  check: { result: 'pass', command: 'pnpm check' }, coverage: { tokens: 'complete' },
  complexity: { rating: { score: 2, size: 'S', reason: 'small scope', ratedBy: 'rater', ratedAt: time },
    proxies: { files: 1, lines: 2, reviewRounds: null, failedChecks: null, retries: null } },
  sprites: null,
  ...options,
})

async function fixture(t: TestContext, loose = false) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend })
  const writer = team.as('bench-writer')
  const author = (await writer.me()).actor
  if (loose) await team.createSchema({ name: 'bench-run', version: 1, schema: { type: 'object' } })
  else await registerBenchSchema(team)
  return { team, writer, bench: benchStore({ board: writer, author }), author }
}

test('round trips unsynced benchmark blocks', async (t) => {
  const { bench, team } = await fixture(t)
  const first = run('a~1', { parentId: 'b' })
  const { turns, toolCalls, tokens, costMicros } = first
  const second = run('b', { level: 'task', model: null,
    byModel: [{ provider: 'a', name: 'small', turns, toolCalls, tokens, costMicros }],
    sprites: { count: 1, wallSeconds: 4, activeSeconds: 3.5 } })
  await bench.record(first)
  await bench.record(second)
  assert.deepEqual(await bench.read(), [first, second])
  assert.ok((await team.channel('bench').messages()).messages.every((message) => message.noSync))
})

test('replays leave one message per ID and the first valid write wins', async (t) => {
  const { bench, team, writer } = await fixture(t)
  const first = run('once')
  await bench.record(first)
  await bench.record(first)
  await bench.record({ ...first, wallSeconds: 5 })
  assert.equal((await team.channel('bench').messages()).messages.length, 1)
  await writer.post('bench', block('bench-run@1', { ...first, wallSeconds: 6 }))
  assert.deepEqual(await bench.read(), [first])
})

test('reads ignore other writers, deleted messages, replies, other schemas, and malformed records', async (t) => {
  // A board may already have a looser schema. Use real writes to exercise reader-side validation.
  const { team, writer, bench } = await fixture(t, true)
  const first = run('keep')
  await bench.record(first)
  const root = await writer.posted('bench-run:keep')
  await team.as('other').post('bench', block('bench-run@1', run('other')))
  const gone = await writer.post('bench', block('bench-run@1', run('gone')))
  await writer.delete(gone.id)
  await writer.reply(root.id, block('bench-run@1', run('reply')))
  await team.createSchema({ name: 'other-run', version: 1, schema: { type: 'object' } })
  await writer.post('bench', block('other-run@1', run('other-schema')))
  await writer.post('bench', block('bench-run@1', { ...run('extra'), extra: true }))
  assert.deepEqual(await bench.read(), [first])
})

test('reads all 120 records across pages', async (t) => {
  const { bench } = await fixture(t)
  const runs = Array.from({ length: 120 }, (_, i) => run(`run-${i}`))
  for (const sample of runs) await bench.record(sample)
  assert.deepEqual(await bench.read(), runs)
})

test('strict validation rejects oversized reasons, unknown keys, and invalid counts but accepts nulls', () => {
  const sample = run('validate')
  assert.equal(isBenchRun({ ...sample, outcome: { state: 'failed', reason: 'x'.repeat(500) } }), false)
  assert.equal(isBenchRun({ ...sample, outcome: { ...sample.outcome, extra: true } }), false)
  assert.equal(isBenchRun({ ...sample, extra: true }), false)
  for (const count of [0.5, -1]) assert.equal(isBenchRun({ ...sample, tokens: { ...sample.tokens, in: count } }), false)
  assert.equal(isBenchRun({ ...sample, tokens: { in: null, out: null, reasoning: null, cached: null } }), true)
})

test('reports leaf statistics by model, thinking, and rating', () => {
  const a = run('a')
  const b = run('b', { wallSeconds: 10, check: { result: 'fail', command: null },
    tokens: { ...a.tokens, in: 38 }, changes: { files: 1, linesAdded: 2, linesRemoved: 1 } })
  const c = run('c', { wallSeconds: 2, tokens: { ...a.tokens, out: null }, check: { result: 'not_run', command: null } })
  const d = run('d', { thinking: 'high', tokens: { ...a.tokens, in: null }, check: { result: null, command: null } })
  const e = run('e', { model: { provider: 'b', name: 'large' }, changes: null })
  const f = run('f', { complexity: { ...a.complexity, rating: { ...a.complexity.rating!, score: 4 } } })
  const g = run('g', { complexity: { ...a.complexity, rating: null } })
  const rollup = run('parent', { level: 'mob', model: null, sprites: { count: 7, wallSeconds: 32, activeSeconds: null } })
  assert.deepEqual(report([b, c, a, d, e, f, g, rollup]).rows, [
    { ...row(a, 2), runs: 3, runIds: ['b', 'c', 'a'], checked: 2, passRate: 0.5, medianWallSeconds: 4,
      medianTokens: 25, p90Tokens: 40, tokensPerChangedLine: 10, runsWithTokens: 2, noTokens: 1 },
    { ...row(d, 2), checked: 0, passRate: null, medianTokens: null, p90Tokens: null, tokensPerChangedLine: null, runsWithTokens: 0, noTokens: 1 },
    { ...row(e, 2), tokensPerChangedLine: null }, row(f, 4), row(g, 'unrated'),
  ])
  const ten = Array.from({ length: 10 }, (_, i) => run(`rank-${i}`, { wallSeconds: i, tokens: { ...a.tokens, in: i } }))
  assert.equal(report(ten).rows[0]?.p90Tokens, 10) // Ninth of 2 through 11, not the max.
  assert.equal(report(ten).rows[0]?.medianWallSeconds, 4.5)
})

function row(sample: BenchRun, rating: 2 | 4 | 'unrated') {
  return { model: sample.model, thinking: sample.thinking, rating, runs: 1, runIds: [sample.runId], checked: 1,
    passRate: 1, medianWallSeconds: 4, medianTokens: 10, p90Tokens: 10, tokensPerChangedLine: 5, runsWithTokens: 1, noTokens: 0 }
}

test('text fits 80 columns and CLI JSON is one document with the same rows', async (t) => {
  const { writer, bench } = await fixture(t)
  const sample = run('one', { model: { provider: 'a', name: 'x'.repeat(190) } })
  await bench.record(sample)
  const data = report([sample])
  const lines = formatReport(data, { ids: true }).split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines.every((line) => /^[ -~]{1,80}$/.test(line)))
  assert.equal(lines[1], 'runs  one')
  assert.equal(formatReport(data).split('\n').length, 1)
  const printed: string[] = []
  assert.equal(await benchCli(['report', '--json'], () => writer, (line) => printed.push(line), assert.fail), 0)
  assert.equal(printed.length, 1)
  assert.deepEqual(JSON.parse(printed[0]!), data)
})

test('sprite records have no sprite summary and roll-ups must have one', () => {
  const summary = { count: 1, wallSeconds: 4, activeSeconds: null }
  assert.ok(isBenchRun(run('leaf')))
  assert.equal(isBenchRun(run('leaf', { sprites: summary })), false)
  assert.ok(isBenchRun(run('top', { level: 'task', model: null, byModel: [], sprites: summary })))
  assert.equal(isBenchRun(run('top', { level: 'task', model: null, byModel: [], sprites: null })), false)
  assert.equal(isBenchRun(run('top', { level: 'task', model: null, byModel: null, sprites: summary })), false)
})
