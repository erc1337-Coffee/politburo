// End to end: orchestrator, in-process relay and the real worker client in a child process,
// with a local git origin, a fake GitHub API and a fake `pi` that edits the checkout.
import { strict as assert } from 'node:assert'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import { board as openBoard } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createRelay, generateSigningKeys, MessageStore, type Relay } from '@remilia/politburo-relay'
import { parseConfig } from '../src/orchestrator/config.ts'
import { GitRepositories } from '../src/orchestrator/git.ts'
import { GitHubClient } from '../src/orchestrator/github.ts'
import { openJournal, type Provider } from '../src/orchestrator/launch.ts'
import { RelayClient } from '../src/orchestrator/relay-client.ts'
import { Orchestrator } from '../src/orchestrator/service.ts'
import { StateStore } from '../src/orchestrator/state.ts'
import { PACKAGES_DIRECTORY } from '../src/orchestrator/worker-files.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim()

function createOrigin(root: string): string {
  const seed = join(root, 'seed')
  mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'parser.ts'), 'export const parse = () => 1\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'base')
  mkdirSync(join(root, 'owner'), { recursive: true })
  git(root, 'clone', '-q', '--bare', seed, join(root, 'owner', 'repo.git'))
  return git(seed, 'rev-parse', 'HEAD')
}

function fakeGitHub(originRoot: string) {
  const origin = join(originRoot, 'owner', 'repo.git')
  const branchHead = (name: string) => { try { return git(origin, 'rev-parse', `refs/heads/${name}`) } catch { return null } }
  const pulls: Array<{ html_url: string; head: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/repos/owner/repo') return json(200, { full_name: 'owner/repo', default_branch: 'main' })
    const branch = /^\/repos\/owner\/repo\/branches\/(.+)$/.exec(url.pathname)
    if (branch) {
      const sha = branchHead(decodeURIComponent(branch[1]!))
      return sha ? json(200, { commit: { sha } }) : json(404, { message: 'Not Found' })
    }
    if (url.pathname === '/repos/owner/repo/pulls' && (init?.method ?? 'GET') === 'GET') return json(200, [])
    if (url.pathname === '/repos/owner/repo/pulls' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { head: string }
      const pull = { html_url: `https://github.com/owner/repo/pull/${pulls.length + 1}`, head: body.head }
      pulls.push(pull)
      return json(201, pull)
    }
    return json(404, { message: 'unexpected' })
  }
  return { origin, branchHead, pulls, client: new GitHubClient({ apiUrl: 'https://api.github.test', token: 'test', fetch }) }
}

