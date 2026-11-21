import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import timers from 'node:timers/promises'
import { heartbeat, nextBeat, stallWatcher, type HeartbeatBoard, type StallAgent, type StallBoard, type StallWatcherOptions } from '../src/index.ts'

const minute = 60_000
const start = Date.UTC(2026, 0, 1)

function forbidTimers(t: TestContext) {
  const fail = () => assert.fail('use the fake clock instead of setTimeout')
  t.mock.method(globalThis, 'setTimeout', fail)
  t.mock.method(timers, 'setTimeout', fail)
}

function fakeClock(time = start) {
  const sleeps: number[] = []
  return {
    now: () => time,
    advance(ms: number) { time += ms },
    async sleep(ms: number, signal: AbortSignal) {
      sleeps.push(ms)
      assert.ok(sleeps.length <= 2, 'unexpected extra beat')
      signal.throwIfAborted()
      time += ms
    },
    sleeps,
  }
}

test('nextBeat uses the epoch grid, wraps offsets, and skips the current slot', () => {
  const beat = (now: number) => nextBeat({ everyMinutes: 10, offsetMinutes: 23, now })
  assert.equal(beat(3 * minute - 1), 3 * minute)
  assert.equal(beat(3 * minute), 13 * minute)
  assert.equal(beat(-7 * minute - 1), -7 * minute)
  assert.equal(beat(-7 * minute), 3 * minute)
})

test('nextBeat at the epoch skips the slot at zero', () => {
  assert.equal(nextBeat({ everyMinutes: 10, offsetMinutes: 0, now: 0 }), 10 * minute)
  assert.equal(nextBeat({ everyMinutes: 10, offsetMinutes: 3, now: 0 }), 3 * minute)
})

test('nextBeat rejects nonpositive or noninteger periods', () => {
  for (const everyMinutes of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => nextBeat({ everyMinutes, offsetMinutes: 0, now: start }), RangeError)
  }
})

test('nextBeat rejects negative or noninteger offsets', () => {
  for (const offsetMinutes of [-1, 0.5, Infinity, NaN]) {
    assert.throws(() => nextBeat({ everyMinutes: 30, offsetMinutes, now: start }), RangeError)
  }
})

test('heartbeat staggers writes by offset, stays on the grid after a slow write, and stops on abort', async (t) => {
  forbidTimers(t)
  async function run(id: string, generation: number, offsetMinutes: number) {
    const clock = fakeClock(start + minute)
    const stop = new AbortController()
    const writes: { id: string; generation: number; at: number }[] = []
    const handle: HeartbeatBoard = {
      agents: {
        async heartbeat(id, generation) {
          writes.push({ id, generation, at: clock.now() })
          if (writes.length === 2) stop.abort()
          else clock.advance(250)
        },
      },
    }
    await heartbeat(handle, { id, generation }, { ...clock, everyMinutes: 10, offsetMinutes, signal: stop.signal })
    return { writes, sleeps: clock.sleeps }
  }

  const [worker, reviewer] = await Promise.all([run('worker', 3, 2), run('reviewer', 7, 16)])
  assert.deepEqual(worker.writes, [
    { id: 'worker', generation: 3, at: start + 2 * minute },
    { id: 'worker', generation: 3, at: start + 12 * minute },
  ])
  assert.deepEqual(reviewer.writes, [
    { id: 'reviewer', generation: 7, at: start + 6 * minute },
    { id: 'reviewer', generation: 7, at: start + 16 * minute },
  ])
  assert.deepEqual(worker.sleeps, [minute, 10 * minute - 250])
  assert.deepEqual(reviewer.sleeps, [5 * minute, 10 * minute - 250])
})

test('heartbeat default sleep waits at least the requested delay', async (t) => {
  const everyMinutes = 40_000
  const due = everyMinutes * minute
  const clock = fakeClock(0.5)
  const stop = new AbortController()
  t.mock.method(globalThis, 'setTimeout', () => assert.fail('use the fake clock instead of setTimeout'))
  t.mock.method(timers, 'setTimeout', async (ms: number, _value: unknown, { signal }: { signal: AbortSignal }) => {
    assert.equal(signal, stop.signal)
    signal.throwIfAborted()
    // Node truncates fractional delays and falls back to 1 ms for oversized delays.
    clock.advance(ms > 2_147_483_647 ? 1 : Math.trunc(ms))
  })
  const beats: number[] = []
  const handle: HeartbeatBoard = {
    agents: { async heartbeat() { beats.push(clock.now()); stop.abort() } },
  }
  await heartbeat(handle, { id: 'worker', generation: 1 }, {
    now: clock.now, everyMinutes, offsetMinutes: 0, signal: stop.signal,
  })
  assert.equal(beats.length, 1)
  assert.ok(beats[0]! >= due, 'heartbeat ran before its slot')
})

