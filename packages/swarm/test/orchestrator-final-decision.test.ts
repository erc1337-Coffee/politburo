import { strict as assert } from 'node:assert'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { claudeRunner, FinalDecider, KevClient, type ClaudeRunner, type FinishedRound } from '../src/orchestrator/final-decision.ts'

const round = (change: Partial<FinishedRound['result']> = {}, extra: Partial<FinishedRound> = {}): FinishedRound => ({
  task: { id: '7', channel: 'work/app', brief: 'Make parse return 3' },
  depth: 0,
  roundsLeft: 2,
  result: { exitReason: 'completed', summary: 'parse returns 3', changes: { files: 1, insertions: 1, deletions: 1 }, checks: [{ name: 'test', passed: true, outputTail: '' }], ...change },
  ...extra,
})

/** A Kev server that answers `label` at `confidence`, and keeps the requests. */
function fakeKev(label: string, confidence: number, status = 200) {
  const requests: Array<{ url: string; body: { state: Record<string, unknown>; questions: { next: { criteria: Record<string, string> } } } }> = []
  const fetchKev = (async (url: URL, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ model: 'kev-latest', answers: { next: { type: 'choice', choice: label, confidence, probabilities: { [label]: confidence } } } }), { status })
  }) as unknown as typeof fetch
  return { kev: new KevClient({ url: 'http://kev.test:8009', timeoutMs: 1_000, fetch: fetchKev }), requests }
}

/** A Claude runner that answers `answer`, and keeps what it was asked. */
function fakeClaude(answer: (allowed: string[]) => unknown) {
  const calls: Array<{ prompt: Record<string, unknown>; allowed: string[] }> = []
  const run: ClaudeRunner = async ({ prompt, schema }) => {
    const allowed = (schema as { properties: { label: { enum: string[] } } }).properties.label.enum
    calls.push({ prompt: JSON.parse(prompt), allowed })
    return answer(allowed)
  }
  return { run, calls }
}

const failing: ClaudeRunner = async () => { throw new Error('down') }

