import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { http } from '../src/backend-http/index.ts'
import { board } from '../src/server/index.ts'
import { createBoardClient } from '../src/client/client.ts'
import { bearer, BOARD_URL, personToken, testBoard } from './harness.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)).catch(() => {})))
})

type Seen = { method: string | undefined; url: string | undefined; headers: IncomingMessage['headers']; body: string }

async function listen(handler: (seen: Seen, respond: { redirect(to: string): void; ok(): void; status(code: number, to?: string): void }) => void) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const one = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
      seen.push(one)
      handler(one, {
        redirect: (to) => void res.writeHead(307, { location: to }).end(),
        ok: () => void res.writeHead(200, { 'content-type': 'application/json' }).end('{"task":{}}'),
        status: (code, to) => void res.writeHead(code, to ? { location: to } : {}).end(),
      })
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const SECRET = 'claim-token-that-must-stay-home'
const PACKET = { commit: 'b'.repeat(40), packetPath: 'handoffs/check.md', sha256: 'c'.repeat(64) }

describe('a claim-bearing request that is answered with a redirect', () => {
  it.each(['renew', 'release', 'complete', 'fail', 'priority', 'block', 'handoff'] as const)(
    'a claim\'s %s never sends its token to the URL it redirects to, and says so',
    async (verb) => {
      const elsewhere = await listen((_, respond) => respond.ok())
      const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
      // The default fetch follows redirects: a 307 keeps a POST and its body.
      const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })
      const held = client.tasks.held('task-1', { epoch: 1, token: SECRET })
      const write = {
        renew: () => held.renew(),
        release: () => held.release(),
        complete: () => held.complete(),
        fail: () => held.fail('no'),
        priority: () => held.priority('low' as never),
        block: () => held.block('stuck'),
        handoff: () => held.handoff(PACKET),
      }[verb]

      await expect(write()).rejects.toMatchObject({ code: 'redirect_refused', origin: 'handle' })

      expect(elsewhere.seen).toEqual([])
      expect(configured.seen).toHaveLength(1)
      expect(configured.seen[0]?.body).toContain(SECRET)
    },
  )

  it('a request for a decision that carries a claim\'s proof does not send it to a redirect', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.ask('task-1', { claim: { epoch: 1, token: SECRET } } as never)).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
    expect(configured.seen[0]?.body).toContain(SECRET)
  })

  it('a claim of the next ready task with its own token does not send it to a redirect', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.claim({ channel: 'work', token: SECRET } as never)).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
    expect(configured.seen[0]?.body).toContain(SECRET)
  })

  it('a 305 is refused with the others, since it names another place to send the request', async () => {
    const configured = await listen((_, respond) => respond.status(305))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await expect(client.tasks.held('task-1', { epoch: 1, token: SECRET }).release()).rejects.toMatchObject({ code: 'redirect_refused' })
  })

  it('a read that is not claim-bearing still follows a redirect, as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/me`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await client.me()

    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/me'])
  })

  it('a flagged request is refused whatever its Content-Type says, or whether it has one', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })
    const body = new TextEncoder().encode(JSON.stringify({ claim: { epoch: 1, token: SECRET } }))

    for (const headers of [{ 'Content-Type': 'Application/JSON' }, { 'content-type': 'text/plain' }, {}]) {
      await expect(client.request('/tasks/task-1/attention', { method: 'POST', body, headers, claim: true })).rejects.toMatchObject({ code: 'redirect_refused' })
    }

    expect(elsewhere.seen).toEqual([])
    expect(configured.seen).toHaveLength(3)
    expect(configured.seen.every((one) => one.body.includes(SECRET))).toBe(true)
  })

  it('a flagged request whose body adds the token when it is serialized is refused', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/stolen`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })
    const sneaky = { toJSON: () => ({ claim: { epoch: 1, token: SECRET } }) }

    await expect(client.tasks.ask('task-1', sneaky as never)).rejects.toMatchObject({ code: 'redirect_refused' })

    expect(elsewhere.seen).toEqual([])
    expect(configured.seen[0]?.body).toContain(SECRET)
  })

  it('an unflagged upload of a JSON file with a top-level token field follows a redirect as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.status(302, `${elsewhere.url}/uploaded`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })
    const file = new TextEncoder().encode(JSON.stringify({ token: 'an unrelated field of the file' }))

    const response = await client.request('/files', { method: 'POST', body: file, headers: { 'content-type': 'application/json' } })

    expect(response.status).toBe(200)
    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/uploaded'])
  })

  it('a claim that brings no token is not a flagged request, and follows a redirect as it does today', async () => {
    const elsewhere = await listen((_, respond) => respond.ok())
    const configured = await listen((_, respond) => respond.redirect(`${elsewhere.url}/claim`))
    const client = createBoardClient({ url: configured.url, fetch: (input, init) => globalThis.fetch(input, init) })

    await client.tasks.create('work', { text: 'a task', claim: true, token: undefined }).catch(() => {})

    expect(elsewhere.seen.map((one) => one.url)).toEqual(['/claim'])
  })
})

describe('every verb that carries a claim token flags its request', () => {
  const carrying = (sent: { body: string; redirect: RequestRedirect | undefined }[]) => sent.filter((one) => one.body.includes(SECRET))

  async function record(run: (client: ReturnType<typeof createBoardClient>) => Promise<unknown>) {
    const sent: { body: string; redirect: RequestRedirect | undefined }[] = []
    const client = createBoardClient({
      url: 'http://board.invalid',
      fetch: async (_input, init) => {
        sent.push({ body: typeof init?.body === 'string' ? init.body : '', redirect: init?.redirect })
        return Response.json({})
      },
    })
    await run(client).catch(() => {})
    return sent
  }

  const verbs: Record<string, (client: ReturnType<typeof createBoardClient>) => Promise<unknown>> = {
    renew: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).renew(),
    release: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).release(),
    complete: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).complete(),
    fail: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).fail('no'),
    priority: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).priority('low' as never),
    block: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).block('stuck'),
    handoff: (c) => c.tasks.held('t', { epoch: 1, token: SECRET }).handoff(PACKET),
    'tasks.handoff': (c) => c.tasks.handoff('t', { epoch: 1, token: SECRET } as never),
    'tasks.ask': (c) => c.tasks.ask('t', { claim: { epoch: 1, token: SECRET } } as never),
    'tasks.claim by id': (c) => c.tasks.claim('t', { token: SECRET }),
    'tasks.claim next': (c) => c.tasks.claim({ channel: 'work', token: SECRET } as never),
    'tasks.create': (c) => c.tasks.create('work', { text: 'a task', claim: true, token: SECRET }),
  }

  it.each(Object.keys(verbs))('%s', async (name) => {
    const sent = carrying(await record(verbs[name]!))

    expect(sent.length).toBeGreaterThan(0)
    expect(sent.map((one) => one.redirect)).toEqual(sent.map(() => 'manual'))
  })

  it('through a handle on another board over http(), each claim write is flagged', async () => {
    const team = testBoard()
    const token = await personToken('u_julian')
    const sent: { url: string; body: string; redirect: RequestRedirect | undefined }[] = []
    const fetch = bearer(async (input, init) => {
      const request = new Request(input, init)
      sent.push({ url: new URL(request.url).pathname, body: await request.clone().text(), redirect: init?.redirect })
      return team.fetch(request)
    }, token)
    const handle = board({ backend: http(BOARD_URL, { fetch }) }).as(null)
    const writes: Record<string, (claim: Awaited<ReturnType<typeof handle.tasks.claim>>) => Promise<unknown>> = {
      renew: (claim) => claim.renew(),
      priority: (claim) => claim.priority('low' as never),
      block: (claim) => claim.block('stuck'),
      handoff: (claim) => claim.handoff(PACKET),
      fail: (claim) => claim.fail('no'),
      release: (claim) => claim.release(),
      complete: (claim) => claim.complete(),
    }

    for (const [name, write] of Object.entries(writes)) {
      const { task } = await handle.tasks.create('work', `for ${name}`)
      const claim = await handle.tasks.claim(task.id, { lease: 30 })
      sent.length = 0
      await write(claim).catch(() => {})
      const mine = sent.filter((one) => one.body.includes(claim.token))
      expect(mine.map((one) => one.url), name).not.toEqual([])
      expect(mine.map((one) => one.redirect), name).toEqual(mine.map(() => 'manual'))
    }
  })
})
