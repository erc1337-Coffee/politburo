import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import { board as openBoard } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createRelay, generateSigningKeys, MessageStore, type Relay } from '@remilia/politburo-relay'
import { BUNDLE_PART_MAX, envelope, parseCommand, type Command, type ResultData } from '@remilia/politburo-relay/messages'
import { parseConfig } from '../src/config.ts'
import { GitRepositories } from '../src/git.ts'
import { GitHubClient } from '../src/github.ts'
import { openJournal, type Provider } from '../src/launch.ts'
import { RelayClient } from '../src/relay-client.ts'
import { Orchestrator } from '../src/service.ts'
import { ThreadAssistant, type ThreadFacts } from '../src/thread-assistant.ts'
import { StateStore } from '../src/state.ts'
import { UsageLedger } from '../src/usage-ledger.ts'
import { OperationsMonitor } from '../src/operations.ts'
import { startOperationsServer } from '../src/operations-server.ts'
import { readLedger, rollupBy } from '@remilia/politburo-ledger'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

/** A bare origin `owner/repo.git` under `root` with one commit on main; returns that commit. */
function createOrigin(root: string): string {
  const work = join(root, 'seed')
  mkdirSync(work, { recursive: true })
  git(work, 'init', '-q', '-b', 'main')
  writeFileSync(join(work, 'parser.ts'), 'export const parse = () => 1\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'base')
  mkdirSync(join(root, 'owner'), { recursive: true })
  git(root, 'clone', '-q', '--bare', work, join(root, 'owner', 'repo.git'))
  return git(work, 'rev-parse', 'HEAD')
}

/** Worker side: commit on the task branch, bundle base..branch, base64 parts. */
function workerBundle(origin: string, scratch: string, branch: string, base: string, round: number) {
  const work = join(scratch, `${branch.replace('/', '_')}_${round}`)
  git(scratch, 'clone', '-q', origin, work)
  git(work, 'checkout', '-q', '-b', branch)
  writeFileSync(join(work, 'parser.ts'), `export const parse = () => ${round + 1}\n`)
  git(work, 'commit', '-q', '-am', `round ${round}`)
  const file = join(work, 'commits.bundle')
  git(work, 'bundle', 'create', '-q', file, branch, `^${base}`)
  const bytes = readFileSync(file)
  const text = bytes.toString('base64')
  const parts: string[] = []
  for (let offset = 0; offset < text.length; offset += BUNDLE_PART_MAX) parts.push(text.slice(offset, offset + BUNDLE_PART_MAX))
  return { head: git(work, 'rev-parse', 'HEAD'), parts, bundle: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, parts: parts.length } }
}

/** A fake GitHub API for one repository whose git data is the local origin. */
function fakeGitHub(originRoot: string) {
  const origin = join(originRoot, 'owner', 'repo.git')
  const branchHead = (name: string) => { try { return git(origin, 'rev-parse', `refs/heads/${name}`) } catch { return null } }
  const pulls: Array<{ html_url: string; head: string; number: number; draft: boolean; state: 'open' | 'closed'; merged: boolean }> = []
  const view = (pull: (typeof pulls)[number]) => ({
    html_url: pull.html_url, number: pull.number, state: pull.state, draft: pull.draft, merged_at: pull.merged ? '2026-11-27T00:00:00Z' : null,
    head: { sha: branchHead(pull.head) }, node_id: `PR_${pull.number}`, title: `PR ${pull.number}`, mergeable: true, mergeable_state: 'clean',
  })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/repos/owner/repo') return json(200, { full_name: 'owner/repo', default_branch: 'main' })
    const branch = /^\/repos\/owner\/repo\/branches\/(.+)$/.exec(url.pathname)
    if (branch) {
      const sha = branchHead(decodeURIComponent(branch[1]!))
      return sha ? json(200, { commit: { sha } }) : json(404, { message: 'Not Found' })
    }
    if (url.pathname === '/repos/owner/repo/pulls' && (init?.method ?? 'GET') === 'GET') {
      const head = url.searchParams.get('head')?.split(':')[1]
      return json(200, pulls.filter((pull) => pull.head === head).reverse().map(view))
    }
    const one = /^\/repos\/owner\/repo\/pulls\/(\d+)(\/merge)?$/.exec(url.pathname)
    if (one) {
      const pull = pulls[Number(one[1]) - 1]
      if (!pull) return json(404, { message: 'Not Found' })
      if (one[2] && init?.method === 'PUT') { pull.merged = true; pull.state = 'closed'; return json(200, { sha: 'f'.repeat(40), merged: true }) }
      if (init?.method === 'PATCH') { pull.state = (JSON.parse(String(init.body)) as { state: 'open' | 'closed' }).state; return json(200, view(pull)) }
      return json(200, view(pull))
    }
    if (/^\/repos\/owner\/repo\/commits\/[0-9a-f]+\/check-runs$/.test(url.pathname)) return json(200, { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] })
    if (/^\/repos\/owner\/repo\/commits\/[0-9a-f]+\/status$/.test(url.pathname)) return json(200, { state: 'success', total_count: 1 })
    if (url.pathname === '/graphql' && init?.method === 'POST') {
      const id = (JSON.parse(String(init.body)) as { variables: { id: string } }).variables.id
      const pull = pulls[Number(id.replace('PR_', '')) - 1]
      if (!pull) return json(200, { errors: [{ message: 'not found' }] })
      pull.draft = false
      return json(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })
    }
    if (url.pathname === '/repos/owner/repo/pulls' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { head: string; base: string; draft: boolean }
      assert.equal(body.draft, true)
      assert.ok(!body.head.includes(':'), 'the PR head stays in the same repository')
      const pull = { html_url: `https://github.com/owner/repo/pull/${pulls.length + 1}`, head: body.head, number: pulls.length + 1, draft: true, state: 'open' as const, merged: false }
      pulls.push(pull)
      return json(201, view(pull))
    }
    return json(404, { message: `unexpected ${url.pathname}` })
  }
  return { origin, branchHead, pulls, client: new GitHubClient({ apiUrl: 'https://api.github.test', token: 'test', fetch }) }
}

