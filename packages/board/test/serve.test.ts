import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { local } from '../src/backend-local/index.ts'
import { localHandle } from '../src/cli/serve.ts'
import { board } from '../src/server/index.ts'
import { localTokenFile } from '../src/client/node.ts'
import { BOARD_URL, caller, personToken, testAuth, testBoard } from './harness.ts'
import { CLI, tmp } from './cli-harness.ts'

async function issuer() {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'ES256' }] })
  const sign = (sub: string, audience = BOARD_URL, iss = 'board:local') =>
    new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k' }).setIssuer(iss).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey)
  return { jwks, sign }
}

describe('local auth', () => {
  it("makes a local issuer's subject a person with full access", async () => {
    const { jwks, sign } = await issuer()
    const board = testBoard({ auth: { ...testAuth, local: { issuer: 'board:local', jwks } } })
    const me = await caller(board.fetch, await sign('julian'))('GET', '/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ actor: 'local:user:julian', principal: 'local:user:julian', kind: 'person', handle: 'julian' })
    const posted = await caller(board.fetch, await sign('julian'), { 'x-board-profile': 'claude' })('POST', '/messages', { channel: 'local', text: 'hi' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.by).toMatchObject({ actor: 'local:user:julian+claude', principal: 'local:user:julian' })
  })

  it("refuses another key, another board's audience, a bad sub, and boards without the issuer", async () => {
    const { jwks, sign } = await issuer()
    const other = await issuer()
    const board = testBoard({ auth: { ...testAuth, local: { issuer: 'board:local', jwks } } })
    for (const token of [await other.sign('julian'), await sign('julian', 'http://elsewhere/api/board'), await sign('../root')])
      expect((await caller(board.fetch, token)('GET', '/me')).status).toBe(401)
    expect((await caller(testBoard().fetch, await sign('julian'))('GET', '/me')).status).toBe(401)
    // The board's own Vercel people still get in alongside.
    expect((await caller(board.fetch, await personToken())('GET', '/me')).status).toBe(200)
  })

  it('turns OS usernames into handles', () => {
    expect(localHandle('Grace Hopper')).toBe('grace-hopper')
    expect(localHandle('DOMAIN\\jb')).toBe('domain-jb')
    expect(localHandle('_')).toBe('me')
  })
})

const running: ChildProcess[] = []
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL')
})

async function setup() {
  const project = await tmp('serve-project-')
  await mkdir(join(project, '.git'))
  await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|CURSOR_AGENT|BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)),
  )
  const env = { ...clean, HOME: await tmp('serve-home-'), XDG_CONFIG_HOME: await tmp('serve-config-') }
  return { project, env }
}

/** `vb serve` on a free port, resolved once it says where it's serving. */
function serveIn(cwd: string, env: NodeJS.ProcessEnv, flags = ['--no-inspect']) {
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...flags], { cwd, env })
  running.push(child)
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)))
  const url = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (d) => {
      stdout += d
      const found = /serving a local board at (\S+)/.exec(stdout)
      if (found && stdout.includes('\n', found.index)) resolve(found[1]!)
    })
    void exited.then((code) => reject(new Error(`vb serve exited ${code}: ${stderr}`)))
  })
  return { child, url, exited, output: () => stdout }
}

function withConfig<T>(dir: string, run: () => T): T {
  const saved = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = dir
  try {
    return run()
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved
  }
}

function vb(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end()
  })
}

/** A request as a proxy in front of `vb serve` forwards it, with the headers it sends: fetch won't forge a `Host`. A `body` is posted as JSON. */
function forwarded(to: string, path: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const { hostname, port, pathname } = new URL(to)
    const sent = body === undefined ? headers : { 'content-type': 'application/json', ...headers }
    const req = request({ hostname, port, path: `${pathname === '/' ? '' : pathname}${path}` || '/', method: body === undefined ? 'GET' : 'POST', headers: sent }, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

const proxies: Server[] = []
afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close()
})


