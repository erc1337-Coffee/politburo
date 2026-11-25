import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { parseConfig, repositoryAllowed } from '../src/orchestrator/config.ts'
import { parseSessionId } from '../src/orchestrator/launcher.ts'
import { fixedRulesPolicy, limitStep, type DecisionInput } from '../src/orchestrator/policy.ts'

const env = { RELAY_URL: 'https://relay.example.net' }
const parse = (text: string) => parseConfig(text, env)
const minimal = ''

describe('orchestrator config', () => {
  test('merges snake_case settings over the defaults', () => {
    const config = parse(`${minimal}repositories: { allow: [Owner/Repo] }\nlimits: { rounds_per_attempt: 4 }\n`)
    assert.equal(config.limits.roundsPerAttempt, 4)
    assert.equal(config.limits.attemptsPerTask, 2)
    assert.ok(repositoryAllowed(config, 'owner/repo'))
  })

  test('the deny list wins over the allow list', () => {
    const config = parse(`${minimal}repositories: { allow: [remiliacorporation/politburo] }\n`)
    assert.ok(!repositoryAllowed(config, 'remiliacorporation/politburo'))
  })

  test('refuses unknown settings, plain HTTP relays and bad values', () => {
    assert.throws(() => parse(`${minimal}limits: { round_per_attempt: 4 }\n`), /round_per_attempt|roundPerAttempt/)
    assert.throws(() => parseConfig('', { RELAY_URL: 'http://relay.example.net' }), /https/)
    assert.throws(() => parseConfig('', {}), /RELAY_URL/)
    assert.throws(() => parse('relay: { url: "https://relay.example.net" }\n'), /RELAY_URL/)
    assert.throws(() => parse(`${minimal}board: { lease_seconds: 5 }\n`), /lease_seconds/)
    assert.throws(() => parse(`${minimal}repositories: { allow: [nope] }\n`), /owner\/name/)
  })
})

describe('session ids', () => {
  test('are read from a claude.ai URL or a bare id', () => {
    assert.equal(parseSessionId('View: https://claude.ai/code/session_01ABC?from=cli'), 'session_01ABC')
    assert.equal(parseSessionId('Session ID: cse_9xyz'), 'cse_9xyz')
    assert.equal(parseSessionId('nothing here'), null)
  })
})

describe('next step', () => {
  const sha = 'a'.repeat(40)
  const input = (checkExit: number, round = 1, no = 1): DecisionInput => ({
    task: { id: '1', brief: 'b', channel: 'work' },
    attempt: { no, round, costUsd: 0, wallMs: 1000 },
    bundleReceived: true,
    result: {
      round, exit_reason: 'completed', pi_exit_code: 0, summary: 's', branch: 'claude/task-1', head_commit: sha, base_commit: sha,
      bundle: { sha256: 'c'.repeat(64), bytes: 10, parts: 1 }, diff_stat: { files: 1, insertions: 1, deletions: 0 },
      checks: [{ name: 'test', exit_code: checkExit, duration_seconds: 1, output_tail: 'tail' }], models: [], cost_usd: 0, duration_seconds: 1, truncated: [],
    },
  })
  const limits = { roundsPerAttempt: 3, attemptsPerTask: 2, attemptWallMs: 60_000, taskBudgetUsd: 1, taskCostUsd: 0 }

  test('passing checks publish; failing checks get another round', async () => {
    assert.equal((await fixedRulesPolicy.decide(input(0))).kind, 'publish')
    assert.equal((await fixedRulesPolicy.decide(input(1))).kind, 'instruct')
  })

  test('limits turn rounds into a retry, then a failure', async () => {
    assert.equal(limitStep(await fixedRulesPolicy.decide(input(1, 3)), input(1, 3), limits).kind, 'retry')
    assert.equal(limitStep(await fixedRulesPolicy.decide(input(1, 3, 2)), input(1, 3, 2), limits).kind, 'fail')
    assert.equal(limitStep({ kind: 'retry', reason: 'x' }, input(0), { ...limits, taskCostUsd: 2 }).kind, 'fail')
  })

  test('publish needs a complete bundle of the commits', () => {
    assert.equal(limitStep({ kind: 'publish' }, { ...input(0), bundleReceived: false }, limits).kind, 'retry')
  })
})