for (const rejects of [false, true]) {
  test(`aborting before the beat stops the runner if sleep ${rejects ? 'rejects' : 'resolves'}`, async (t) => {
    forbidTimers(t)
    const clock = fakeClock()
    const stop = new AbortController()
    const handle = { agents: { async heartbeat() { assert.fail('no beat after abort') } } }
    await heartbeat(handle, { id: 'worker', generation: 1 }, {
      now: clock.now, everyMinutes: 1, offsetMinutes: 0, signal: stop.signal,
      async sleep(ms, signal) {
        assert.equal(signal, stop.signal)
        await clock.sleep(ms, signal)
        stop.abort()
        if (rejects) signal.throwIfAborted()
      },
    })
    assert.deepEqual(clock.sleeps, [minute])
  })
}

for (const status of [409, 503]) {
  test(`heartbeat rethrows a ${status} without retrying`, async (t) => {
    forbidTimers(t)
    const failure = Object.assign(new Error('beat failed'), { status })
    const clock = fakeClock()
    let writes = 0
    const handle = { agents: { async heartbeat() { writes++; throw failure } } }
    await assert.rejects(heartbeat(handle, { id: 'worker', generation: 1 }, {
      ...clock, everyMinutes: 1, offsetMinutes: 0, signal: new AbortController().signal,
    }), (error) => error === failure)
    assert.equal(writes, 1)
    assert.deepEqual(clock.sleeps, [minute])
  })
}

const channel = 'runtime/work'
const recipient = { role: 'operator' }

function registration(id: string, beatAt: number | null, fields: Partial<StallAgent> = {}): StallAgent {
  return { id, role: 'implementation-worker', status: 'enabled', heartbeatAt: beatAt === null ? null : new Date(beatAt).toISOString(), ...fields }
}

function fixture(t: TestContext, options: Partial<StallWatcherOptions> = {}) {
  forbidTimers(t)
  const clock = fakeClock()
  const events: { createdAt: string }[] = []
  const polls: Parameters<StallBoard['poll']>[0][] = []
  const sent: Parameters<StallBoard['operationalInbox']['send']>[0][] = []
  const state = { agents: [] as StallAgent[], paused: false, statusError: undefined as Error | undefined, sendError: undefined as Error | undefined }
  const handle: StallBoard = {
    async poll(query) {
      polls.push(query)
      const { after, wait, last } = query
      const cursor = `feed:${events.length}`
      if (last !== undefined) {
        assert.equal(after, undefined)
        assert.equal(wait, undefined)
        return { cursor, events: events.slice(-last) }
      }
      assert.equal(wait, 0)
      const from = after === undefined ? events.length : Number(after.slice('feed:'.length))
      return { cursor, events: events.slice(from) }
    },
    agents: { async list(scope) { assert.equal(scope, channel); return { agents: state.agents } } },
    async status() {
      if (state.statusError) throw state.statusError
      return { paused: state.paused }
    },
    operationalInbox: {
      async send(message) {
        if (state.sendError) throw state.sendError
        sent.push(message)
      },
    },
  }
  const { check } = stallWatcher(handle, { channel, to: recipient, now: clock.now, ...options })
  function post(at = clock.now()) {
    events.push({ createdAt: new Date(at).toISOString() })
  }
  return { check, state, clock, handle, events, post, polls, sent, topics: () => sent.map(({ topic }) => topic).sort() }
}

test('the default quiet window starts at watcher creation and includes its exact boundary', async (t) => {
  const f = fixture(t)
  f.clock.advance(30 * minute - 1)
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.deepEqual(f.sent, [])
  f.clock.advance(1)
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: start, quietMinutes: 30 })
  assert.deepEqual(f.sent.map(({ to, topic }) => ({ to, topic })), [{ to: recipient, topic: 'stall:quiet' }])
})