/** A stand-in for `pi -p --mode json`: edits parser.ts, may ask a question, prints Pi JSONL events. */
const FAKE_PI = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
const prompt = args[args.indexOf('--') + 1] || ''
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
async function main() {
  let value = /checks fail/.test(prompt) ? 3 : 2
  if (process.env.FAKE_PI_MODE === 'ask' && !/checks fail/.test(prompt)) {
    const dir = process.env.POLITBURO_QUESTION_DIRECTORY
    fs.writeFileSync(path.join(dir, 'qfake.question.json'), JSON.stringify({ id: 'qfake', text: 'Which value should parse return?', options: ['3', '4'] }))
    const answer = path.join(dir, 'qfake.answer.json')
    for (let i = 0; i < 600 && !fs.existsSync(answer); i++) await new Promise((r) => setTimeout(r, 100))
    value = Number(JSON.parse(fs.readFileSync(answer, 'utf8')).text.replace(/\\D/g, '')) || 0
    fs.rmSync(path.join(dir, 'qfake.question.json'), { force: true })
  }
  emit({ type: 'tool_execution_start', toolName: 'edit', args: { path: 'parser.ts' } })
  fs.writeFileSync('parser.ts', 'export const parse = () => ' + value + '\\n')
  emit({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model: 'fake', content: [{ type: 'text', text: 'parse now returns ' + value }], usage: { input: 10, output: 5, cost: { total: 0.01 } } } })
  emit({ type: 'agent_end', messages: [] })
}
main()
`

describe('orchestrator with the real worker client', () => {
  let directory: string
  let relayStore: MessageStore
  let relay: Relay
  let relayUrl: string
  const keys = generateSigningKeys()
  const workers: ChildProcess[] = []

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'orchestrator-worker-test-'))
    relayStore = new MessageStore(join(directory, 'relay.sqlite'))
    relay = createRelay({ verificationKey: keys.publicKeyPem, store: relayStore })
    await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
    relayUrl = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
    mkdirSync(join(directory, 'bin'))
    writeFileSync(join(directory, 'bin', 'pi'), FAKE_PI)
    chmodSync(join(directory, 'bin', 'pi'), 0o755)
  })

  after(async () => {
    for (const worker of workers) worker.kill('SIGKILL')
    await relay.close()
    relayStore.close()
    rmSync(directory, { recursive: true, force: true })
  })

  async function setup(name: string, piMode: string) {
    const team = openBoard({ backend: local({ memory: true }) })
    await team.post('work/app', 'channel')
    await team.configureChannel('work/app', { repository: 'https://github.com/owner/repo', routes: [] })
    const root = join(directory, name)
    const stateDirectory = join(root, 'orchestrator')
    mkdirSync(join(stateDirectory, 'journal'), { recursive: true })
    const config = parseConfig(`
state_directory: ${stateDirectory}
sweep_seconds: 1
relay: { signing_key_file: unused }
watchdog: { heartbeat_seconds: 5, contact_timeout_seconds: 60, missed_heartbeats: 6, stop_grace_seconds: 5, question_wait_seconds: 60 }
worker:
  checks:
    - { name: value, command: "grep -q '=> 3' parser.ts", timeout_seconds: 30 }
