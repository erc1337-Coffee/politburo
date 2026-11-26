import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { open, seal, workerKeyPair } from '../src/sealed.ts'
import { parseCommand, parseTelemetry, envelope } from '../src/messages.ts'

describe('sealed worker environment', () => {
  test('opens only with the worker key and for the same channel', () => {
    const worker = workerKeyPair()
    const sealed = seal(worker.publicKey, { OPENROUTER_API_KEY: 'value' }, 'task-1-a1-aa')
    assert.deepEqual(open(worker.privateKey, sealed, 'task-1-a1-aa'), { OPENROUTER_API_KEY: 'value' })
    assert.throws(() => open(worker.privateKey, sealed, 'task-2-a1-aa'))
    assert.throws(() => open(workerKeyPair().privateKey, sealed, 'task-1-a1-aa'))
    const changed = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}${sealed.ciphertext.endsWith('AA') ? 'AB' : 'AA'}` }
    assert.throws(() => open(worker.privateKey, changed, 'task-1-a1-aa'))
    assert.ok(!JSON.stringify(sealed).includes('value'))
  })

  test('the messages carry the public key and the sealed data', () => {
    const worker = workerKeyPair()
    const heartbeat = envelope('heartbeat', 'unknown', 'task-1-a1-aa', {
      state: 'waiting_start', round: 0, last_command_seq: 0, elapsed_seconds: 0, token_exp: 1, pi_alive: false, public_key: worker.publicKey,
    })
    assert.ok(parseTelemetry(heartbeat).ok)
    const command = envelope('credentials', '1', 'task-1-a1-aa', seal(worker.publicKey, { A: 'b' }, 'task-1-a1-aa'))
    assert.ok(parseCommand(command).ok)
  })
})