test('a recent enabled heartbeat keeps the watcher active until that timestamp ages out', async (t) => {
  const f = fixture(t, { quietMinutes: 5, periodMinutes: () => undefined })
  const beatAt = start + 6 * minute
  f.state.agents.push(registration('worker', beatAt))
  f.clock.advance(11 * minute - 1)
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.deepEqual(f.sent, [])
  f.clock.advance(1)
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: beatAt, quietMinutes: 5 })
  assert.deepEqual(f.topics(), ['stall:quiet'])
})

test('retiring and re-registering an agent does not erase its observed heartbeat', async (t) => {
  const f = fixture(t, { quietMinutes: 5 })
  f.clock.advance(4 * minute)
  const beatAt = f.clock.now()
  f.state.agents.push(registration('worker', beatAt, { generation: 1 }))
  assert.deepEqual(await f.check(), { kind: 'ok' })

  f.clock.advance(minute)
  f.state.agents[0] = registration('worker', null, { generation: 2, status: 'disabled' })
  assert.deepEqual(await f.check(), { kind: 'ok' })
  f.clock.advance(minute)
  f.state.agents[0] = registration('worker', null, { generation: 3 })
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.deepEqual(f.sent, [])

  f.clock.advance(3 * minute)
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: beatAt, quietMinutes: 5 })
  assert.deepEqual(f.topics(), ['stall:quiet'])
})

test('the first check sees a post made after watcher creation and uses its timestamp', async (t) => {
  const f = fixture(t, { quietMinutes: 5 })
  f.clock.advance(2 * minute)
  const postedAt = f.clock.now()
  f.post()
  f.clock.advance(3 * minute)
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.deepEqual(f.polls, [{ last: 25 }])
  assert.deepEqual(f.sent, [])

  f.clock.advance(2 * minute)
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: postedAt, quietMinutes: 5 })
  assert.deepEqual(f.polls, [{ last: 25 }, { after: 'feed:1', wait: 0 }])
  assert.deepEqual(f.topics(), ['stall:quiet'])
})

test('old feed events on the first check do not postpone quiet', async (t) => {
  const f = fixture(t, { quietMinutes: 5 })
  f.post(start - minute)
  f.post(start - 1)
  f.clock.advance(5 * minute)
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: start, quietMinutes: 5 })
  assert.deepEqual(f.topics(), ['stall:quiet'])
})

test('new feed events keep the watcher active, but past events do not count again', async (t) => {
  const f = fixture(t, { quietMinutes: 2 })
  assert.deepEqual(await f.check(), { kind: 'ok' })
  for (let i = 0; i < 3; i++) {
    f.clock.advance(2 * minute)
    f.post()
    assert.deepEqual(await f.check(), { kind: 'ok' })
  }
  assert.deepEqual(f.sent, [])
  f.clock.advance(2 * minute)
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: start + 6 * minute, quietMinutes: 2 })
  assert.deepEqual(f.topics(), ['stall:quiet'])
})

test('feed activity uses the newest parseable timestamp, capped at the check time', async (t) => {
  const f = fixture(t, { quietMinutes: 2 })
  assert.deepEqual(await f.check(), { kind: 'ok' })
  f.clock.advance(2 * minute)
  const checkedAt = f.clock.now()
  f.post(checkedAt + 5 * minute)
  f.post(start)
  f.events.push({ createdAt: 'unparseable' })
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.deepEqual(f.sent, [])

  f.clock.advance(2 * minute)
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: checkedAt, quietMinutes: 2 })
  assert.deepEqual(f.topics(), ['stall:quiet'])
})

test('only agents older than twice their configured period are missed', async (t) => {
  const f = fixture(t, {
    to: { agent: 'owner' },
    periodMinutes: ({ role }) => role === 'reviewer' ? undefined : 5,
  })
  const { id, role, heartbeatAt } = registration('worker', start - minute)
  f.state.agents.push({ id, role, heartbeatAt, status: 'enabled' }, registration('reviewer', start - 70 * minute, { role: 'reviewer' }))
  f.clock.advance(9 * minute)
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.equal(f.sent.length, 0)
  f.clock.advance(1)
  assert.deepEqual(await f.check(), {
    kind: 'missed', agents: [{ id, role, heartbeatAt, ageMs: 10 * minute + 1, limitMs: 10 * minute }],
  })
  assert.deepEqual(f.sent.map(({ to, topic }) => ({ to, topic })), [{ to: { agent: 'owner' }, topic: 'stall:missed:worker' }])
  assert.ok(f.sent[0]!.text.includes(id) && f.sent[0]!.text.includes(`${10 * minute + 1} ms`))
})