`, { RELAY_URL: relayUrl })
    const originRoot = join(root, 'origin')
    createOrigin(originRoot)
    const github = fakeGitHub(originRoot)
    const state = new StateStore(join(stateDirectory, 'state.sqlite'))
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const logs: Array<Record<string, unknown>> = []
    const channels: string[] = []
    const provider = (prompt: string, launchDirectory: string): Provider => ({
      async send() {
        const channel = /channel: (\S+)/.exec(prompt)![1]!
        const token = /bootstrap_token: (\S+)/.exec(prompt)![1]!
        const protocol = /instruction_file: (\S+)/.exec(prompt)![1]!
        // The upload: the session receives a copy of the launch directory.
        const upload = join(root, `upload-${channel}`)
        cpSync(launchDirectory, upload, { recursive: true })
        assert.ok(existsSync(join(upload, protocol)), 'the protocol file is in the upload')
        const worker = spawn(process.execPath, ['--experimental-strip-types', join(upload, '.politburo/packages/worker/src/cli.ts'), 'run', '--relay-url', relayUrl, '--channel', channel], {
          cwd: upload,
          env: { ...process.env, HOME: home, POLITBURO_WORKER_HOME: join(home, '.politburo_worker'), PATH: `${join(directory, 'bin')}:${process.env.PATH}`, FAKE_PI_MODE: piMode },
          stdio: ['pipe', 'ignore', 'pipe'],
        })
        let stderr = ''
        worker.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        worker.on('exit', (code) => logs.push({ event: 'worker_exit', code, stderr: stderr.slice(-2_000) }))
        worker.stdin!.end(`${token}\n`)
        workers.push(worker)
        channels.push(channel)
        return { session: `session_fake${channels.length}` }
      },
      async probe() { return { kind: 'unknown' } },
    })
    const orchestrator = new Orchestrator({
      config, board: team.as('orchestrator'),
      relay: new RelayClient({ url: relayUrl, signingKey: keys.privateKeyPem, orchestratorTtlSeconds: 300 }),
      github: github.client,
      git: new GitRepositories({ directory: join(stateDirectory, 'repositories'), urlBase: originRoot, token: null }),
      state, journal: openJournal(join(stateDirectory, 'journal')),
      routes: () => [{ label: 'Route A', provider: 'openrouter', model: 'fake' }],
      provider, log: (entry) => logs.push(entry),
    })
    const until = async (what: string, check: () => Promise<boolean> | boolean, seconds = 60) => {
      for (let i = 0; i < seconds * 10; i++) {
        if (await check()) return
        await sleep(100)
      }
      throw new Error(`${what} did not happen: ${JSON.stringify(logs.slice(-8))}`)
    }
    const workerExit = (channel: string) => {
      const file = join(home, '.politburo_worker', channel, 'exit.json')
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { code: number }).code : null
    }
    return { team, orchestrator, state, github, channels, logs, until, workerExit }
  }

  test('a failing check gets a second round; the orchestrator pushes the bundle and opens the draft PR', async () => {
    const run = await setup('rounds', 'plain')
    const { task } = await run.team.tasks.create('work/app', 'Make parse return 3')
    await run.orchestrator.start()
    try {
      await run.until('task completion', async () => (await run.team.thread(task.id)).message.task?.state === 'completed', 90)
      const branch = `claude/task-${task.id}`
      assert.equal(git(run.github.origin, 'show', `${branch}:parser.ts`), 'export const parse = () => 3')
      assert.equal(git(run.github.origin, 'rev-list', '--count', `main..${branch}`), '2', 'one commit per round')
      assert.equal(run.github.pulls.length, 1)
      assert.ok(!git(run.github.origin, 'ls-tree', '-r', '--name-only', branch).includes('.politburo'), 'the worker client is not in the task branch')
      await run.until('worker exit', () => run.workerExit(run.channels[0]!) !== null, 40)
      assert.equal(run.workerExit(run.channels[0]!), 0)
      const replies = (await run.team.thread(task.id)).replies.map((reply) => reply.text).join('\n')
      assert.match(replies, /round 2 sent to the worker/)
      assert.match(replies, /Worker report \(round 2, completed\): parse now returns 3/)
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('a question from Pi reaches the task thread and the first human reply is the answer', async () => {
    const run = await setup('question', 'ask')
    const { task } = await run.team.tasks.create('work/app', 'Make parse return what the owner says')
    await run.orchestrator.start()
    try {
      await run.until('question in the thread', async () => (await run.team.thread(task.id)).replies.some((reply) => reply.text.includes('Which value should parse return?')), 60)
      await run.team.reply(task.id, 'Use 3.')
      await run.until('task completion', async () => (await run.team.thread(task.id)).message.task?.state === 'completed', 90)
      assert.equal(git(run.github.origin, 'show', `claude/task-${task.id}:parser.ts`), 'export const parse = () => 3')
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('the launch directory holds the worker client on top of the base commit, without a remote', async () => {
    const root = join(directory, 'launch')
    const originRoot = join(root, 'origin')
    const base = createOrigin(originRoot)
    const repositories = new GitRepositories({ directory: join(root, 'mirrors'), urlBase: originRoot, token: null })
    const launch = join(root, 'launch')
    const { workerFiles } = await import('../src/orchestrator/worker-files.ts')
    await repositories.prepareLaunchDirectory('owner/repo', base, launch, workerFiles(PACKAGES_DIRECTORY))
    assert.equal(git(launch, 'rev-parse', 'HEAD~1'), base)
    assert.equal(git(launch, 'remote'), '')
    assert.equal(git(launch, 'status', '--porcelain'), '')
    assert.ok(existsSync(join(launch, '.politburo/packages/worker/src/cli.ts')))
    assert.ok(existsSync(join(launch, '.politburo/packages/relay/src/messages.ts')))
  })
})
