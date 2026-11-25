import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import { board as openBoard } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createRelay, generateSigningKeys, MessageStore, type Relay } from '@remilia/politburo-relay'
import { envelope, parseCommand, type Command, type ResultData } from '@remilia/politburo-relay/messages'
import { parseConfig } from '../src/orchestrator/config.ts'
import { GitHubClient } from '../src/orchestrator/github.ts'
import { openJournal, type Provider } from '../src/orchestrator/launch.ts'
import { RelayClient } from '../src/orchestrator/relay-client.ts'
import { Orchestrator } from '../src/orchestrator/service.ts'
import { StateStore } from '../src/orchestrator/state.ts'

const BASE = '1'.repeat(40)
const HEAD = '2'.repeat(40)

/** A fake GitHub with one repository; the fake worker "pushes" by setting a branch head. */
function fakeGitHub() {
  const branches = new Map<string, string>([['main', BASE]])
  const pulls: Array<{ html_url: string; head: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/repos/owner/repo') return json(200, { full_name: 'owner/repo', default_branch: 'main' })
    const branch = /^\/repos\/owner\/repo\/branches\/(.+)$/.exec(url.pathname)
    if (branch) {
      const sha = branches.get(decodeURIComponent(branch[1]!))
      return sha ? json(200, { commit: { sha } }) : json(404, { message: 'Not Found' })
    }
    if (url.pathname === '/repos/owner/repo/pulls' && (init?.method ?? 'GET') === 'GET') return json(200, [])
    if (url.pathname === '/repos/owner/repo/pulls' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { head: string; base: string; draft: boolean }
      assert.equal(body.draft, true)
      assert.ok(!body.head.includes(':'), 'the PR head stays in the same repository')
      const pull = { html_url: `https://github.com/owner/repo/pull/${pulls.length + 1}`, head: body.head }
      pulls.push(pull)
      return json(201, pull)
    }
    return json(404, { message: `unexpected ${url.pathname}` })
  }
  return { branches, pulls, client: new GitHubClient({ apiUrl: 'https://api.github.test', token: 'test', fetch }) }
}

type WorkerScript = (command: Command, send: (type: string, data: unknown) => Promise<void>) => Promise<void>

/** A fake cloud worker: reads the prompt, follows the commands channel, answers by `script`. */
function fakeWorker(relayUrl: string, script: WorkerScript, launches: string[]): (prompt: string) => Provider {
  return (prompt) => ({
    async send() {
      const channel = /channel: (\S+)/.exec(prompt)![1]!
      const token = /bootstrap_token: (\S+)/.exec(prompt)![1]!
      launches.push(channel)
      void (async () => {
        const controller = new AbortController()
        const response = await fetch(`${relayUrl}/channels/${channel}/commands`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal })
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let task = ''
        const send = async (type: string, data: unknown) => {
          await fetch(`${relayUrl}/channels/${channel}/telemetry`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(envelope(type, task, channel, data)),
          })
        }
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            let end: number
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              const data = frame.split('\n').find((line) => line.startsWith('data: '))
              if (!data) continue
              const parsed = parseCommand((JSON.parse(data.slice(6)) as { body: unknown }).body)
              assert.ok(parsed.ok, parsed.ok ? '' : parsed.error)
              task = parsed.message.task
              if (parsed.message.type === 'stop') { controller.abort(); return }
              await script(parsed.message, send)
            }
          }
        } catch { /* stream closed */ }
      })()
      return { session: `session_fake${launches.length}` }
    },
    async probe() { return { kind: 'unknown' } },
  })
}

const result = (round: number, checkExit: number): ResultData => ({
  round, exit_reason: 'completed', pi_exit_code: 0, summary: 'Parser fixed.', branch: 'claude/task-PLACEHOLDER', head_commit: HEAD,
  base_commit: BASE, pushed: true, push_error: null, diff_stat: { files: 2, insertions: 10, deletions: 3 },
  checks: [{ name: 'test', exit_code: checkExit, duration_seconds: 1, output_tail: checkExit ? 'expected 2, got 3' : 'ok' }],
  models: [{ provider: 'openrouter', model: 'm', input_tokens: 100, output_tokens: 50, cost_usd: 0.02 }],
  cost_usd: 0.02, duration_seconds: 30, truncated: [],
})