test('an agent with no heartbeat gets two default periods of grace from watcher creation', async (t) => {
  const f = fixture(t, { quietMinutes: 90 })
  const agent = registration('worker', null)
  f.state.agents.push(agent)
  f.clock.advance(60 * minute)
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.deepEqual(f.sent, [])
  f.clock.advance(1)
  assert.deepEqual(await f.check(), {
    kind: 'missed', agents: [{ id: agent.id, role: agent.role, heartbeatAt: null, ageMs: 60 * minute + 1, limitMs: 60 * minute }],
  })
  assert.deepEqual(f.topics(), ['stall:missed:worker'])
})

test('a later registration with no heartbeat gets grace from its first observation', async (t) => {
  const f = fixture(t, { quietMinutes: 90, periodMinutes: 5 })
  assert.deepEqual(await f.check(), { kind: 'ok' })
  f.clock.advance(15 * minute)
  const agent = registration('worker', null, { generation: 1 })
  f.state.agents.push(agent)
  const { id, role, heartbeatAt } = agent
  assert.deepEqual(await f.check(), { kind: 'ok' })
  f.clock.advance(10 * minute)
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.deepEqual(f.sent, [])

  f.clock.advance(1)
  assert.deepEqual(await f.check(), {
    kind: 'missed', agents: [{ id, role, heartbeatAt, ageMs: 10 * minute + 1, limitMs: 10 * minute }],
  })
  assert.deepEqual(f.topics(), ['stall:missed:worker'])
})

test('a generation change restarts grace for an agent with no heartbeat', async (t) => {
  const f = fixture(t, { quietMinutes: 90, periodMinutes: 5 })
  const agent = registration('worker', null, { generation: 1 })
  f.state.agents.push(agent)
  assert.deepEqual(await f.check(), { kind: 'ok' })
  f.clock.advance(10 * minute + 1)
  const missed = {
    kind: 'missed', agents: [{ id: agent.id, role: agent.role, heartbeatAt: null, ageMs: 10 * minute + 1, limitMs: 10 * minute }],
  }
  assert.deepEqual(await f.check(), missed)

  f.clock.advance(minute)
  f.state.agents[0] = { ...agent, generation: 2 }
  assert.deepEqual(await f.check(), { kind: 'ok' })
  f.clock.advance(10 * minute)
  assert.deepEqual(await f.check(), { kind: 'ok' })
  assert.deepEqual(f.topics(), ['stall:missed:worker'])

  f.clock.advance(1)
  assert.deepEqual(await f.check(), missed)
  assert.deepEqual(f.topics(), ['stall:missed:worker', 'stall:missed:worker'])
})

test('disabled agents are neither missed nor activity', async (t) => {
  const f = fixture(t)
  f.clock.advance(61 * minute)
  f.state.agents.push(
    registration('old', null, { status: 'disabled' }),
    registration('recent', f.clock.now(), { status: 'disabled' }),
  )
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: start, quietMinutes: 30 })
  assert.deepEqual(f.topics(), ['stall:quiet'])
})

test('quiet includes missed agents and each notification topic re-arms only after its own recovery', async (t) => {
  const f = fixture(t, { quietMinutes: 5, periodMinutes: 2 })
  f.state.agents.push(registration('worker', start), registration('reviewer', start, { role: 'reviewer' }))
  assert.deepEqual(await f.check(), { kind: 'ok' })

  f.clock.advance(5 * minute)
  const first = await f.check()
  assert.equal(first.kind, 'quiet')
  assert.deepEqual(first.missed?.map(({ id }) => id).sort(), ['reviewer', 'worker'])
  const topics = ['stall:missed:reviewer', 'stall:missed:worker', 'stall:quiet']
  assert.deepEqual(f.topics(), topics)
  f.clock.advance(1)
  assert.equal((await f.check()).kind, 'quiet')
  assert.deepEqual(f.topics(), topics)

  f.post()
  assert.equal((await f.check()).kind, 'missed')
  assert.deepEqual(f.topics(), topics)
  f.clock.advance(minute)
  f.state.agents[0] = registration('worker', f.clock.now())
  const recovered = await f.check()
  assert.equal(recovered.kind, 'missed')
  assert.deepEqual(recovered.agents.map(({ id }) => id), ['reviewer'])
  assert.deepEqual(f.topics(), topics)

  f.clock.advance(4 * minute + 1)
  assert.equal((await f.check()).kind, 'missed')
  topics.push('stall:missed:worker')
  assert.deepEqual(f.topics(), topics.sort())
  f.clock.advance(minute - 1)
  assert.equal((await f.check()).kind, 'quiet')
  assert.deepEqual(f.topics(), [...topics, 'stall:quiet'])
})

