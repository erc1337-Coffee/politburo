import { afterEach, describe, expect, it, vi } from 'vitest'
import { board, type Watcher, type WatcherContext } from '../src/server/index.ts'
import type { Can } from '../src/access/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'
import { LEASE_MS, retryDelay } from '../src/server/registered.ts'
import { canonicalWatchers } from '../src/server/watchers-hash.ts'
import { fakeQueue } from './queue.ts'

/** Where v0's board is mounted: a board on the team's board, over http(). */
const V0_URL = 'https://v0.test/api/board'
const V0 = 'vercel:project:prj_v0:production'
// Another team's project, so only the rules let it in: g2 lets in every project on the board's team.
const v0Token = () => deploymentToken('v0', 'prj_v0', 'production')

/** Lets a project's production deployments do what `can` says on `on`: again, it changes what they may. */
const grant = async (on: ReturnType<typeof testBoard>, projectId: string, can: Can) => {
  const written = (typeof can === 'object' && !Array.isArray(can) ? can : { '*': can }) as never
  const grants = await on.grants()
  const named = grants.find((one) => one.principals.length === 1 && one.principals[0]!.kind === 'project' && one.principals[0]!.projectId === projectId)
  if (named) return on.updateGrant(named.id, { can: written })
  // Without g2's every project on the team, it may do only what its grant says.
  if (grants.some((one) => one.id === 'g2')) await on.revokeGrant('g2')
  return on.createGrant({ principals: [{ kind: 'project', project: projectId, environments: ['production'] }], can: written })
}

/**
 * The team's board on a2(), and v0's board on http() using it, in-process. v0 may do what `can`
 * says there, until a test changes it, and marketing everything.
 */
async function team(watch: Record<string, Watcher> = {}, can: Can = 'all', kept: Parameters<typeof testBoard>[0] = {}) {
  const remote = testBoard(kept)
  /** Each feed read v0's board made of the team's board. */
  const reads: string[] = []
  const route = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname.endsWith('/events')) reads.push(request.url)
    return remote.fetch(request)
  }
  await grant(remote, 'prj_v0', can)
  await grant(remote, 'prj_marketing', 'all')
  const backend = http(BOARD_URL, { fetch: bearer(route, v0Token) })
  const project = board({ backend, url: V0_URL, watch })
  return {
    remote,
    project,
    backend,
    reads,
    /** What v0 may do on the team's board from now on. */
    allow: (next: Can) => grant(remote, 'prj_v0', next),
    /** Starts v0's watchers, as its first use does, once each has read the feed's head. */
    started: async () => {
      await project.as('deploys').me()
      await vi.waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(Object.keys(watch).length))
    },
  }
}

/** A watcher that records each event it runs on, and runs `then` after. */
function recorder(tail: string, then?: Watcher['run']) {
  const seen: WatcherContext['event'][] = []
  return { seen, watcher: { tail, run: async (context: WatcherContext) => (seen.push(context.event), then?.(context)) } satisfies Watcher }
}

const julianOn = async (fetch: (request: Request) => Promise<Response>) => caller(fetch, await personToken(), {})

