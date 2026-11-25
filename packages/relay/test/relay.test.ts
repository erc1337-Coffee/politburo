import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createRelay, MessageStore, generateSigningKeys, loadVerificationKey, signToken, verifyToken, type Relay, type Role } from '../src/index.ts'

const keys = generateSigningKeys()
const otherKeys = generateSigningKeys()

describe('token', () => {
  const verificationKey = loadVerificationKey(keys.publicKeyPem)

  test('a signed token verifies with its claims', () => {
    const claims = verifyToken(verificationKey, signToken(keys.privateKeyPem, { channel: 'task-1-r1', role: 'worker', ttlSeconds: 60 }))
    assert.equal(claims?.channel, 'task-1-r1')
    assert.equal(claims?.role, 'worker')
  })

  test('a token from another key, a changed payload or an expired token is refused', () => {
    assert.equal(verifyToken(verificationKey, signToken(otherKeys.privateKeyPem, { channel: 'c', role: 'worker', ttlSeconds: 60 })), null)
    const [, signature] = signToken(keys.privateKeyPem, { channel: 'c', role: 'worker', ttlSeconds: 60 }).split('.')
    const forged = Buffer.from(JSON.stringify({ v: 1, channel: 'c', role: 'orchestrator', iat: 0, exp: 9e9 })).toString('base64url')
    assert.equal(verifyToken(verificationKey, `${forged}.${signature}`), null)
    const old = signToken(keys.privateKeyPem, { channel: 'c', role: 'worker', ttlSeconds: 60, now: Date.now() - 120_000 })
    assert.equal(verifyToken(verificationKey, old), null)
    assert.equal(verifyToken(verificationKey, 'not-a-token'), null)
  })
})

describe('relay', () => {
  let directory: string
  let store: MessageStore
  let relay: Relay
  let base: string

  const token = (role: Role, channel = 'task-7-r1'): string => signToken(keys.privateKeyPem, { channel, role, ttlSeconds: 600 })
  const post = (direction: string, role: Role | null, body: string, channel = 'task-7-r1'): Promise<Response> =>
    fetch(`${base}/channels/${channel}/${direction}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(role ? { authorization: `Bearer ${token(role, channel)}` } : {}) },
      body,
    })
  /** Opens an SSE stream and reads it as text until a needle appears. */
  const open = async (channel: string, direction: string, role: Role, lastEventId?: string) => {
    const controller = new AbortController()
    const response = await fetch(`${base}/channels/${channel}/${direction}`, {
      headers: { authorization: `Bearer ${token(role, channel)}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const sse = {
      response,
      text: '',
      async readUntil(needle: string): Promise<void> {
        while (!sse.text.includes(needle)) {
          const { value, done } = await reader.read()
          if (done) throw new Error(`stream ended before ${needle}`)
          sse.text += decoder.decode(value, { stream: true })
        }
      },
      close: () => controller.abort(),
    }
    return sse
  }

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'politburo-relay-test-'))
    store = new MessageStore(join(directory, 'relay.sqlite'))
    relay = createRelay({ verificationKey: keys.publicKeyPem, store, limits: { maxMessageBytes: 1024 } })
    await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`
  })

  after(async () => {
    await relay.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  test('unknown paths and methods are 404', async () => {
    assert.equal((await fetch(`${base}/other`)).status, 404)
    assert.equal((await post('sideways', 'orchestrator', '{}')).status, 404)
    const put = await fetch(`${base}/channels/task-7-r1/commands`, { method: 'PUT', headers: { authorization: `Bearer ${token('orchestrator')}` } })
    assert.equal(put.status, 404)
  })

  test('only the orchestrator sends commands and only a worker sends telemetry', async () => {
    assert.deepEqual(await (await post('commands', 'orchestrator', '{"type":"start"}')).json(), { seq: 1 })
    assert.deepEqual(await (await post('commands', 'orchestrator', '{"type":"instruct"}')).json(), { seq: 2 })
    assert.equal((await post('commands', 'worker', '{}')).status, 403)
    assert.equal((await post('telemetry', 'orchestrator', '{}')).status, 403)
    assert.equal((await post('telemetry', null, '{}')).status, 401)
  })

  test('a token for another channel is refused like a missing one', async () => {
    const response = await fetch(`${base}/channels/task-7-r1/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token('orchestrator', 'task-8-r1')}` },
      body: '{}',
    })
    assert.equal(response.status, 401)
  })

  test('bodies must be one JSON object within the size limit', async () => {
    assert.equal((await post('telemetry', 'worker', 'not json')).status, 400)
    assert.equal((await post('telemetry', 'worker', '[1]')).status, 400)
    assert.equal((await post('telemetry', 'worker', JSON.stringify({ text: 'x'.repeat(2000) }))).status, 413)
  })

  test('only the receiver opens a stream, after a valid Last-Event-ID', async () => {
    const wrongRole = await open('task-7-r1', 'commands', 'orchestrator')
    assert.equal(wrongRole.response.status, 403)
    const badId = await open('task-7-r1', 'commands', 'worker', 'abc')
    assert.equal(badId.response.status, 400)
  })

  test('SSE replays from the start, resumes after Last-Event-ID and delivers new messages live', async () => {
    const all = await open('task-7-r1', 'commands', 'worker')
    assert.equal(all.response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    await all.readUntil('id: 2\n')
    assert.ok(all.text.includes('id: 1\ndata: {"seq":1,'))
    assert.ok(all.text.includes('"body":{"type":"start"}'))
    all.close()

    const resumed = await open('task-7-r1', 'commands', 'worker', '1')
    await resumed.readUntil('id: 2\n')
    assert.ok(!resumed.text.includes('id: 1\n'))
    await post('commands', 'orchestrator', '{"type":"stop"}')
    await resumed.readUntil('id: 3\n')
    assert.ok(resumed.text.includes('"body":{"type":"stop"}'))
    resumed.close()
  })

  test('the orchestrator deletes a channel and ends its streams; a worker may not', async () => {
    const remove = (role: Role): Promise<Response> =>
      fetch(`${base}/channels/task-7-r1`, { method: 'DELETE', headers: { authorization: `Bearer ${token(role)}` } })
    const live = await open('task-7-r1', 'commands', 'worker')
    await live.readUntil('id: 3\n')
    assert.equal((await remove('worker')).status, 403)
    assert.equal((await remove('orchestrator')).status, 204)
    await assert.rejects(live.readUntil('never'), /stream ended/)
    await post('commands', 'orchestrator', '{"type":"after_delete"}')
    const fresh = await open('task-7-r1', 'commands', 'worker')
    await fresh.readUntil('id: 1\n')
    assert.ok(fresh.text.includes('"body":{"type":"after_delete"}'))
    assert.ok(!fresh.text.includes('"type":"start"'))
    fresh.close()
  })
})

describe('store', () => {
  test('expired messages are not read and are purged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'politburo-relay-store-'))
    const store = new MessageStore(join(directory, 'relay.sqlite'))
    try {
      store.append('c', 'commands', '{}', 1_000, 2_000)
      store.append('c', 'commands', '{}', 1_000, 9_000)
      assert.equal(store.read('c', 'commands', 0, 10, 5_000).length, 1)
      assert.equal(store.purgeExpired(5_000), 1)
      assert.equal(store.count('c', 'commands'), 1)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