describe('vb serve', () => {
  /** Who you are on a local board: this machine's user, as its local token names you. */
  const me = localHandle()

  it.each([false, true])('advertises agent operations only with --agent-ops (flag: %s)', async (enabled) => {
    const home = await tmp('serve-agents-home-')
    const env = { HOME: home, XDG_CONFIG_HOME: home }
    const server = serveIn(await tmp('serve-agents-project-'), env, enabled ? ['--no-inspect', '--agent-ops'] : ['--no-inspect'])
    const response = await fetch(await server.url)
    expect(response.status).toBe(200)
    const discovery = await response.json()
    if (enabled) expect(discovery).toHaveProperty('agent_ops', true)
    else expect(discovery).not.toHaveProperty('agent_ops')
    server.child.kill('SIGINT')
    expect(await server.exited).toBe(0)
  })

  it('runs a board here, says how to reach it, and keeps its log across runs', async () => {
    const { project, env } = await setup()
    const first = serveIn(project, env)
    const url = await first.url
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/board$/)
    // It links nothing: other commands reach it by its URL, and its log stays out of Git.
    await expect.poll(first.output).toContain(`reach it with --url ${url}, or BOARD_URL=${url}`)
    expect(existsSync(join(project, '.board', 'config.json'))).toBe(false)
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe('.board/\n')
    const at = { ...env, BOARD_URL: url }

    const whoami = await vb(project, at, ['whoami', '--json'])
    expect(whoami.stderr).toBe('')
    expect(JSON.parse(whoami.stdout)).toMatchObject({ actor: `local:user:${me}`, handle: me, board: url })

    // An agent in the same checkout that says who it is is "claude via <you>".
    const posted = await vb(project, at, ['post', 'local', 'from claude', '--as', 'claude', '--json'])
    expect(posted.code).toBe(0)
    expect(JSON.parse(posted.stdout).message.by).toMatchObject({ actor: `local:user:${me}+claude` })
    const reply = await vb(join(project), at, ['reply', String(JSON.parse(posted.stdout).message.id), 'from julian'])
    expect(reply.code).toBe(0)

    const tokenFile = withConfig(env.XDG_CONFIG_HOME, () => localTokenFile(url))
    expect(existsSync(tokenFile)).toBe(true)
    first.child.kill('SIGINT')
    expect(await first.exited).toBe(0)
    expect(existsSync(tokenFile)).toBe(false)
    expect(existsSync(join(project, '.board', 'local.db'))).toBe(true)

    // A new run, on another port, still has the thread.
    const second = serveIn(project, env)
    const again = await second.url
    const read = await vb(project, { ...env, BOARD_URL: again }, ['read', 'local', '--json'])
    expect(read.stderr).toBe('')
    expect(read.stdout).toContain('from claude')
    expect(read.stdout).toContain('from julian')
    second.child.kill('SIGINT')
    expect(await second.exited).toBe(0)
  })

  it('carries over the log and files an earlier vb serve kept in .board/board.db', async () => {
    const { project, env } = await setup()
    await writeFile(join(project, 'shot.txt'), 'pixels')
    const first = serveIn(project, env)
    const at = { ...env, BOARD_URL: await first.url }
    const posted = await vb(project, at, ['post', 'local', 'before the upgrade', '--attach', 'shot.txt', '--json'])
    const [file] = JSON.parse(posted.stdout).message.attachments
    first.child.kill('SIGINT')
    expect(await first.exited).toBe(0)
    // As an earlier vb serve left it: the log in board.db, the files in attachments/.
    const board = join(project, '.board')
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(join(board, `local.db${suffix}`))) await rename(join(board, `local.db${suffix}`), join(board, `board.db${suffix}`))
    await rename(join(board, 'local'), join(board, 'attachments'))

    const second = serveIn(project, env)
    const again = { ...env, BOARD_URL: await second.url }
    expect((await vb(project, again, ['read', 'local'])).stdout).toContain('before the upgrade')
    expect(await vb(project, again, ['download', file.id, '-'])).toMatchObject({ code: 0, stdout: 'pixels' })
    expect(existsSync(join(board, 'board.db'))).toBe(false)
    second.child.kill('SIGINT')
    expect(await second.exited).toBe(0)
  })

  it('leaves legacy files untouched when another process owns the board directory', async () => {
    const { project, env } = await setup()
    const dir = join(project, '.board')
    const backend = local({ dir })
    const owner = board({ backend })
    try {
      await owner.post('dev', 'holding the directory')
      const legacy = ['board.db', 'board.db-wal', 'board.db-shm', 'attachments/shot.txt']
      await mkdir(join(dir, 'attachments'))
      for (const file of legacy) await writeFile(join(dir, file), file)

      const refused = await vb(project, env, ['serve', '--dir', '.board', '--port', '0', '--no-inspect'])
      expect(refused.code).toBe(1)
      for (const file of legacy) {
        expect(existsSync(join(dir, file)), `${file} should stay in place`).toBe(true)
        expect(await readFile(join(dir, file), 'utf8')).toBe(file)
      }
      for (const file of ['local.db', 'local.db-wal', 'local.db-shm', 'local']) expect(existsSync(join(dir, file))).toBe(false)
      expect(refused.stderr).toContain('another process owns this board\'s directory')
      expect(refused.stderr).toContain('--url')
      expect(refused.stderr).not.toContain(dir)
    } finally {
      await backend.close()
    }
  })

  it("serves the inspector beside the board, on its port, and the board alone with --no-inspect", async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, env, ['--no-open'])
    const url = await serving.url
    const origin = new URL(url).origin
    await expect.poll(serving.output, { timeout: 10_000 }).toContain(`inspector at ${origin}\n`)
    // Every path outside the board's is the page's, as on the inspector's own server.
    for (const path of ['/', '/c/local', '/settings/access']) {
      const page = await fetch(`${origin}${path}`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('<div id="root"></div>')
    }
    expect((await fetch(`${origin}/app.js`)).headers.get('content-type')).toContain('text/javascript')
    // And the board is where it was.
    expect(await (await fetch(url)).json()).toMatchObject({ url, audience: url })
    expect((await vb(project, { ...env, BOARD_URL: url }, ['post', 'local', 'beside the page'])).code).toBe(0)
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)

    const alone = serveIn(project, env, ['--no-inspect'])
    const bare = await alone.url
    expect((await fetch(`${new URL(bare).origin}/`)).status).toBe(404)
    expect(alone.output()).not.toContain('inspector at')
    expect((await vb(project, { ...env, BOARD_URL: bare }, ['read', 'local'])).stdout).toContain('beside the page')
    alone.child.kill('SIGINT')
    expect(await alone.exited).toBe(0)
  })

  it('keeps serving after a path the page can\'t parse', async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, env, ['--no-open'])
    const url = await serving.url
    const origin = new URL(url).origin
    await expect.poll(serving.output, { timeout: 10_000 }).toContain(`inspector at ${origin}\n`)
    // A request target HTTP allows and a URL doesn't: it's refused, and nothing stops.
    expect((await forwarded(origin, '//[', {})).status).toBe(400)
    expect((await fetch(`${origin}/`)).status).toBe(200)
    expect((await fetch(url)).status).toBe(200)
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it("gives a request a proxy forwarded the page only at a host you allowed, whatever Host it carries", async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, env, ['--no-open', '--allow-host', 'box.tailnet.ts.net'])
    const url = await serving.url
    const origin = new URL(url).origin
    await expect.poll(serving.output, { timeout: 10_000 }).toContain(`inspector at ${origin}\n`)
    const own = new URL(url).host
    // On this machine, by the server's own name: yours.
    expect((await forwarded(origin, '/', { host: own })).status).toBe(200)
    // Through a proxy, a caller can send that name too: it isn't on this machine, so it's no one's page.
    for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip'])
      expect((await forwarded(origin, '/', { host: own, [header]: 'anything' })).status, header).toBe(421)
    expect((await forwarded(origin, '/board/me', { host: `localhost:${new URL(url).port}`, 'x-forwarded-host': 'box.tailnet.ts.net' })).status).toBe(421)
    // At the host you allowed, it's the page, as before.
    expect((await forwarded(origin, '/', { host: 'box.tailnet.ts.net', 'x-forwarded-host': 'box.tailnet.ts.net', 'x-forwarded-for': '100.64.0.1' })).status).toBe(200)
    // The board takes tokens wherever it's reached, so it still answers: at its own URL, for a name you didn't allow.
    expect(JSON.parse((await forwarded(url, '', { host: own, 'x-forwarded-for': '100.64.0.1' })).body)).toMatchObject({ url, audience: url })
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it("opens the inspector as you on this board, whatever BOARD_TOKEN holds", async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, { ...env, BOARD_TOKEN: 'not-a-token-for-this-board' }, ['--no-open'])
    await serving.url
    await expect.poll(serving.output, { timeout: 10_000 }).toMatch(/inspector at http:\/\/127\.0\.0\.1:\d+\n/)
    const inspector = /inspector at (\S+)/.exec(serving.output())![1]!
    const page = await (await fetch(`${inspector}/`)).text()
    const token = /<meta name="inspect-token" content="([^"]+)">/.exec(page)![1]!
    const me = await (await fetch(`${inspector}/board/me`, { headers: { 'x-inspect-token': token } })).json()
    expect(me).toMatchObject({ actor: `local:user:${localHandle()}` })
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it('is the board at a host you allow, and at its own address for any other', async () => {
    const { project, env } = await setup()
    // As in production, where a board that checks no Host itself takes none from a request.
    const serving = serveIn(project, { ...env, NODE_ENV: 'production' }, ['--no-inspect', '--allow-host', 'box.tailnet.ts.net'])
    const url = await serving.url
    const discovered = async (headers: Record<string, string>) => JSON.parse((await forwarded(url, '', headers)).body)
    // A proxy that keeps the Host it was asked for, and says the request came over TLS.
    const there = 'https://box.tailnet.ts.net/api/board'
    expect(await discovered({ host: 'box.tailnet.ts.net', 'x-forwarded-proto': 'https' })).toMatchObject({ url: there, audience: there })
    expect(await discovered({ host: 'BOX.tailnet.ts.net' })).toMatchObject({ audience: 'http://box.tailnet.ts.net/api/board' })
    // A sender chooses its Host: one you didn't allow doesn't get to name the board.
    expect(await discovered({ host: 'evil.example', 'x-forwarded-proto': 'https' })).toMatchObject({ url, audience: url })

    // Your token is for the board's own URL: it's you there, and no one at the host you allowed.
    const { token } = JSON.parse(await readFile(withConfig(env.XDG_CONFIG_HOME, () => localTokenFile(url)), 'utf8'))
    const me = (headers: Record<string, string>) => forwarded(url, '/me', { authorization: `Bearer ${token}`, ...headers })
    expect((await me({})).status).toBe(200)
    expect((await me({ host: 'evil.example' })).status).toBe(200)
    expect((await me({ host: 'box.tailnet.ts.net', 'x-forwarded-proto': 'https' })).status).toBe(401)
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it('opens the inspector to a host you allow, beside the board there', async () => {
    const { project, env } = await setup()
    const serving = serveIn(project, env, ['--no-open', '--allow-host', 'box.tailnet.ts.net'])
    const url = await serving.url
    await expect.poll(serving.output, { timeout: 10_000 }).toMatch(/inspector at http:\/\/127\.0\.0\.1:\d+\n/)
    const inspector = /inspector at (\S+)/.exec(serving.output())![1]!
    const page = await forwarded(inspector, '/', { host: 'box.tailnet.ts.net' })
    expect(page.status).toBe(200)
    // The page there acts as you, as on this machine.
    const token = /<meta name="inspect-token" content="([^"]+)">/.exec(page.body)![1]!
    const me = await forwarded(inspector, '/board/me', { host: 'box.tailnet.ts.net', 'x-inspect-token': token })
    expect(JSON.parse(me.body)).toMatchObject({ actor: `local:user:${localHandle()}` })
    expect((await forwarded(inspector, '/', { host: 'evil.example' })).status).toBe(421)
    // One name reaches both: the board is under it too.
    expect(JSON.parse((await forwarded(url, '', { host: 'box.tailnet.ts.net' })).body)).toMatchObject({ url: 'http://box.tailnet.ts.net/api/board' })
    serving.child.kill('SIGINT')
    expect(await serving.exited).toBe(0)
  })

  it('takes only a host for --allow-host', async () => {
    const { project, env } = await setup()
    const refused = await vb(project, env, ['serve', '--port', '0', '--no-inspect', '--allow-host', 'https://box.tailnet.ts.net/'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('--allow-host takes a host')
  })

  it('says so when the port is taken', async () => {
    const { project, env } = await setup()
    const first = serveIn(project, env)
    const port = new URL(await first.url).port
    const second = await vb(project, env, ['serve', '--port', port, '--no-inspect'])
    expect(second.code).toBe(1)
    expect(second.stderr).toBe(`error: Port ${port} is taken. Is a board already running there?\n\n  Pick another port:\n    vb serve --port <PORT>\n`)
  })
})