describe('watchers on a board on http()', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("run here on what the same tail prints, writing as the deployment's profile, and register nothing", async () => {
    const fix = recorder('feedback', async ({ event, board }) => {
      if (event.type === 'message.posted' && event.message?.re === null) await board.reply(event.message.id, 'on it')
    })
    const t = await team({ fix: fix.watcher })
    try {
      await t.started()
      const julian = await julianOn(t.remote.fetch)
      const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })).body.message
      await vi.waitFor(async () => {
        const { body } = await julian('GET', `/messages/${root.id}`)
        expect(body.replies.map((reply: { text: string; by: { actor: string } }) => [reply.text, reply.by.actor])).toEqual([['on it', `${V0}+fix`]])
      })
      expect(fix.seen.map((event) => [event.type, event.message?.text])).toEqual([['message.posted', 'export is broken']])
      expect((await caller(t.remote.fetch, await v0Token())('GET', '/watchers')).body.watchers).toEqual([])
      // Nothing wakes it: it answers no wake-up.
      expect((await t.project.fetch(new Request(`${V0_URL}/wake`, { method: 'POST' }))).status).toBe(404)
    } finally {
      t.backend.close()
    }
  })

  it('creates one bound task when a watcher retries the same event', async () => {
    const owner = { principal: V0, actor: `${V0}+intake` }
    const binding = {
      controller: owner,
      owner,
      provider: 'fixture-provider',
      model: 'fixture-model',
      session: 'session-1',
      branch: 'topic/review',
      worktree: '/fixture/worktrees/review',
      baseCommit: 'a'.repeat(40),
    }
    const wrote: string[] = []
    const intake = recorder('feedback', async ({ event, board }) => {
      if (event.type !== 'message.posted' || event.message?.re !== null) return
      await board.tasks.create('work', { text: `triage: ${event.message.text}`, claim: true, binding })
      wrote.push(event.cursor)
      if (wrote.length === 1) throw new Error('timed out after creating the task')
    })
    const t = await team({ intake: intake.watcher })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await t.started()
      const julian = await julianOn(t.remote.fetch)
      expect((await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })).status).toBe(201)
      await vi.waitFor(() => expect(wrote).toHaveLength(2), { timeout: 5000 })
      expect(wrote[1]).toBe(wrote[0])
      const listed = await julian('GET', '/tasks?channel=work&state=all')
      expect(listed.status).toBe(200)
      expect(listed.body.tasks).toHaveLength(1)
      expect(listed.body.tasks[0].message).toMatchObject({ text: 'triage: export is broken', task: { claim: { binding } } })
    } finally {
      t.backend.close()
      errors.mockRestore()
    }
  })

  it("never runs on what the deployment can't read", async () => {
    const fix = recorder('--all')
    const t = await team({ fix: fix.watcher }, { feedback: ['read', 'post'] })
    try {
      await t.started()
      const julian = await julianOn(t.remote.fetch)
      await julian('POST', '/messages', { channel: 'security', text: 'hunter2' })
      await julian('POST', '/messages', { channel: 'feedback', text: 'export is broken' })
      await vi.waitFor(() => expect(fix.seen.map((event) => event.message?.text)).toEqual(['export is broken']))
    } finally {
      t.backend.close()
    }
  })

  it("doesn't run on its own writes", async () => {
    const echo = recorder('feedback', async ({ event, board }) => {
      if (event.type === 'message.posted') await board.post('feedback', 'echo')
    })
    const t = await team({ echo: echo.watcher })
    try {
      await t.started()
      await (await julianOn(t.remote.fetch))('POST', '/messages', { channel: 'feedback', text: 'hello' })
      await vi.waitFor(async () => {
        const { body } = await (await julianOn(t.remote.fetch))('GET', '/messages?channel=feedback')
        expect(body.messages.map((message: { text: string }) => message.text)).toEqual(['hello', 'echo'])
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(echo.seen.map((event) => event.message?.text)).toEqual(['hello'])
    } finally {
      t.backend.close()
    }
  })

  it('runs on the check-in it scheduled itself', async () => {
    const queue = fakeQueue()
    const ci = recorder('feedback', async ({ event, board }) => {
      if (event.type !== 'message.posted') return
      if (!event.message!.schedule) return void (await board.schedule({ re: event.message!.id }, { text: 'check on CI', in: '5m' }))
      await board.react(event.message!.id, 'eyes')
      await board.reply(event.message!.id, 'still red')
    })
    const t = await team({ ci: ci.watcher }, 'all', { scheduler: queue.scheduler })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await t.started()
      const julian = await julianOn(t.remote.fetch)
      const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'the build is red' })).body.message
      const scheduled = async () => (await julian('GET', `/schedules?re=${root.id}`)).body.schedules as unknown[]
      while ((await scheduled()).length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const replies = async () => (await julian('GET', `/messages/${root.id}`)).body.replies as { text: string; by: { actor: string } }[]
      // The schedule shows before the queue holds its timer, so one fire could find nothing due: fire
      // until the watcher has answered its check-in, or for 3 seconds, so a watcher that never runs fails below.
      for (const giveUp = performance.now() + 3_000; (await replies()).length < 2 && performance.now() < giveUp; ) {
        await queue.fire()
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect((await replies()).map((reply) => [reply.text, reply.by.actor])).toEqual([
        ['check on CI', `${V0}+ci`],
        ['still red', `${V0}+ci`],
      ])
      await new Promise((resolve) => setTimeout(resolve, 100))
      // It ran on its check-in, and on nothing it then wrote: not its reaction to the check-in, nor its reply.
      expect(ci.seen.map((event) => [event.type, event.message?.text])).toEqual([
        ['message.posted', 'the build is red'],
        ['message.posted', 'check on CI'],
      ])
    } finally {
      vi.useRealTimers()
      t.backend.close()
    }
  })

})