type Send = (type: string, data: unknown) => Promise<void>
/** Commits a round on the task branch, sends its bundle parts and the result. */
type Deliver = (round: number, checkExit: number) => Promise<void>
type WorkerScript = (command: Command, send: Send, deliver: Deliver) => Promise<void>
type RawScript = (command: Command, send: Send) => Promise<void>

/** A fake cloud worker: reads the prompt, follows the commands channel, answers by `script`. */
function fakeWorker(relayUrl: string, script: RawScript, launches: string[]): (prompt: string) => Provider {
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
        } catch (error) { if (process.env.ORCHESTRATOR_TEST_DEBUG) console.error(error) }
      })()
      return { session: `session_fake${launches.length}` }
    },
    async probe() { return { kind: 'unknown' } },
  })
}

const result = (round: number, checkExit: number, branch: string, base: string, head: string, bundle: ResultData['bundle']): ResultData => ({
  round, exit_reason: 'completed', pi_exit_code: 0, summary: 'Parser fixed.', branch, head_commit: head,
  base_commit: base, bundle, diff_stat: { files: 1, insertions: 1, deletions: 1 },
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

  async function setup(name: string, script: WorkerScript, overrides = '', options: { assistant?: (facts: ThreadFacts) => unknown } = {}) {
    const team = openBoard({ backend: local({ memory: true }) })
    await team.post('work/app', 'channel')
    await team.configureChannel('work/app', { repository: 'https://github.com/owner/repo', routes: [] })
    const stateDirectory = join(directory, name)
    mkdirSync(join(stateDirectory, 'journal'), { recursive: true })
    const config = parseConfig(`
state_directory: ${stateDirectory}
sweep_seconds: 1
relay: { signing_key_file: unused }
watchdog: { heartbeat_seconds: 5, contact_timeout_seconds: 2, missed_heartbeats: 2, stop_grace_seconds: 1, question_wait_seconds: 30 }
${overrides}
`, { RELAY_URL: relayUrl })
    const originRoot = join(stateDirectory, 'origin')
    const base = createOrigin(originRoot)
    const github = fakeGitHub(originRoot)
    const launches: string[] = []
    const state = new StateStore(join(stateDirectory, 'state.sqlite'))
    const logs: Array<Record<string, unknown>> = []
    const monitor = new OperationsMonitor({ relayUrl })
    const facts: ThreadFacts[] = []
    const resumed: string[] = []
    const starts: Array<Extract<Command, { type: 'start' }>['data']> = []
    const orchestrator = new Orchestrator({
      ...(options.assistant ? {
        assistant: new ThreadAssistant(async ({ prompt }) => {
          const seen = JSON.parse(prompt) as ThreadFacts
          facts.push(seen)
          return options.assistant!(seen)
        }),
      } : {}),
      config,
      board: team.as('orchestrator'),
      relay: new RelayClient({ url: relayUrl, signingKey: keys.privateKeyPem, orchestratorTtlSeconds: 300 }),
      github: github.client,
      git: new GitRepositories({ directory: join(stateDirectory, 'repositories'), urlBase: originRoot, token: null }),
      state,
      journal: openJournal(join(stateDirectory, 'journal')),
      routes: () => [{ label: 'Route A', provider: 'openrouter', model: 'm' }],
      provider: fakeWorker(relayUrl, async (command, send) => {
        const branch = command.type === 'start' ? command.data.branch : `claude/task-${command.task}`
        if (command.type === 'start') starts.push(command.data)
        const deliver: Deliver = async (round, checkExit) => {
          const made = workerBundle(github.origin, stateDirectory, branch, base, round)
          for (const [index, data] of made.parts.entries()) await send('bundle_part', { round, index, count: made.parts.length, data })
          await send('result', result(round, checkExit, branch, base, made.head, made.bundle))
        }
        await script(command, send, deliver)
      }, launches),
      resume: (session, prompt) => {
        resumed.push(session)
        return fakeWorker(relayUrl, async (command, send) => {
          if (command.type !== 'start') return
          starts.push(command.data)
          await send('result', {
            ...result(1, 0, command.data.branch, command.data.repository.base_commit, command.data.repository.base_commit, null),
            head_commit: null, diff_stat: { files: 0, insertions: 0, deletions: 0 }, summary: 'Nothing else to change.',
          })
        }, launches)(prompt)
      },
      usage: new UsageLedger({ file: join(stateDirectory, 'ledger', 'ledger.sqlite'), party: 'default', requestedRoute: 'openrouter/m' }),
      monitor,
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
    return { team, orchestrator, state, github, launches, logs, done, base, monitor, facts, resumed, starts, ledgerFile: join(stateDirectory, 'ledger', 'ledger.sqlite') }
  }

  test('runs a task to a draft PR in the same repository and completes it', async () => {
    const run = await setup('publish', async (command, send, deliver) => {
      if (command.type !== 'start') return
      await send('heartbeat', { state: 'running', round: 1, last_command_seq: 1, elapsed_seconds: 1, token_exp: 9e9, pi_alive: true })
      await deliver(1, 0)
    })
    const { task } = await run.team.tasks.create('work/app', 'Fix the parser')
    await run.orchestrator.start()
    try {
      const message = await run.done(task.id, ['completed'])
      assert.equal(run.github.pulls.length, 1)
      assert.equal(run.github.pulls[0]!.head, `claude/task-${task.id}`)
      const pushed = run.github.branchHead(`claude/task-${task.id}`)
      assert.ok(pushed && pushed !== run.base, 'the orchestrator pushed the worker commit')
      assert.equal(git(run.github.origin, 'merge-base', pushed, 'main'), run.base)
      assert.match(String(message.task?.result), /github\.com\/owner\/repo\/pull\/1/)
      assert.equal(run.launches.length, 1)
      assert.equal(run.state.live().length, 0)
      const ledger = readLedger(run.ledgerFile)
      assert.equal(ledger.dispatches().length, 1)
      assert.equal(ledger.dispatches()[0]!.envelope.work_id, `task-${task.id}`)
      assert.equal(ledger.dispatches()[0]!.envelope.tier, 'mob')
      const [row] = rollupBy(ledger, 'work_id')
      assert.equal(row!.totals.records, 1)
      assert.deepEqual(row!.totals.amounts, [{ basis: 'priced_estimate', unit: 'USD', known: '0.02', records: 1 }])
      assert.equal(row!.totals.tokens.output.known, 50)
      assert.equal(row!.totals.tokens.cache_read.unknown_records, 1)

      const events = run.monitor.since(0)!
      const kinds = (kind: string) => events.filter((event) => event.kind === kind)
      assert.ok(kinds('tick').length > 0)
      assert.ok(kinds('command').some((event) => event.kind === 'command' && event.type === 'start' && event.outcome === 'sent'))
      assert.deepEqual(kinds('telemetry').map((event) => event.kind === 'telemetry' && event.type), ['heartbeat', 'bundle_part', 'result'])
      assert.deepEqual(kinds('github').map((event) => event.kind === 'github' && event.action), ['push', 'draft_pr'])
      assert.ok(kinds('board').some((event) => event.kind === 'board' && event.action === 'claim'))
      assert.ok(kinds('board').some((event) => event.kind === 'board' && event.action === 'complete'))
      assert.ok(kinds('usage').some((event) => event.kind === 'usage' && event.output_tokens === 50))
      assert.ok(!JSON.stringify(events).includes('Fix the parser'), 'no task text in events')
      const snapshot = run.orchestrator.operations()!
      assert.equal(snapshot.relay.reachable, true)
      assert.equal(snapshot.attempts[0]!.state, 'settled')
      assert.equal(snapshot.attempts[0]!.heartbeat?.pi_alive, true)
      assert.ok(snapshot.relay.statistics !== null)

      const server = await startOperationsServer({ monitor: run.monitor, port: 0, snapshot: () => run.orchestrator.operations()! })
      try {
        assert.equal((await fetch(`${server.url}/state`)).status, 200)
        assert.equal((await fetch(`${server.url}/state`, { method: 'POST' })).status, 405)
        const attemptEvents = await (await fetch(`${server.url}/attempts/${snapshot.attempts[0]!.attempt_id}/events`)).json() as { events: unknown[] }
        assert.ok(attemptEvents.events.length > 3)
        const controller = new AbortController()
        const stream = await fetch(`${server.url}/events`, { headers: { 'last-event-id': String(events.at(-3)!.seq) }, signal: controller.signal })
        const reader = stream.body!.getReader()
        let text = ''
        while ((text.match(/^id: /gm) ?? []).length < 2) text += new TextDecoder().decode((await reader.read()).value)
        controller.abort()
        assert.match(text, new RegExp(`id: ${events.at(-2)!.seq}\n`))
      } finally {
        await server.close()
      }
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('sends failing check output as a new round, then publishes', async () => {
    const rounds: number[] = []
    const run = await setup('repair', async (command, _send, deliver) => {
      if (command.type === 'start') {
        rounds.push(1)
        await deliver(1, 1)
      }
      if (command.type === 'instruct') {
        rounds.push(command.data.round)
        assert.match(command.data.text, /expected 2, got 3/)
        await deliver(command.data.round, 0)
      }
    })
    const { task } = await run.team.tasks.create('work/app', 'Fix the parser again')
    await run.orchestrator.start()
    try {
      await run.done(task.id, ['completed'])
      assert.deepEqual(rounds, [1, 2])
      assert.equal(git(run.github.origin, 'show', `claude/task-${task.id}:parser.ts`), 'export const parse = () => 3')
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

  test('worker acknowledgements reach the operations view, and a failed setup loses the attempt at once', async () => {
    const run = await setup('setup_failure', async (command, send) => {
      if (command.type !== 'start') return
      await send('phase', { phase: 'started', round: 0 })
      await send('phase', { phase: 'setup_started', round: 0 })
      await send('phase', { phase: 'setup_failed', round: 0, duration_seconds: 4, detail: 'npm cannot reach the registry' })
    }, 'limits: { attempts_per_task: 1 }')
    const { task } = await run.team.tasks.create('work/app', 'Setup fails')
    await run.orchestrator.start()
    try {
      const message = await run.done(task.id, ['failed'])
      assert.match(String(message.task?.result ?? message.task?.reason ?? ''), /setup failed: npm cannot reach the registry/)
      const phases = run.logs.filter((entry) => entry.event === 'worker_phase').map((entry) => entry.phase)
      assert.deepEqual(phases, ['started', 'setup_started', 'setup_failed'])
      const snapshot = run.monitor.snapshot({ actor: 'a', live: [], liveLimit: 1, outbox: 0, sweepSeconds: 1, watchdogDue: () => null })
      const attempt = snapshot.attempts.find((row) => row.task_id === task.id)
      assert.equal(attempt?.phase?.phase, 'setup_failed')
      assert.equal(attempt?.phase?.detail, 'npm cannot reach the registry')
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  /** Waits until `check` holds, polling. */
  async function until(check: () => boolean | Promise<boolean>, what: string, logs: Array<Record<string, unknown>>): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await check()) return
      await sleep(50)
    }
    throw new Error(`${what} did not happen: ${JSON.stringify(logs.slice(-6))}`)
  }

  test('a person asks in the thread of a published task: the orchestrator model answers and marks the PR ready', async () => {
    const run = await setup('thread_ready', async (command, send, deliver) => {
      if (command.type !== 'start') return
      await send('heartbeat', { state: 'running', round: 1, last_command_seq: 1, elapsed_seconds: 1, token_exp: 9e9, pi_alive: true })
      await deliver(1, 0)
    }, '', {
      assistant: (facts) => /ready/.test(facts.message.text)
        ? { reply: 'The checks pass, so the pull request goes to review.', actions: [{ name: 'pr_ready' }, { name: 'pr_merge' }] }
        : { reply: '', actions: [] },
    })
    const { task } = await run.team.tasks.create('work/app', 'Fix the parser')
    await run.orchestrator.start()
    try {
      await run.done(task.id, ['completed'])
      await run.team.reply(task.id, 'thanks')
      await run.team.reply(task.id, 'checks ok? then mark it ready')
      await until(() => run.github.pulls[0]?.draft === false, 'the PR ready for review', run.logs)
      const seen = run.facts.at(-1)!
      assert.equal(seen.pull_request?.draft, true)
      assert.deepEqual(seen.pull_request?.checks, [{ name: 'test', status: 'completed', conclusion: 'success' }])
      assert.ok('pr_ready' in seen.actions && !('pr_merge' in seen.actions), 'a draft PR can be marked ready, not merged')
      assert.ok(!seen.thread.some((entry) => /mark it ready/.test(entry.text)), 'the new message is not in the thread history')
      await until(async () => (await run.team.thread(task.id)).replies.some((reply) => /ready for review/.test(reply.text)), 'the reply', run.logs)
      const replies = (await run.team.thread(task.id)).replies.map((reply) => reply.text)
      assert.ok(replies.some((text) => text.startsWith('The checks pass, so the pull request goes to review.') && /#1 is ready for review/.test(text)))
      assert.equal(run.facts.length, 2, 'each message of a person reaches the model once, the orchestrator replies never')
      assert.equal(run.github.pulls[0]!.merged, false, 'an action that does not apply is not done')
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('work asked in the thread of a completed task reopens it; the next attempt continues the PR branch in the resumed session', async () => {
    const run = await setup('thread_followup', async (command, send, deliver) => {
      if (command.type !== 'start') return
      await send('heartbeat', { state: 'running', round: 1, last_command_seq: 1, elapsed_seconds: 1, token_exp: 9e9, pi_alive: true })
      await deliver(1, 0)
    }, 'limits: { attempts_per_task: 1 }', {
      assistant: () => ({ reply: 'The worker renames it.', actions: [], work: { text: 'Rename parse to parseValue.', mode: 'follow_up' } }),
    })
    const { task } = await run.team.tasks.create('work/app', 'Fix the parser')
    await run.orchestrator.start()
    try {
      await run.done(task.id, ['completed'])
      const head = run.github.branchHead(`claude/task-${task.id}`)
      await run.team.reply(task.id, 'please also rename parse to parseValue')
      await until(() => run.starts.length === 2, 'the follow-up attempt', run.logs)
      const second = run.starts[1]!
      assert.match(second.brief, /Follow-up requests from the task thread/)
      assert.match(second.brief, /- Rename parse to parseValue\./)
      assert.equal(second.branch, `claude/task-${task.id}`)
      assert.equal(second.repository.base_commit, head, 'the follow-up starts from the PR branch')
      assert.deepEqual(run.resumed, ['session_fake1'], 'the session of the first attempt is resumed')
      await run.done(task.id, ['completed'])
      assert.equal(run.state.pendingFollowups(task.id).length, 0)
      assert.equal(run.state.forTask(task.id).length, 2, 'the follow-up gives the task an attempt again')
      const replies = (await run.team.thread(task.id)).replies.map((reply) => reply.text)
      assert.ok(replies.some((text) => /The worker renames it\.\n\nThe task is open again/.test(text)))
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })

  test('a bundle whose digest differs from the result is never pushed', async () => {
    const run = await setup('tampered', async (command, send) => {
      if (command.type !== 'start') return
      const made = workerBundle(join(run.github.origin), join(directory, 'tampered'), `claude/task-${command.task}`, run.base, 1)
      for (const [index, data] of made.parts.entries()) await send('bundle_part', { round: 1, index, count: made.parts.length, data })
      await send('result', result(1, 0, `claude/task-${command.task}`, run.base, made.head, { ...made.bundle, sha256: '0'.repeat(64) }))
    }, 'limits: { attempts_per_task: 1 }')
    const { task } = await run.team.tasks.create('work/app', 'Tampered bundle')
    await run.orchestrator.start()
    try {
      await run.done(task.id, ['failed'])
      assert.equal(run.github.branchHead(`claude/task-${task.id}`), null)
      assert.equal(run.github.pulls.length, 0)
    } finally {
      await run.orchestrator.stop()
      run.state.close()
    }
  })
})
