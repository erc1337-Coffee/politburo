import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import { createRelay, generateSigningKeys, MessageStore, signToken, type Relay } from '../../relay/src/index.ts'
import { envelope, parseTelemetry, type StartData, type Telemetry } from '../../relay/src/messages.ts'
import { configuredPackages, type PiSetup } from '../src/setup.ts'
import { WorkerFiles } from '../src/state.ts'
import { tokenExpiry } from '../src/transport.ts'
import { EXIT, Worker } from '../src/worker.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim()

/** A fake `pi` that writes a file and then runs until it is killed. */
const SLOW_PI = `#!/usr/bin/env node
require('fs').writeFileSync('notes.txt', 'partial work\\n')
process.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolName: 'write', args: { path: 'notes.txt' } }) + '\\n')
setInterval(() => process.stdout.write(JSON.stringify({ type: 'message_update' }) + '\\n'), 500)
`

/** A stand-in for `pi --mode rpc` that records every command on its input and settles once it was steered. */
const RPC_PI = `#!/usr/bin/env node
const fs = require('fs')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const command = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    fs.appendFileSync('commands.log', command.type + ': ' + command.message + '\\n')
    if (command.type === 'prompt') emit({ type: 'tool_execution_start', toolName: 'write', args: { path: 'commands.log' } })
    if (command.type === 'steer') {
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'steered: ' + command.message }] } })
      emit({ type: 'agent_settled' })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1000)
`

