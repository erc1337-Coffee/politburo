import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { board as openBoard } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { GitRepositories } from '../src/git.ts'
import { appendTarFile, ListenerOperations, listenerPrefix, probe, SupervisorClient } from '../src/listener-operations.ts'
import { applicableActions } from '../src/thread-assistant.ts'

/** The names and contents of a tar archive's files. */
function tarFiles(tar: Buffer): Record<string, string> {
  const files: Record<string, string> = {}
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim() || '0', 8)
    const type = String.fromCharCode(header[156]!)
    if (type === '0' || type === '\0') files[name] = tar.subarray(offset + 512, offset + 512 + size).toString('utf8')
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

describe('local listeners', () => {
  let directory: string
  let supervisor: Server
  let url: string
  let listening: Server
  let openPort: number
  const calls: Array<{ method: string; path: string; files?: Record<string, string>; body?: unknown }> = []

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'listener-operations-'))
    listening = createServer().listen(0, '127.0.0.1')
    await new Promise((resolve) => listening.once('listening', resolve))
    openPort = (listening.address() as AddressInfo).port
    supervisor = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      const path = request.url!
      const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (path === '/addresses') return json({ addresses: { lan: '127.0.0.1', wireguard: '127.0.0.2' } })
      if (path.includes('/build')) {
        calls.push({ method: 'POST', path, files: tarFiles(body) })
        return json({ image: 'image', lines: ['built'] })
      }
      calls.push({ method: request.method!, path, ...(body.length ? { body: JSON.parse(body.toString()) } : {}) })
      const state = { id: 'x', exists: true, state: 'running', running: !path.endsWith('/stop'), started_at: null, finished_at: null, exit_code: 0, restart_count: 0, image: 'image', ports: [] }
      if (path.endsWith('/logs?tail=20') || path.includes('/logs')) return json({ lines: ['listening'] })
      return json(state)
    })
    supervisor.listen(0, '127.0.0.1')
    await new Promise((resolve) => supervisor.once('listening', resolve))
    url = `http://127.0.0.1:${(supervisor.address() as AddressInfo).port}`
  })
  after(() => {
    supervisor.close()
    listening.close()
    rmSync(directory, { recursive: true, force: true })
  })

  async function setup(channel: string, repository: string | null) {
    const team = openBoard({ backend: local({ memory: true }) })
    await team.post(channel, 'channel')
    const id = `${listenerPrefix(channel)}-web`
    await team.configureChannel(channel, {
      repository, routes: [],
      local: { dockerfile: 'FROM scratch\n', listeners: [{ id, name: 'web', subpath: 'site', port: openPort, containerPort: 3000, interfaces: ['lan'] }] },
    } as never)
    const git = new GitRepositories({ directory: join(directory, `mirrors-${listenerPrefix(channel)}`), localDirectory: join(directory, `local-${listenerPrefix(channel)}`), urlBase: `file://${directory}`, token: '' })
    const posted: string[] = []
    const post = team.post.bind(team)
    team.post = ((path: string, input: { text: string }) => { posted.push(input.text); return post(path, input as never) }) as typeof team.post
    return { team, git, id, posted, operations: new ListenerOperations({ supervisor: new SupervisorClient(url), board: team, git }) }
  }

  test('a reload builds main of the GitHub repository at the subpath with the channel Dockerfile, and runs it on the chosen address', async () => {
    const origin = join(directory, 'owner', 'site.git')
    const work = join(directory, 'work')
    execFileSync('git', ['init', '--quiet', '--initial-branch=master', work])
    execFileSync('sh', ['-c', 'mkdir -p site && echo "<h1>hello</h1>" > site/index.html && echo other > README.md'], { cwd: work })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: work })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'site'], { cwd: work })
    execFileSync('git', ['clone', '--quiet', '--bare', work, origin])
    const { operations, id, posted } = await setup('work/site', 'https://github.com/owner/site')
    const outcome = await operations.act('work/site', id, 'reload', 'tester')
    assert.match(outcome, /^web reloaded at master [0-9a-f]{7}, running on 127\.0\.0\.1:\d+$/)
    const build = calls.find((call) => call.path === `/listeners/${id}/build?dockerfile=Dockerfile.politburo`)!
    assert.deepEqual(build.files, { 'index.html': '<h1>hello</h1>\n', 'Dockerfile.politburo': 'FROM scratch\n' })
    assert.deepEqual(calls.find((call) => call.path === `/listeners/${id}/run`)!.body, { port: openPort, container_port: 3000, addresses: ['127.0.0.1'] })
    assert.ok(posted.some((text) => text.startsWith('Listener: web reloaded at master')))
  })

  test('main wins over master; a local channel builds its local repository', async () => {
    const { operations, id, git } = await setup('work/notes', null)
    await git.localHead('local:work/notes')
    await assert.rejects(operations.act('work/notes', id, 'reload', 'tester'), /git archive failed/)
    calls.length = 0
    const archive = await git.deploymentArchive('local:work/notes', '')
    assert.equal(archive.branch, 'main')
  })

  test('the health check sees an open and a closed port, and keeps the time of the last change', async () => {
    const { operations, id } = await setup('work/health', null)
    await operations.checkAll()
    const [status] = await operations.statuses('work/health')
    assert.equal(status!.id, id)
    assert.equal(status!.endpoints.length, 1)
    assert.equal(status!.endpoints[0]!.open, true)
    assert.equal(typeof status!.endpoints[0]!.connect_ms, 'number')
    const since = status!.endpoints[0]!.since
    await operations.checkAll()
    assert.equal((await operations.statuses('work/health'))[0]!.endpoints[0]!.since, since)
    assert.deepEqual(await probe('127.0.0.1', 1, 500), { open: false, connect_ms: null })
  })

  test('the orchestrator changes the Dockerfile and every listener reloads', async () => {
    const { operations, team } = await setup('work/docker', null)
    const outcome = await operations.setDockerfile('work/docker', 'FROM node:24-alpine\nCMD ["node", "server.js"]', 'tester')
    assert.match(outcome, /web reload failed/)
    const settings = (await team.channels({ prefix: 'work/docker', limit: 10 })).channels[0]!.settings as unknown as { local: { dockerfile: string } }
    assert.equal(settings.local.dockerfile, 'FROM node:24-alpine\nCMD ["node", "server.js"]\n')
  })

  test('a listener id must carry its channel prefix; start and stop go to the supervisor', async () => {
    const { operations, id, team } = await setup('work/ids', null)
    assert.equal(await operations.act('work/ids', id, 'stop', 'tester'), 'web stopped')
    await team.configureChannel('work/ids', { repository: null, routes: [], local: { dockerfile: 'FROM scratch\n', listeners: [{ id: 'other-web', name: 'web', subpath: '', port: 9, containerPort: 9, interfaces: ['lan'] }] } } as never)
    await assert.rejects(operations.act('work/ids', 'other-web', 'start', 'tester'), /start with work-ids-/)
  })

  test('tar append keeps the files before it', () => {
    const tar = execFileSync('tar', ['-cf', '-', '-C', join(import.meta.dirname, '..', 'templates'), 'listener.Dockerfile'])
    const files = tarFiles(appendTarFile(tar, 'extra.txt', 'x'.repeat(700)))
    assert.ok(files['listener.Dockerfile']!.includes('FROM node'))
    assert.equal(files['extra.txt']!.length, 700)
  })

  test('listener actions are offered in a channel with local deployment', () => {
    const actions = applicableActions({ task: null, pull_request: null, worker: null, railway: null, local: { dockerfile: 'FROM scratch', listeners: [{ name: 'web', subpath: '.', port: 80, running: true, endpoints: [], last_build: null, log_tail: [] }] } })
    assert.ok(['listener_start', 'listener_stop', 'listener_reload', 'listener_dockerfile'].every((name) => name in actions))
  })
})