/** The queue as v0 sees it through the API, registered without a URL so nothing wakes it. */
async function queued(tail = 'feedback') {
  const t = await team()
  const v0 = caller(t.remote.fetch, await v0Token())
  expect((await v0('POST', '/watchers', { watch: { fix: { tail } } })).status).toBe(200)
  const julian = await julianOn(t.remote.fetch)
  const pull = async (headers: Record<string, string> = {}) =>
    (await caller(t.remote.fetch, await v0Token(), headers)('GET', '/watchers/matches')).body.matches as { id: string; lease: string; attempt: number; event: { message: { text: string } } }[]
  const ack = (match: { id: string; lease: string }, body: Record<string, unknown> = {}) => v0('POST', `/watchers/matches/${match.id}/ack`, { lease: match.lease, ...body })
  return { t, v0, julian, pull, ack }
}

describe('pulling matches', () => {
  it("hands out a thread's matches one at a time, in order", async () => {
    const { julian, pull, ack } = await queued()
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'first' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'second' })
    await julian('POST', '/messages', { channel: 'feedback', text: 'another thread' })
    let matches: Awaited<ReturnType<typeof pull>> = []
    await vi.waitFor(async () => {
      matches = [...matches, ...(await pull())]
      expect(matches.map((match) => match.event.message.text).sort()).toEqual(['another thread', 'first'])
    })
    // The thread's second waits for its first.
    expect(await pull()).toEqual([])
    const first = matches.find((match) => match.event.message.text === 'first')!
    expect((await ack(first)).status).toBe(200)
    expect((await pull()).map((match) => match.event.message.text)).toEqual(['second'])
  })

  it('leases a match to one pull at a time', async () => {
    const { julian, pull } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'once' })
    await vi.waitFor(async () => {
      const both = await Promise.all([pull(), pull()])
      expect(both.flat()).toHaveLength(1)
    })
  })

  it('tries an error again after a wait, gives up after 5 tries, and the thread goes on', async () => {
    const { t, julian, pull, ack } = await queued()
    const root = (await julian('POST', '/messages', { channel: 'feedback', text: 'flaky' })).body.message
    await julian('POST', '/messages', { re: root.id, text: 'after it' })
    let match: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((match = (await pull())[0])).toBeDefined())
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        expect(match!.attempt).toBe(attempt)
        expect((await ack(match!, { error: 'boom' })).status).toBe(200)
        if (attempt === 4) break
        // It waits out its delay before anyone can pull it again.
        expect(await pull()).toEqual([])
        vi.setSystemTime(Date.now() + retryDelay(attempt + 1) + 1)
        match = (await pull())[0]
        expect(match?.event.message.text).toBe('flaky')
      }
      expect((await pull()).map((next) => next.event.message.text)).toEqual(['after it'])
    } finally {
      vi.useRealTimers()
    }
    const history = await t.remote.servers.at(-1)!.session(`watch:@${V0}`).history()
    expect(history.filter((event: { type: string }) => event.type === 'watch.failed')).toHaveLength(1)
  })

  it('pulls a match again once its lease runs out, and ignores the old lease', async () => {
    const { julian, pull, ack } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'slow' })
    let first: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((first = (await pull())[0])).toBeDefined())
    expect(await pull()).toEqual([])
    // Its puller never acks, and five minutes go by.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + LEASE_MS + 1000)
      const again = (await pull())[0]!
      expect([again.id, again.attempt]).toEqual([first!.id, 1])
      expect(await ack(first!)).toEqual({ status: 409, body: { error: { code: 'stale_lease', message: 'that lease ran out, and the match was pulled again' } } })
      expect((await ack(again)).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops a match its registrant can't read anymore", async () => {
    const { t, julian, pull } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'meant for v0' })
    const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
    await vi.waitFor(async () => expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.matched'))
    // The team's grant took feedback away since: the match is skipped, not handed out.
    await t.allow({ other: ['read'] })
    expect(await pull()).toEqual([])
    expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.skipped')
    await t.allow('all')
    expect(await pull()).toEqual([])
  })

  it('refuses a caller narrowed with x-board-can, which leaves its registration and matches as they were', async () => {
    const { t, v0, julian, pull, ack } = await queued()
    await julian('POST', '/messages', { channel: 'feedback', text: 'meant for v0' })
    const queue = t.remote.servers.at(-1)!.session(`watch:@${V0}`)
    await vi.waitFor(async () => expect((await queue.history()).map((event: { type: string }) => event.type)).toContain('watch.matched'))
    const narrowed = caller(t.remote.fetch, await v0Token(), { 'x-board-can': 'other=read' })
    const refusal = { status: 403, body: { error: { code: 'forbidden', message: "this token is narrowed with x-board-can: registering and running watchers is its project's job" } } }
    // Its pull would have dropped the match it can't read, and its register replaced v0's whole registration.
    expect(await narrowed('GET', '/watchers/matches')).toEqual(refusal)
    expect(await narrowed('POST', '/watchers', { watch: {} })).toEqual(refusal)
    expect((await queue.history()).map((event: { type: string }) => event.type)).not.toContain('watch.skipped')
    expect((await v0('GET', '/watchers')).body.watchers.map((found: { watch: object }) => Object.keys(found.watch))).toEqual([['fix']])
    const [match] = await pull()
    expect(match!.event.message.text).toBe('meant for v0')
    expect(await narrowed('POST', `/watchers/matches/${match!.id}/ack`, { lease: match!.lease })).toEqual(refusal)
    expect((await ack(match!)).status).toBe(200)
  })

  it('needs a registration, and acks only its own', async () => {
    const { t, julian, pull } = await queued()
    const marketing = caller(t.remote.fetch, await deploymentToken())
    expect((await marketing('GET', '/watchers/matches')).body.error.code).toBe('no_registration')
    await julian('POST', '/messages', { channel: 'feedback', text: 'for v0' })
    let match: Awaited<ReturnType<typeof pull>>[number] | undefined
    await vi.waitFor(async () => expect((match = (await pull())[0])).toBeDefined())
    expect((await marketing('POST', `/watchers/matches/${match!.id}/ack`, { lease: match!.lease })).status).toBe(404)
  })
})