describe('orchestrator', () => {
  let directory: string
  let relayStore: MessageStore
  let relay: Relay
  let relayUrl: string
  const keys = generateSigningKeys()

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'orchestrator-test-'))
    relayStore = new MessageStore(join(directory, 'relay.sqlite'))
    relay = createRelay({ verificationKey: keys.publicKeyPem, store: relayStore })
    await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
    relayUrl = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  })

  after(async () => {
    await relay.close()
    relayStore.close()
    rmSync(directory, { recursive: true, force: true })
  })

  async function setup(name: string, script: WorkerScript, overrides = '', allow = 'owner/repo') {
    const team = openBoard({ backend: local({ memory: true }) })
    await team.post('work/app', 'channel')
    await team.configureChannel('work/app', { repository: 'https://github.com/owner/repo', routes: [] })
    const stateDirectory = join(directory, name)
    mkdirSync(join(stateDirectory, 'journal'), { recursive: true })
    const config = parseConfig(`
state_directory: ${stateDirectory}
sweep_seconds: 1
relay: { url: ${relayUrl}, signing_key_file: unused }
channels: { include: [work/] }
repositories: { allow: [${allow}] }
watchdog: { heartbeat_seconds: 5, contact_timeout_seconds: 2, missed_heartbeats: 2, stop_grace_seconds: 1, question_wait_seconds: 30 }
${overrides}
`)
    const github = fakeGitHub()
    const launches: string[] = []
    const state = new StateStore(join(stateDirectory, 'state.sqlite'))
    const logs: Array<Record<string, unknown>> = []
    const orchestrator = new Orchestrator({
      config,
      board: team.as('orchestrator'),
      relay: new RelayClient({ url: relayUrl, signingKey: keys.privateKeyPem, orchestratorTtlSeconds: 300 }),
      github: github.client,
      state,
      journal: openJournal(join(stateDirectory, 'journal')),
      routes: () => [{ label: 'Route A', provider: 'openrouter', model: 'm' }],
      provider: fakeWorker(relayUrl, async (command, send) => {
        if (command.type === 'start') github.branches.set(command.data.branch, HEAD)
        await script(command, send)
      }, launches),
      log: (entry) => logs.push(entry),
    })
    const done = async (id: string, states: string[]) => {
      for (let i = 0; i < 200; i++) {
        const { message } = await team.thread(id)
        if (message.task && states.includes(message.task.state)) return message
        await sleep(50)
      }
      throw new Error(`task ${id} did not reach ${states.join('/')}: ${JSON.stringify(logs.slice(-5))}`)
    }
    return { team, orchestrator, state, github, launches, logs, done }
  }

  test('runs a task to a draft PR in the same repository and completes it', async () => {
    const run = await setup('publish', async (command, send) => {
      if (command.type !== 'start') return
      await send('heartbeat', { state: 'running', round: 1, last_command_seq: 1, elapsed_seconds: 1, token_exp: 9e9, pi_alive: true })
      await send('result', { ...result(1, 0), branch: command.data.branch })
    })
    const { task } = await run.team.tasks.create('work/app', 'Fix the parser')
    await run.orchestrator.start()
    try {
      const message = await run.done(task.id, ['completed'])
      assert.equal(run.github.pulls.length, 1)
      assert.equal(run.github.pulls[0]!.head, `claude/task-${task.id}`)
      assert.match(String(message.task?.result), /github\.com\/owner\/repo\/pull\/1/)
      assert.equal(run.launches.length, 1)
      assert.equal(run.state.live().length, 0)
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('sends failing check output as a new round, then publishes', async () => {
    const rounds: number[] = []
    const run = await setup('repair', async (command, send) => {
      if (command.type === 'start') {
        rounds.push(1)
        await send('result', { ...result(1, 1), branch: command.data.branch })
      }
      if (command.type === 'instruct') {
        rounds.push(command.data.round)
        assert.match(command.data.text, /expected 2, got 3/)
        await send('result', { ...result(command.data.round, 0), branch: `claude/task-${command.task}` })
      }
    })
    const { task } = await run.team.tasks.create('work/app', 'Fix the parser again')
    await run.orchestrator.start()
    try {
      await run.done(task.id, ['completed'])
      assert.deepEqual(rounds, [1, 2])
      assert.equal(run.github.pulls.length, 1)
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('a worker that never makes contact is stopped, lost, and the task fails at the attempt limit', async () => {
    const run = await setup('silent', async () => {}, 'limits: { attempts_per_task: 1 }')
    const { task } = await run.team.tasks.create('work/app', 'Never answered')
    await run.orchestrator.start()
    try {
      const message = await run.done(task.id, ['failed'])
      assert.match(String(message.task?.result ?? message.task?.reason ?? ''), /lost/i)
      assert.equal(run.github.pulls.length, 0)
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('skips a channel whose repository is not allowed, and says why once', async () => {
    const run = await setup('denied', async () => {}, '', 'owner/other')
    const { task } = await run.team.tasks.create('work/app', 'Not allowed')
    await run.orchestrator.start()
    try {
      await sleep(300)
      await run.orchestrator.tick()
      const thread = await run.team.thread(task.id)
      const notes = thread.replies.filter((reply) => reply.text.includes('not on the orchestrator allow list'))
      assert.equal(notes.length, 1)
      assert.equal(thread.message.task?.state, 'ready')
      assert.equal(run.launches.length, 0)
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })
})
