import { afterEach, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { board as defaultBoard } from '../src/server/index.default.ts'
import { http as defaultHttp } from '../src/backend-http/index.default.ts'
import { bearer, BOARD_URL, caller, personToken, testBoard } from './harness.ts'

async function setup(userId = 'u_julian', profile: string | null = null) {
  const team = testBoard()
  const token = await personToken(userId)
  const fetch = bearer((input, init) => team.fetch(new Request(input, init)), token)
  const client = board({ backend: http(BOARD_URL, { fetch }) }).as(profile)
  return { team, client, fetch }
}

describe('a handle on a board over http()', () => {
  it('posts, replies, and reads threads', async () => {
    const { client } = await setup()
    const root = await client.post('errors-www', { text: 'deploy failed', labels: { status: 'open' } })
    await client.reply(root.id, 'rolled back')
    const thread = await client.thread(root.id)
    expect(thread.message.labels).toEqual({ status: 'open' })
    expect(thread.replies.map((m) => m.text)).toEqual(['rolled back'])
    expect(thread.message.author).toMatchObject({ handle: 'u_julian' })
  })

  it('lists threads by latest activity, each with its root, reply count, and latest reply', async () => {
    const { client } = await setup()
    const old = await client.post('triage', { text: 'old bug', labels: { state: 'open' } })
    const quiet = await client.post('triage', 'quiet question')
    const busy = await client.post('triage', { text: 'busy bug', labels: { state: 'open' } })
    let latest = ''
    for (const n of [1, 2, 3]) latest = (await client.reply(busy.id, `busy ${n}`)).id
    const gone = await client.reply(busy.id, 'oops')
    await client.delete(gone.id)
    const { cursor } = await client.threads({ channel: 'triage' })
    const late = await client.reply(old.id, 'still broken')

    const page = await client.threads({ channel: 'triage' })
    expect(page.threads.map((t) => [t.message.id, t.replies, t.last?.id ?? null])).toEqual([
      [quiet.id, 0, null],
      [busy.id, 3, latest],
      [old.id, 1, late.id],
    ])
    // `limit` counts threads, and a reply's activity keeps its thread's root in view.
    expect((await client.threads({ channel: 'triage', limit: 1 })).threads.map((t) => t.message.text)).toEqual(['old bug'])
    // A label on the root matches its replies, so a thread is in once.
    expect((await client.threads({ channel: 'triage', label: { state: 'open' } })).threads.map((t) => t.message.id)).toEqual([busy.id, old.id])
    expect((await client.threads({ channel: 'triage', after: cursor })).threads.map((t) => t.message.id)).toEqual([old.id])
    expect((await client.threads({ text: 'busy 2' })).threads.map((t) => t.message.id)).toEqual([busy.id])
  })

  it('pages back through threads by their latest activity, each thread once, until `older` is null', async () => {
    const { client } = await setup()
    const roots = []
    for (let n = 1; n <= 11; n++) roots.push(await client.post('triage', `thread ${n}`))
    // Activity, not start, orders them: the first thread is the newest.
    await client.reply(roots[0]!.id, 'bump')
    const pages = []
    let page = await client.threads({ channel: 'triage', limit: 4 })
    pages.push(page.threads.map((t) => t.message.text))
    while (page.older !== null) {
      expect(page.older).toEqual(expect.any(String))
      page = await client.threads({ channel: 'triage', before: page.older!, limit: 4 })
      pages.push(page.threads.map((t) => t.message.text))
    }
    expect(pages).toEqual([
      ['thread 9', 'thread 10', 'thread 11', 'thread 1'],
      ['thread 5', 'thread 6', 'thread 7', 'thread 8'],
      ['thread 2', 'thread 3', 'thread 4'],
    ])
    // Reading forward is as it was: no `older`.
    expect(await client.threads({ channel: 'triage', after: roots[9]!.id })).not.toHaveProperty('older')
    await expect(client.threads({ channel: 'triage', before: 'not-a-page' })).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' })
    await expect(client.threads({ channel: 'triage', before: page.cursor, after: page.cursor })).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
  })

  it('names the actors asked for by ID, and only those the board has', async () => {
    const team = testBoard()
    const on = async (user: string) => board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => team.fetch(new Request(input, init)), await personToken(user)) }) })
    for (const user of ['u_julian', 'u_ada']) await (await on(user)).post('triage', `from ${user}`)
    // What the board answered, before the handle keeps what it asked for.
    const answered: string[][] = []
    const fetch = bearer(async (input, init) => {
      const response = await team.fetch(new Request(input, init))
      if (new URL(String(input)).pathname.endsWith('/actors')) answered.push(((await response.clone().json()) as { actors: { id: string }[] }).actors.map((actor) => actor.id).sort())
      return response
    }, await personToken('u_julian'))
    const client = board({ backend: http(BOARD_URL, { fetch }) })
    expect((await client.actors()).map((actor) => actor.id).sort()).toEqual(['vercel:user:u_ada', 'vercel:user:u_julian'])
    expect((await client.actors({ id: ['vercel:user:u_ada', 'vercel:user:u_nobody', 'vercel:user:u_ada'] })).map((actor) => actor.id)).toEqual(['vercel:user:u_ada'])
    expect(answered).toEqual([['vercel:user:u_ada', 'vercel:user:u_julian'], ['vercel:user:u_ada']])
  })

  it('names each actor asked for once, and asks a board that takes no `id` once, however many IDs there are', async () => {
    const team = testBoard()
    const on = async (user: string) => board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => team.fetch(new Request(input, init)), await personToken(user)) }) })
    for (const user of ['u_julian', 'u_ada']) await (await on(user)).post('triage', `from ${user}`)
    // A board from before `id`: it answers everyone, whatever it's asked.
    let asked = 0
    const fetch = bearer((input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/actors')) (asked++, url.searchParams.delete('id'))
      return team.fetch(new Request(url, init))
    }, await personToken('u_julian'))
    const client = board({ backend: http(BOARD_URL, { fetch }) })
    // Ada in the first hundred, Julian in the next: the first answer names Julian too, so it's everyone.
    const ids = ['vercel:user:u_ada', ...Array.from({ length: 148 }, (_, n) => `vercel:user:u_${n}`), 'vercel:user:u_julian']
    expect((await client.actors({ id: ids })).map((actor) => actor.id).sort()).toEqual(['vercel:user:u_ada', 'vercel:user:u_julian'])
    expect(asked).toBe(1)
  })

  it('throws BoardError with the server code', async () => {
    const { client } = await setup()
    await expect(client.thread('999')).rejects.toMatchObject({
      name: 'BoardError',
      code: 'message_not_found',
      status: 404,
    })
    await expect(client.post('Bad Channel', 'x')).rejects.toMatchObject({ name: 'BoardError', code: 'invalid_request', status: 400 })
  })

  it('refuses text over the limit as text_too_long, with what to do instead, on a post, a reply, and an edit', async () => {
    const { client } = await setup()
    const tooLong = {
      name: 'BoardError',
      code: 'text_too_long',
      status: 400,
      origin: 'board',
      message: "A message's text is at most 10,000 characters.",
      hint: 'Put the long part in a file and attach it to a message, with a short summary as the text.',
    }
    await expect(client.post('errors-www', 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    const root = await client.post('errors-www', 'x'.repeat(10_000))
    await expect(client.reply(root.id, 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    await expect(client.edit(root.id, 'x'.repeat(10_001))).rejects.toMatchObject(tooLong)
    expect((await client.thread(root.id)).replies).toEqual([])
  })

  it('waits for the next matching event, or times out with null', async () => {
    const { client } = await setup()
    const root = await client.post('x', 'question')
    const waiting = client.wait({ re: root.id }, { timeout: '5s' })
    setTimeout(() => void client.reply(root.id, 'answer'), 50)
    const event = await waiting
    expect(event?.message?.text).toBe('answer')
    expect(await client.wait({ re: root.id }, { timeout: 200 })).toBeNull()
  })

  it('streams live events and resumes after the server closes the stream', async () => {
    const team = testBoard({ streamMaxMs: 150 })
    const fetch = bearer((input, init) => team.fetch(new Request(input, init)), await personToken())
    const client = board({ backend: http(BOARD_URL, { fetch }) })
    const controller = new AbortController()
    const seen: string[] = []
    const reading = (async () => {
      for await (const event of client.events({ channel: 'x' }, { signal: controller.signal })) {
        seen.push(event.message!.text)
        if (seen.length === 3) controller.abort()
      }
    })()
    await new Promise((r) => setTimeout(r, 50))
    await client.post('x', 'one')
    await new Promise((r) => setTimeout(r, 300)) // the server closes and the client reconnects
    await client.post('y', 'elsewhere')
    await client.post('x', 'two')
    await new Promise((r) => setTimeout(r, 300))
    await client.post('x', 'three')
    await reading
    expect(seen).toEqual(['one', 'two', 'three'])
  })
})

describe("a post's id over http()", () => {
  it('posts once for a retry, finds it again, and stays the handle\'s own', async () => {
    const { team, client } = await setup()
    const first = await client.post('dev', { text: 'a1b2c3 is live', id: 'deploy-a1b2c3' })
    const again = await client.post('dev', { text: 'a1b2c3 is live', id: 'deploy-a1b2c3' })
    expect(again.id).toBe(first.id)
    expect((await client.posted('deploy-a1b2c3')).id).toBe(first.id)
    // It goes as a key under the token's principal, which no one else may post with.
    expect(first.thread).toMatch(/^key:vercel:user:u_julian:[0-9a-f]{32}$/)
    // Someone else's post with the same id first doesn't take it.
    const ada = caller(team.fetch, await personToken('u_ada'), {})
    expect((await ada('POST', '/messages', { channel: 'dev', text: 'mine', id: 'deploy-d4e5f6' })).status).toBe(201)
    expect((await client.post('dev', { text: 'd4e5f6 is live', id: 'deploy-d4e5f6' })).text).toBe('d4e5f6 is live')
    // Another profile's post with the same id is another post.
    expect((await client.as('claude').post('dev', { text: 'a1b2c3 is live', id: 'deploy-a1b2c3' })).id).not.toBe(first.id)
  })
})

describe('board() with no backend', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  /** A machine with nothing of board's or an agent's in its environment. */
  const clean = () => {
    for (const key of Object.keys(process.env)) if (/^(BOARD|VERCEL|ACTIONS_ID_TOKEN|CLAUDE|CODEX|GROK|CURSOR|PI_|AI_AGENT)/.test(key)) vi.stubEnv(key, '')
  }

  it('fails with no_board when no backend is passed and BOARD_URL names no board', () => {
    clean()
    expect(() => board()).toThrow(expect.objectContaining({ code: 'no_board' }))
  })

  it('is http() to the board BOARD_URL names, as the token holder with its profile', async () => {
    clean()
    const team = testBoard()
    vi.stubEnv('BOARD_URL', BOARD_URL)
    vi.stubEnv('BOARD_TOKEN', await personToken())
    vi.stubEnv('BOARD_PROFILE', 'ci')
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => team.fetch(new Request(input, init)))
    const here = board()
    expect((await here.post('dev', 'from CI')).by.actor).toBe('vercel:user:u_julian+ci')
    expect((await here.as(null).me()).actor).toBe('vercel:user:u_julian')
  })

  it("writes as you inside a coding agent, whatever its environment says, until BOARD_PROFILE names a profile", async () => {
    clean()
    const team = testBoard()
    vi.stubEnv('BOARD_URL', BOARD_URL)
    vi.stubEnv('BOARD_TOKEN', await personToken())
    for (const [key, value] of Object.entries({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1', CODEX_THREAD_ID: 't1', AI_AGENT: 'pi', PI_CODING_AGENT: 'true' })) vi.stubEnv(key, value)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => team.fetch(new Request(input, init)))
    const posted = await board().post('dev', 'from an agent')
    expect(posted.by).toEqual({ actor: 'vercel:user:u_julian', principal: 'vercel:user:u_julian', profile: null })
    vi.stubEnv('BOARD_PROFILE', 'claude')
    const named = await board().post('dev', 'as claude')
    expect([named.by.actor, named.author?.avatar]).toEqual(['vercel:user:u_julian+claude', null])
  })

  it('outside Node, needs a backend, sends what its fetch sends, and serves only what its backend answers', async () => {
    const team = testBoard()
    // A page's own session, as the board recognizes it: here, a token its fetch adds.
    const fetch = bearer((input, init) => team.fetch(new Request(input, init)), await personToken())
    expect(() => defaultBoard()).toThrow('board: pass a backend')
    const page = defaultBoard({ backend: defaultHttp(BOARD_URL, { fetch }) })
    expect((await page.as('page').post('dev', 'from a browser')).by.actor).toBe('vercel:user:u_julian+page')
    expect((await page.discovery()).url).toBe(BOARD_URL)
    // It serves what its backend answers a request: http() answers nothing itself.
    const served = await page.fetch(new Request(`${BOARD_URL}/me`, { headers: { authorization: `Bearer ${await personToken()}` } }))
    expect([served.status, (await served.json()).error.code]).toEqual([404, 'not_found'])
    // Watchers run here as they do in Node: a tail is checked the same way, and sync is refused the same way.
    expect(() => defaultBoard({ backend: defaultHttp(BOARD_URL), watch: { fix: { tail: 'dev --after 3', run: () => {} } } })).toThrow("watch fix: --after isn't a filter")
    expect(() => defaultBoard({ backend: defaultHttp(BOARD_URL), watch: { fix: { tail: 'dev', run: () => {} } } })).not.toThrow()
    expect(() => defaultBoard({ backend: defaultHttp(BOARD_URL), sync: { slack: {} as never } })).toThrow("http: sync doesn't run on a board that uses")
  })
})
