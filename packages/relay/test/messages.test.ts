import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { envelope, parseCommand, parseTelemetry, type ResultData, type StartData } from '../src/messages.ts'

const sha1 = 'a'.repeat(40)
const start: StartData = {
  task_id: '12', attempt: 1, round: 1, title: 'Fix the parser', brief: 'Fix it.', brief_sha256: 'b'.repeat(64),
  repository: { url: 'https://github.com/owner/name', base_ref: 'main', base_commit: sha1 },
  branch: 'claude/task-12',
  limits: { max_seconds: 2400, idle_seconds: 180, question_wait_seconds: 1800 },
  model: { pi_model: 'fallback/codex-cursor', fallback_tiers: [] },
  checks: [{ name: 'test', command: 'pnpm test', timeout_seconds: 600 }],
  telemetry: { heartbeat_seconds: 60, progress_mode: 'summary' },
}
const result: ResultData = {
  round: 1, exit_reason: 'completed', pi_exit_code: 0, summary: 'done', branch: 'claude/task-12', head_commit: sha1,
  base_commit: sha1, pushed: true, push_error: null, diff_stat: { files: 1, insertions: 2, deletions: 0 },
  checks: [{ name: 'test', exit_code: 0, duration_seconds: 3.5, output_tail: 'ok' }],
  models: [{ provider: 'openrouter', model: 'm', input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }],
  cost_usd: 0.01, duration_seconds: 60, truncated: [],
}

describe('messages', () => {
  test('valid commands and telemetry parse', () => {
    assert.ok(parseCommand(envelope('start', '12', 'task-12-a1', start)).ok)
    assert.ok(parseCommand(envelope('stop', '12', 'task-12-a1', { reason: 'pause', push: true })).ok)
    assert.ok(parseTelemetry(envelope('result', '12', 'task-12-a1', result)).ok)
    assert.ok(parseTelemetry(envelope('question', '12', 'task-12-a1', { question_id: 'q1', round: 1, text: 'Which?' })).ok)
  })

  test('a telemetry type is not a command and the reverse', () => {
    assert.equal(parseCommand(envelope('result', '12', 'c', result)).ok, false)
    assert.equal(parseTelemetry(envelope('start', '12', 'c', start)).ok, false)
  })

  test('unknown fields, wrong types, bad formats and long texts are refused', () => {
    const extra = parseCommand(envelope('stop', '12', 'c', { reason: 'x', push: true, force: true }))
    assert.deepEqual(extra, { ok: false, error: 'message.data.force: unknown field' })
    assert.equal(parseCommand(envelope('start', '12', 'c', { ...start, branch: 'main' })).ok, false)
    assert.equal(parseTelemetry(envelope('result', '12', 'c', { ...result, head_commit: 'xyz' })).ok, false)
    assert.equal(parseTelemetry(envelope('result', '12', 'c', { ...result, summary: 'x'.repeat(9_000) })).ok, false)
    assert.equal(parseCommand({ ...envelope('stop', '12', 'c', { reason: 'x', push: true }), v: 2 }).ok, false)
    assert.equal(parseCommand('stop').ok, false)
  })
})
