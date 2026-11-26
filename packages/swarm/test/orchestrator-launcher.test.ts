import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { cloudProvider, type CommandRunner } from '../src/orchestrator/launcher.ts'
import { workerEnvironment } from '../src/orchestrator/worker-credentials.ts'

describe('cloud launcher', () => {
  test('runs the launcher in a pseudo-terminal, trusts the directory only during the launch, reads the session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'launcher-'))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    const directory = join(root, 'launch')
    const trust = () => JSON.parse(readFileSync(join(root, '.claude.json'), 'utf8')).projects?.[directory]?.hasTrustDialogAccepted === true
    let call: { command: string; args: string[]; prompt: string | undefined; trusted: boolean; token: string | undefined } | null = null
    process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'model-only'
    const run: CommandRunner = async (command, args, options) => {
      call = { command, args, prompt: options.env?.WORKER_PROMPT, trusted: trust(), token: options.env?.CLAUDE_CODE_OAUTH_TOKEN }
      return { code: 0, output: '\x1b[1mCreated\x1b[0m https://claude.ai/code/session_01ABC\r\n' }
    }
    try {
      const { session } = await cloudProvider(['claude', '--cloud'], "it's the prompt", directory, run).send({ key: 'k', binding: {} as never })
      assert.equal(session, 'session_01ABC')
      assert.deepEqual(call, { command: 'script', args: ['-qec', `'claude' '--cloud' "$WORKER_PROMPT"`, '/dev/null'], prompt: "it's the prompt", trusted: true, token: undefined })
      assert.equal(trust(), false)
      assert.match(readFileSync(`${directory}.log`, 'utf8'), /^exit 0\nCreated https/)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the worker environment holds one variable per party provider, from the orchestrator environment', () => {
    const routes = [{ provider: 'anthropic' }, { provider: 'openrouter' }, { provider: 'openrouter' }, { provider: 'kimi' }]
    assert.deepEqual(workerEnvironment(routes, { CLAUDE_CODE_OAUTH_TOKEN: 'a', OPENROUTER_API_KEY: 'o' }), { ANTHROPIC_OAUTH_TOKEN: 'a', OPENROUTER_API_KEY: 'o' })
    assert.deepEqual(workerEnvironment(routes, { ANTHROPIC_API_KEY: 'k', KIMI_API_KEY: 'm' }), { ANTHROPIC_API_KEY: 'k', KIMI_API_KEY: 'm' })
    assert.deepEqual(workerEnvironment(routes, {}), {})
  })
})