test('a fresh feed event does not suppress a missed alert', async (t) => {
  const f = fixture(t, { quietMinutes: 5, periodMinutes: 2 })
  const agent = registration('worker', start)
  f.state.agents.push(agent)
  const { id, role, heartbeatAt } = agent
  assert.deepEqual(await f.check(), { kind: 'ok' })
  f.clock.advance(5 * minute)
  f.post()
  assert.deepEqual(await f.check(), {
    kind: 'missed', agents: [{ id, role, heartbeatAt, ageMs: 5 * minute, limitMs: 4 * minute }],
  })
  assert.deepEqual(f.topics(), ['stall:missed:worker'])
})

test('a paused board sends nothing even when quiet and missing beats', async (t) => {
  const f = fixture(t)
  f.state.agents.push(registration('worker', start))
  f.state.paused = true
  f.clock.advance(61 * minute)
  assert.deepEqual(await f.check(), { kind: 'paused' })
  assert.deepEqual(f.sent, [])
  f.state.paused = false
  assert.equal((await f.check()).kind, 'quiet')
  assert.deepEqual(f.topics(), ['stall:missed:worker', 'stall:quiet'])
})

test('a pause after the initial status read prevents any sends', async (t) => {
  const f = fixture(t)
  f.state.agents.push(registration('worker', start))
  const list = f.handle.agents.list
  t.mock.method(f.handle.agents, 'list', async (scope: string) => {
    f.state.paused = true
    return list(scope)
  })
  f.clock.advance(61 * minute)
  assert.deepEqual(await f.check(), { kind: 'paused' })
  assert.deepEqual(f.sent, [])
})

test('a pause between sends leaves the remaining topics unsent until resume', async (t) => {
  const f = fixture(t)
  f.state.agents.push(registration('worker', start))
  const inbox = f.handle.operationalInbox
  const send = inbox.send
  t.mock.method(inbox, 'send', async (message: (typeof f.sent)[number]) => {
    await send(message)
    if (f.sent.length === 1) f.state.paused = true
  })
  f.clock.advance(61 * minute)
  assert.deepEqual(await f.check(), { kind: 'paused' })
  assert.equal(f.sent.length, 1)

  f.state.paused = false
  assert.equal((await f.check()).kind, 'quiet')
  assert.deepEqual(f.topics(), ['stall:missed:worker', 'stall:quiet'])
})

test('no_network_pause still allows a quiet notification', async (t) => {
  const f = fixture(t)
  f.state.statusError = Object.assign(new Error('unsupported'), { status: 501, code: 'no_network_pause' })
  f.clock.advance(30 * minute)
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: start, quietMinutes: 30 })
  assert.deepEqual(f.topics(), ['stall:quiet'])
})

test('other status errors reject the check without sending', async (t) => {
  const f = fixture(t)
  const error = Object.assign(new Error('unavailable'), { status: 503, code: 'unavailable' })
  f.state.statusError = error
  f.clock.advance(30 * minute)
  await assert.rejects(f.check(), (rejection) => rejection === error)
  assert.deepEqual(f.sent, [])
})

test('a failed send rejects the check and the next check can send the same topic', async (t) => {
  const f = fixture(t)
  const error = new Error('inbox unavailable')
  f.state.sendError = error
  f.clock.advance(30 * minute)
  await assert.rejects(f.check(), (rejection) => rejection === error)
  assert.deepEqual(f.sent, [])
  f.state.sendError = undefined
  assert.deepEqual(await f.check(), { kind: 'quiet', sinceMs: start, quietMinutes: 30 })
  assert.deepEqual(f.topics(), ['stall:quiet'])
  assert.equal((await f.check()).kind, 'quiet')
  assert.deepEqual(f.topics(), ['stall:quiet'])
})