describe('registering', () => {
  it("is checked the way a board's own watchers are", async () => {
    const t = await team()
    const v0 = caller(t.remote.fetch, await v0Token())
    const register = (watch: unknown) => v0('POST', '/watchers', { watch })
    expect(await register({ fix: { tail: 'feedback --after 3' } })).toEqual({
      status: 400,
      body: { error: { code: 'bad_watcher', message: "watch fix: --after isn't a filter" } },
    })
    expect((await register({ review_pi: { tail: 'prs' } })).body.error.message).toBe(
      'watch review_pi: ids start with a letter and use up to 32 letters, numbers, and hyphens',
    )
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`w${n}`, { tail: 'feedback' }]))
    expect((await register(many)).body.error.message).toContain('a registration holds at most 64 watchers')
    expect((await register({ fix: { tail: 'feedback' } })).status).toBe(200)
  })

  it('needs a token that reads somewhere, and lists registrations to whoever may see them', async () => {
    const t = await team({}, { feedback: ['post'] })
    const v0 = caller(t.remote.fetch, await v0Token())
    expect((await v0('POST', '/watchers', { watch: {} })).status).toBe(403)
    const marketing = caller(t.remote.fetch, await deploymentToken())
    await marketing('POST', '/watchers', { watch: { fix: { tail: 'feedback' } } })
    expect((await v0('GET', '/watchers')).body.watchers).toEqual([])
    expect((await (await julianOn(t.remote.fetch))('GET', '/watchers')).body.watchers.map((found: { owner: string }) => found.owner)).toEqual([
      'vercel:project:prj_marketing:production',
    ])
  })

  it('hashes watchers in code-unit order, the same in every locale', () => {
    const spec = { tail: 'feedback' }
    // A locale's collation puts `a` before `B`; code units put `B` (U+0042) before `a` (U+0061).
    const canonical = canonicalWatchers({ a: spec, B: spec })
    expect(JSON.parse(canonical)).toEqual([
      ['B', 'feedback'],
      ['a', 'feedback'],
    ])
    expect(canonicalWatchers({ B: spec, a: spec })).toBe(canonical)
  })
})
