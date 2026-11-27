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
import { parseConfig } from '../src/config.ts'
import { FinalDecider, KevClient, type ClaudeRunner } from '../src/final-decision.ts'
import { GitRepositories, localRepository } from '../src/git.ts'
import { GitHubClient } from '../src/github.ts'
import { openJournal, type Provider } from '../src/launch.ts'
import { RelayClient } from '../src/relay-client.ts'
import { Orchestrator } from '../src/service.ts'
import { StateStore } from '../src/state.ts'
import { PACKAGES_DIRECTORY } from '../src/worker-files.ts'

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
  if (process.env.OPENROUTER_API_KEY !== 'sealed-test-key') {
    emit({ type: 'message_end', message: { role: 'assistant', content: [], errorMessage: 'No fallback tier is ready (missing login or cooling down)' } })
    return
  }
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
    process.env.OPENROUTER_API_KEY = 'sealed-test-key'
    mkdirSync(join(directory, 'bin'))
    writeFileSync(join(directory, 'bin', 'pi'), FAKE_PI)
    chmodSync(join(directory, 'bin', 'pi'), 0o755)
  })

  after(async () => {
    delete process.env.OPENROUTER_API_KEY
    for (const worker of workers) worker.kill('SIGKILL')
    await relay.close()
    relayStore.close()
    rmSync(directory, { recursive: true, force: true })
  })

  async function setup(name: string, piMode: string, decider: FinalDecider | null = null) {
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
        // The worker gets the provider key only through the sealed credentials command.
        const { OPENROUTER_API_KEY: _key, ...withoutKey } = process.env
        const worker = spawn(process.execPath, ['--experimental-strip-types', join(upload, '.politburo/packages/worker/src/cli.ts'), 'run', '--relay-url', relayUrl, '--channel', channel], {
          cwd: upload,
          env: { ...withoutKey, HOME: home, POLITBURO_WORKER_HOME: join(home, '.politburo_worker'), PATH: `${join(directory, 'bin')}:${process.env.PATH}`, FAKE_PI_MODE: piMode },
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
      provider, log: (entry) => logs.push(entry), decider,
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
      const { replies } = await run.team.thread(task.id)
      assert.ok(replies.some((reply) => reply.labels['politburo.status'] === 'orchestrator' && /^round 2 sent to the worker/.test(reply.text)), 'status lines carry the label')
      const round2 = replies.find((reply) => reply.text.startsWith('```json#worker_activity@1') && reply.text.includes('"round":2'))
      assert.ok(round2, 'one reply per round, with the activity block')
      assert.match(round2.text, /"state":"completed"/)
      assert.match(round2.text, /"kind":"tool","text":"edit parser.ts"/)
      assert.match(round2.text, /```\n\nparse now returns 3$/, 'the final answer is the reply text')
      assert.equal(round2.blocks?.[0]?.schema, 'worker_activity')
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('the final decision: Claude corrects a failing check, then Kev and Claude follow up with a new task', async () => {
    const kevFetch = (async () => new Response(JSON.stringify({ answers: { next: { type: 'choice', choice: 'FOLLOWUP', confidence: 0.9, probabilities: {} } } }))) as unknown as typeof fetch
    const asked: string[][] = []
    const claude: ClaudeRunner = async ({ schema }) => {
      const allowed = (schema as { properties: { label: { enum: string[] } } }).properties.label.enum
      asked.push(allowed)
      return allowed.includes('FOLLOWUP')
        ? { label: 'FOLLOWUP', reason: 'The parser needs a test.', followups: [{ title: 'Test parse', brief: 'Add a unit test for parse.' }] }
        : { label: 'RETRY', reason: 'The check is fixable.', correction: 'The value checks fail: make parse return 3.' }
    }
    const decider = new FinalDecider({ kev: new KevClient({ url: 'http://kev.test', timeoutMs: 1_000, fetch: kevFetch }), claude, kevConfidence: 0.75, followupDepth: 3 })
    const run = await setup('decision', 'plain', decider)
    const { task } = await run.team.tasks.create('work/app', 'Make parse return 3')
    await run.orchestrator.start()
    try {
      await run.until('task completion', async () => (await run.team.thread(task.id)).message.task?.state === 'completed', 90)
      await run.until('the decision label', async () => (await run.team.thread(task.id)).message.labels['politburo.decision'] === 'FOLLOWUP', 20)
      assert.deepEqual(asked, [['RETRY', 'REVIEW'], ['PASS', 'FOLLOWUP', 'RETRY', 'REVIEW']])
      const { replies } = await run.team.thread(task.id)
      const decisions = replies.filter((reply) => reply.blocks?.[0]?.schema === 'final_decision').map((reply) => reply.blocks![0]!.data as Record<string, unknown>)
      assert.deepEqual(decisions.map((data) => [data.label, data.decided_by]), [['RETRY', 'claude'], ['FOLLOWUP', 'claude']])
      assert.deepEqual(decisions[1]!.kev, { label: 'FOLLOWUP', confidence: 0.9 })
      const followup = (decisions[1]!.followups as Array<{ id: string; title: string }>)[0]!
      assert.equal(followup.title, 'Test parse')
      const created = (await run.team.thread(followup.id)).message
      assert.match(created.text, /^Test parse\n\nAdd a unit test for parse\.\n\nFollow-up of #/)
      assert.deepEqual([created.labels['politburo.followup_of'], created.labels['politburo.followup_depth']], [task.id, '1'])
      assert.equal(run.github.pulls.length, 1)
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
    const { workerFiles } = await import('../src/worker-files.ts')
    await repositories.prepareLaunchDirectory('owner/repo', base, launch, workerFiles(PACKAGES_DIRECTORY))
    assert.equal(git(launch, 'rev-parse', 'HEAD~1'), base)
    assert.equal(git(launch, 'remote'), '')
    assert.equal(git(launch, 'status', '--porcelain'), '')
    assert.ok(existsSync(join(launch, '.politburo/packages/worker/src/cli.ts')))
    assert.ok(existsSync(join(launch, '.politburo/packages/relay/src/messages.ts')))
  })

  test('a channel without a repository works in its local repository: tasks start from main and merge into it', async () => {
    const root = join(directory, 'local')
    const repositories = new GitRepositories({ directory: join(root, 'mirrors'), localDirectory: join(root, 'channels'), urlBase: root, token: null })
    const repository = localRepository('hello/world')
    const base = await repositories.localHead(repository)
    assert.equal(await repositories.localHead(repository), base, 'the repository is created once')
    const { workerFiles } = await import('../src/worker-files.ts')
    const work = async (task: string, file: string, content: string, from: string) => {
      const launch = join(root, `launch-${task}`)
      await repositories.prepareLaunchDirectory(repository, from, launch, workerFiles(PACKAGES_DIRECTORY))
      git(launch, 'checkout', '--quiet', '-B', `claude/task-${task}`, from)
      writeFileSync(join(launch, file), content)
      git(launch, 'add', file)
      git(launch, '-c', 'user.name=w', '-c', 'user.email=w@localhost', 'commit', '--quiet', '-m', `task ${task}`)
      const bundleFile = join(root, `${task}.bundle`)
      git(launch, 'bundle', 'create', '--quiet', bundleFile, `claude/task-${task}`, `^${from}`)
      return { bundleFile, branch: `claude/task-${task}`, head: git(launch, 'rev-parse', 'HEAD'), base: from, message: `Merge task ${task}` }
    }
    const first = await work('1', 'a.txt', 'a', base)
    const second = await work('2', 'b.txt', 'b', base)
    const conflict = await work('3', 'a.txt', 'other', base)
    assert.equal(await repositories.mergeBundle(repository, first), first.head, 'main moves forward')
    const merged = await repositories.mergeBundle(repository, second)
    const bare = join(root, 'channels', 'hello_world.git')
    assert.equal(git(bare, 'rev-list', '--parents', '-n', '1', merged), `${merged} ${first.head} ${second.head}`, 'a merge commit joins parallel work')
    assert.equal(git(bare, 'show', 'main:b.txt'), 'b')
    await assert.rejects(repositories.mergeBundle(repository, conflict), /conflicts with main/)
    assert.equal(git(bare, 'rev-parse', 'main'), merged, 'a conflict leaves main as it is')
    assert.equal(git(bare, 'rev-parse', 'claude/task-3'), conflict.head, 'the work stays on its branch')
  })
})