describe('worker', () => {
  let directory: string
  let store: MessageStore
  let relay: Relay
  let relayUrl: string
  let checkout: string
  let base: string
  const keys = generateSigningKeys()

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'worker-test-'))
    store = new MessageStore(join(directory, 'relay.sqlite'))
    relay = createRelay({ verificationKey: keys.publicKeyPem, store })
    await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
    relayUrl = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
    checkout = join(directory, 'checkout')
    mkdirSync(checkout)
    git(checkout, 'init', '-q', '-b', 'main')
    writeFileSync(join(checkout, 'README.md'), 'base\n')
    git(checkout, 'add', '.')
    git(checkout, 'commit', '-q', '-m', 'base')
    base = git(checkout, 'rev-parse', 'HEAD')
    writeFileSync(join(directory, 'slow-pi'), SLOW_PI)
    chmodSync(join(directory, 'slow-pi'), 0o755)
    writeFileSync(join(directory, 'rpc-pi'), RPC_PI)
    chmodSync(join(directory, 'rpc-pi'), 0o755)
  })

  after(async () => {
    await relay.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const start = (channel: string): StartData => ({
    task_id: '7', attempt: 1, round: 1, title: 'Write notes', brief: 'Write notes.txt.', brief_sha256: 'a'.repeat(64),
    repository: { url: 'https://github.com/owner/repo', base_ref: 'main', base_commit: base }, branch: 'claude/task-7',
    limits: { max_seconds: 600, idle_seconds: 600, question_wait_seconds: 60 },
    model: { pi_model: 'fallback/codex-cursor', fallback_tiers: [] }, checks: [],
    telemetry: { heartbeat_seconds: 5, progress_mode: 'events' },
    credentials: false,
  })

  async function command(channel: string, type: string, data: unknown): Promise<void> {
    const token = signToken(keys.privateKeyPem, { channel, role: 'orchestrator', ttlSeconds: 300 })
    const response = await fetch(`${relayUrl}/channels/${channel}/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(envelope(type, '7', channel, data)),
    })
    assert.equal(response.status, 201)
  }

  function telemetry(channel: string): Telemetry[] {
    return store.read(channel, 'telemetry', 0, 1000, Date.now()).map((message) => {
      const parsed = parseTelemetry(typeof message.body === 'string' ? JSON.parse(message.body) : message.body)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.message
    })
  }

  function worker(channel: string, ttlSeconds = 600, contactTimeoutSeconds = 900, prepare?: () => Promise<PiSetup>) {
    const files = new WorkerFiles(channel, join(directory, 'home'))
    const token = signToken(keys.privateKeyPem, { channel, role: 'worker', ttlSeconds })
    const setup = prepare ? { prepare } : { extensions: [], piCommand: join(directory, 'slow-pi') }
    return new Worker({ relayUrl, channel, files, checkout, contactTimeoutSeconds, ...setup, log: () => {} }, token)
  }

  test('a steering message reaches the running Pi in the same session, and the round ends when Pi settles', async () => {
    const channel = 'worker-steer'
    const prepare = async (): Promise<PiSetup> => ({ piCommand: join(directory, 'rpc-pi'), extensions: [], installed: [] })
    const running = worker(channel, 600, 900, prepare).run()
    await command(channel, 'start', { ...start(channel), branch: 'claude/task-steer' })
    for (let i = 0; i < 100 && !phases(telemetry(channel)).some((phase) => phase.phase === 'work_started'); i++) await sleep(100)
    await sleep(300)
    await command(channel, 'instruct', { round: 1, text: 'use tabs', mode: 'steer' })
    for (let i = 0; i < 100 && !telemetry(channel).some((message) => message.type === 'result'); i++) await sleep(100)
    const messages = telemetry(channel)
    const received = phases(messages).find((phase) => phase.phase === 'instruction_received')
    assert.ok(received, 'no instruction_received phase')
    const result = messages.find((message) => message.type === 'result')
    if (!result || result.type !== 'result') throw new Error('no result')
    assert.equal(result.data.exit_reason, 'completed')
    assert.equal(result.data.summary, 'steered: use tabs')
    await command(channel, 'instruct', { round: 1, text: 'too late', mode: 'follow_up' })
    for (let i = 0; i < 50 && !phases(telemetry(channel)).some((phase) => phase.phase === 'instruction_dropped'); i++) await sleep(100)
    assert.ok(phases(telemetry(channel)).some((phase) => phase.phase === 'instruction_dropped'), 'a message after the round was not reported as dropped')
    await command(channel, 'stop', { reason: 'done', send_bundle: false })
    assert.equal(await running, EXIT.finished)
  })

  const phases = (messages: Telemetry[]) => messages.flatMap((message) => (message.type === 'phase' ? [message.data] : []))

  test('the worker acknowledges its start, its setup and the work of a round, and the round waits for the setup', async () => {
    const channel = 'worker-phases'
    let setupDone = false
    const prepare = async (): Promise<PiSetup> => {
      await sleep(1_000)
      setupDone = true
      return { piCommand: join(directory, 'slow-pi'), extensions: [], installed: [] }
    }
    const running = worker(channel, 600, 900, prepare).run()
    await command(channel, 'start', { ...start(channel), branch: 'claude/task-phases' })
    await sleep(300)
    assert.ok(!phases(telemetry(channel)).some((phase) => phase.phase === 'work_started'), 'a round started before the setup ended')
    assert.ok(telemetry(channel).some((message) => message.type === 'heartbeat' && message.data.state === 'setting_up'))
    for (let i = 0; i < 100 && !phases(telemetry(channel)).some((phase) => phase.phase === 'work_started'); i++) await sleep(100)
    assert.ok(setupDone)
    await sleep(500)
    await command(channel, 'stop', { reason: 'enough', send_bundle: true })
    assert.equal(await running, EXIT.finished)
    const messages = telemetry(channel)
    const seen = phases(messages)
    assert.deepEqual(seen.map((phase) => phase.phase), ['started', 'setup_started', 'setup_finished', 'work_started', 'work_finished'])
    assert.equal(seen[2]!.detail, 'nothing to install')
    assert.equal(typeof seen[2]!.duration_seconds, 'number')
    assert.equal(seen[3]!.round, 1)
    assert.equal(seen[4]!.detail, 'stopped')
    const finished = messages.findIndex((message) => message.type === 'phase' && message.data.phase === 'work_finished')
    assert.ok(finished < messages.findIndex((message) => message.type === 'result'))
  })

  test('a failed setup is acknowledged, no round runs, and the worker exits with a configuration error', async () => {
    const channel = 'worker-setup-failure'
    const running = worker(channel, 600, 900, async () => { throw new Error('npm cannot reach the registry') }).run()
    await command(channel, 'start', { ...start(channel), branch: 'claude/task-setup-failure' })
    assert.equal(await running, EXIT.configuration)
    const messages = telemetry(channel)
    const seen = phases(messages)
    assert.deepEqual(seen.map((phase) => phase.phase), ['started', 'setup_started', 'setup_failed'])
    assert.match(seen[2]!.detail ?? '', /npm cannot reach the registry/)
    assert.ok(!messages.some((message) => message.type === 'result'))
  })

  test('the configured Pi packages are read from the settings file, as text or as objects with a source', () => {
    const file = join(directory, 'pi-settings.json')
    writeFileSync(file, JSON.stringify({ packages: ['npm:@pi-plugins/claude-cli@0.3.0', { source: 'npm:@ifi/pi-provider-cursor@0.5.1' }, 7] }))
    assert.deepEqual(configuredPackages(file), ['npm:@pi-plugins/claude-cli@0.3.0', 'npm:@ifi/pi-provider-cursor@0.5.1'])
    assert.deepEqual(configuredPackages(join(directory, 'missing.json')), [])
  })

  test('a stop command during a round commits the partial work, sends the bundle and the result, and exits 0', async () => {
    const channel = 'worker-stop'
    const running = worker(channel).run()
    await command(channel, 'start', start(channel))
    for (let i = 0; i < 100 && !telemetry(channel).some((message) => message.type === 'progress'); i++) await sleep(100)
    await sleep(500)
    await command(channel, 'stop', { reason: 'enough', send_bundle: true })
    assert.equal(await running, EXIT.finished)
    const messages = telemetry(channel)
    const result = messages.find((message) => message.type === 'result')
    if (!result || result.type !== 'result') throw new Error('no result')
    assert.equal(result.data.exit_reason, 'stopped')
    assert.equal(result.data.diff_stat.files, 1)
    const parts = messages.filter((message) => message.type === 'bundle_part')
    assert.equal(parts.length, result.data.bundle?.parts)
    assert.ok(messages.some((message) => message.type === 'heartbeat' && message.data.state === 'finished'))
    assert.ok(messages.findIndex((message) => message.type === 'bundle_part') < messages.findIndex((message) => message.type === 'result'))
  })

  test('a renew command replaces the token and the stream continues', async () => {
    const channel = 'worker-renew'
    const instance = worker(channel, 200)
    const running = instance.run()
    const renewed = signToken(keys.privateKeyPem, { channel, role: 'worker', ttlSeconds: 900 })
    await command(channel, 'renew', { token: renewed, exp: tokenExpiry(renewed) })
    await sleep(500)
    await command(channel, 'stop', { reason: 'done', send_bundle: false })
    assert.equal(await running, EXIT.finished)
    const files = new WorkerFiles(channel, join(directory, 'home'))
    assert.equal(files.readToken(), renewed)
    assert.equal(files.readCursor().lastSeq, 2)
  })

  test('a token close to expiry without renewal stops the worker with lost contact', async () => {
    const channel = 'worker-expiry'
    const started = Date.now()
    assert.equal(await worker(channel, 125).run(), EXIT.lostContact)
    assert.ok(Date.now() - started < 20_000)
  })
})
