import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { board, BoardError, type MessageView } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { oidcTokens } from '@vercel/board/access'
// Only the test issuer fixture is shared; no imports from board's implementation.
import { BOARD_URL, caller, localUserToken, testLocal } from '../../board/test/tokens.ts'
import type { Harness, RunRef } from '../src/harness.ts'
import { runTask } from '../src/runner.ts'
import { subprocess } from '../src/subprocess.ts'
import { fixtureStart, output, terminal, waitFor } from './support.ts'

async function openBoard(t: TestContext) {
  const backend = local({ memory: true })
  t.after(() => backend.close())
  const team = board({ backend, url: BOARD_URL, authenticate: oidcTokens({ local: testLocal }) })
  const request = caller(team.fetch, await localUserToken('runtime-test'))
  return {
    team,
    async task(id: string) {
      const response = await request('GET', `/messages/${id}`)
      assert.equal(response.status, 200)
      return (response.body.message as MessageView).task!
    },
  }
}

function job(t: TestContext) {
  const fixture = fileURLToPath(new URL('./fixtures/process.mjs', import.meta.url))
  const processHarness = subprocess({ command: process.execPath, args: [fixture] })
  const runs: RunRef[] = []
  const harness: Harness = {
    ...processHarness,
    async start(input) {
      const ref = await processHarness.start(input)
      runs.push(ref)
      return ref
    },
  }
  t.after(async () => { await Promise.all(runs.map((ref) => harness.cancel(ref))) })
  return {
    harness, runs,
    options: { harness, work: fixtureStart(10_000).work, provider: 'fixture', pollMs: 10, renewEveryMs: 100 },
    ready: () => waitFor(async () => {
      const ref = runs[0]
      return ref && (await output(harness, ref)).includes('ready\n') ? ref : undefined
    }),
  }
}

test('runner renews a selected task, reports exit, and releases without completing it', async (t) => {
  const { team, task } = await openBoard(t)
  const { task: selected } = await team.tasks.create('runtime/fixtures', { text: 'selected', labels: { queue: 'yes' } })
  const { task: skipped } = await team.tasks.create('runtime/fixtures', 'not selected')
  const { task: waiting } = await team.tasks.create('runtime/fixtures', { text: 'waiting', needs: [selected.id] })
  const { options, harness, ready } = job(t)
  const run = runTask({ ...options, board: team, selection: { channel: 'runtime/fixtures', label: { queue: 'yes' } } })
  // Keep the fixture running until the public task view shows an extended lease.
  const ref = await ready()
  const first = (await task(selected.id)).claim?.until
  assert.ok(first)
  await waitFor(async () => {
    const until = (await task(selected.id)).claim?.until
    return until && until > first ? until : undefined
  })
  assert.equal(await harness.send(ref, { id: 'finish', text: 'finish\n' }), 'accepted')
  assert.deepEqual(await run, {
    status: 'released', taskId: selected.id, run: ref,
    result: { outcome: 'exited', exitCode: 0, artifacts: [], usage: null },
  })
  assert.equal((await task(selected.id)).state, 'ready')
  assert.equal((await task(skipped.id)).state, 'ready')
  assert.equal((await task(waiting.id)).state, 'waiting')
  await (await team.as('next-worker').tasks.claim(selected.id)).release()
})

test('runner cancels its process and does not settle after the task owner revokes its lease', async (t) => {
  const { team, task } = await openBoard(t)
  const { task: selected } = await team.tasks.create('runtime/fixtures', 'revocable task')
  const { options, harness, ready } = job(t)
  const run = runTask({ ...options, board: team.as('worker'), taskId: selected.id })
  const ref = await ready()
  assert.equal(await harness.collect(ref), 'not_terminal')
  await team.tasks.cancel(selected.id, 'revoked by owner')
  assert.deepEqual(await run, { status: 'lease_lost', taskId: selected.id })
  assert.equal((await terminal(harness, ref)).outcome, 'canceled')
  assert.equal((await task(selected.id)).state, 'canceled')
  assert.equal((await team.thread(selected.id)).replies.length, 0)
})

test('two runners racing for one claim launch just one process', async (t) => {
  const { team, task } = await openBoard(t)
  const { task: selected } = await team.tasks.create('runtime/fixtures', 'one claim')
  const { options, harness, ready, runs } = job(t)
  const workers = ['ada', 'grace'].map((name) => runTask({ ...options, board: team.as(name), taskId: selected.id })
    .then((value) => ({ value }), (error: unknown) => ({ error })))
  const first = await Promise.race(workers)
  assert.ok('error' in first && first.error instanceof BoardError)
  assert.equal(first.error.code, 'task_claimed')
  const ref = await ready()
  assert.equal((await task(selected.id)).state, 'claimed')
  assert.deepEqual(runs, [ref])
  await harness.send(ref, { id: 'finish', text: 'finish\n' })
  const outcomes = await Promise.all(workers)
  assert.equal(outcomes.filter((result) => 'value' in result && result.value.status === 'released').length, 1)
  assert.equal((await task(selected.id)).state, 'ready')
})