describe('the final decision', () => {
  test('a sure PASS from Kev is final; Claude is not asked', async () => {
    const kev = fakeKev('PASS', 0.9)
    const claude = fakeClaude(() => ({ label: 'REVIEW', reason: 'x' }))
    const decision = await new FinalDecider({ kev: kev.kev, claude: claude.run, kevConfidence: 0.75, followupDepth: 3 }).decide(round())
    assert.deepEqual([decision.label, decision.decidedBy, decision.kev?.confidence], ['PASS', 'kev', 0.9])
    assert.equal(claude.calls.length, 0)
    assert.equal(kev.requests[0]!.url, 'http://kev.test:8009/v1/systemone')
    assert.deepEqual(Object.keys(kev.requests[0]!.body.questions.next.criteria), ['PASS', 'FOLLOWUP', 'RETRY', 'REVIEW'])
    assert.equal(kev.requests[0]!.body.state.worker_summary, 'parse returns 3')
  })

  test('an unsure Kev, or a FOLLOWUP, goes to Claude with Kev as the first opinion', async () => {
    for (const [label, confidence] of [['PASS', 0.5], ['FOLLOWUP', 0.95]] as const) {
      const claude = fakeClaude(() => ({ label: 'FOLLOWUP', reason: 'Docs are missing.', followups: [{ title: 'Document parse', brief: 'Write the parse docs.' }] }))
      const decision = await new FinalDecider({ kev: fakeKev(label, confidence).kev, claude: claude.run, kevConfidence: 0.75, followupDepth: 3 }).decide(round())
      assert.deepEqual([decision.label, decision.decidedBy], ['FOLLOWUP', 'claude'])
      assert.deepEqual(decision.followups, [{ title: 'Document parse', brief: 'Write the parse docs.' }])
      assert.deepEqual(claude.calls[0]!.prompt.first_opinion, { label, confidence })
    }
  })

  test('the follow-up depth and the round limit narrow the choices', async () => {
    const kev = fakeKev('PASS', 0.5)
    const claude = fakeClaude(() => ({ label: 'PASS', reason: 'Done.' }))
    await new FinalDecider({ kev: kev.kev, claude: claude.run, kevConfidence: 0.75, followupDepth: 2 }).decide(round({}, { depth: 2, roundsLeft: 0 }))
    assert.deepEqual(Object.keys(kev.requests[0]!.body.questions.next.criteria), ['PASS', 'REVIEW'])
    assert.deepEqual(claude.calls[0]!.allowed, ['PASS', 'REVIEW'])
  })

  test('failing checks: Claude chooses between a correction and the owner; without Claude the rules send the check output', async () => {
    const checks = [{ name: 'test', passed: false, outputTail: 'expected 3, got 2' }]
    const claude = fakeClaude(() => ({ label: 'RETRY', reason: 'A fixable test failure.', correction: 'Return 3 from parse.' }))
    const decided = await new FinalDecider({ kev: fakeKev('PASS', 0.99).kev, claude: claude.run, kevConfidence: 0.75, followupDepth: 3 }).decide(round({ checks }))
    assert.deepEqual([decided.label, decided.decidedBy, decided.correction], ['RETRY', 'claude', 'Return 3 from parse.'])
    assert.deepEqual(claude.calls[0]!.allowed, ['RETRY', 'REVIEW'])
    const rules = await new FinalDecider({ kev: null, claude: failing, kevConfidence: 0.75, followupDepth: 3 }).decide(round({ checks }))
    assert.deepEqual([rules.label, rules.decidedBy], ['RETRY', 'rules'])
    assert.match(rules.correction!, /expected 3, got 2/)
    const last = await new FinalDecider({ kev: null, claude: claude.run, kevConfidence: 0.75, followupDepth: 3 }).decide(round({ checks }, { roundsLeft: 0 }))
    assert.deepEqual([last.label, last.decidedBy], ['REVIEW', 'rules'])
  })

  test('without an answer from a model the owner reviews; without any model the rules pass the task', async () => {
    const down = await new FinalDecider({ kev: fakeKev('PASS', 0.9, 500).kev, claude: failing, kevConfidence: 0.75, followupDepth: 3 }).decide(round())
    assert.deepEqual([down.label, down.decidedBy], ['REVIEW', 'rules'])
    const invalid = await new FinalDecider({ kev: null, claude: fakeClaude(() => ({ label: 'RETRY', reason: 'no correction' })).run, kevConfidence: 0.75, followupDepth: 3 }).decide(round())
    assert.deepEqual([invalid.label, invalid.decidedBy], ['REVIEW', 'rules'])
    const none = new FinalDecider({ kev: null, claude: null, kevConfidence: 0.75, followupDepth: 3 })
    assert.equal(none.active, false)
    assert.deepEqual([(await none.decide(round())).label], ['PASS'])
  })
})

describe('the Claude runner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-claude-runner-'))
  after(() => rmSync(directory, { recursive: true, force: true }))

  test('runs claude without tools or keys and answers its structured output', async () => {
    const command = join(directory, 'claude')
    writeFileSync(command, `#!/usr/bin/env node
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const args = process.argv.slice(2)
  const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].filter((name) => process.env[name])
  process.stdout.write(JSON.stringify({ is_error: false, structured_output: { args, keys, input, cwd: process.cwd() } }))
})
`)
    chmodSync(command, 0o755)
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'setup-token'
    try {
      const run = claudeRunner({ model: 'claude-sonnet-5-5', directory: join(directory, 'decision'), timeoutMs: 10_000, command })
      const out = await run({ system: 'system', prompt: '{"facts":1}', schema: { type: 'object' } }) as { args: string[]; keys: string[]; input: string; cwd: string }
      assert.deepEqual(out.keys, [], 'no key reaches claude: the stored sign-in pays')
      assert.equal(out.input, '{"facts":1}')
      assert.ok(out.cwd.endsWith('decision'))
      for (const flag of ['--print', '--no-session-persistence', '--json-schema']) assert.ok(out.args.includes(flag), flag)
      assert.equal(out.args[out.args.indexOf('--tools') + 1], '')
      assert.equal(out.args[out.args.indexOf('--model') + 1], 'claude-sonnet-5-5')
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
  })
})
