import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AttentionDraft, AttentionView, MessageView } from '../src/api/routes.ts'

const CHANNEL = 'fresh/work'
const COMMIT = 'a'.repeat(40)

function draft({ id, revision }: MessageView): AttentionDraft {
  return {
    kind: 'awaiting_approval', question: 'Ship it?', context: '',
    evidence: [{ message: id, revision }], revision, commit: COMMIT,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    options: [
      { id: 'go', label: 'Ship', consequence: 'Release the build', next: 'resume' },
      { id: 'stop', label: 'Stop', consequence: 'Keep the build', next: 'fail' },
    ],
  }
}

const CLI = join(import.meta.dirname, '../src/cli/bin.ts')

async function cliHome(cleanup: (close: () => Promise<void>) => void) {
  const home = await mkdtemp(join(tmpdir(), 'serve-attention-'))
  cleanup(() => rm(home, { recursive: true, force: true }))
  const options = { cwd: home, env: { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home } }
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { ...options, timeout: 12_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
      else reject(new Error('vb did not exit normally'))
    })
  })
  return { home, options, run }
}

async function cliServe(cleanup: (close: () => Promise<void>) => void, ...flags: string[]) {
  const { home, options, run } = await cliHome(cleanup)
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--no-inspect', '--dir', join(home, 'data'), ...flags], {
    ...options, stdio: ['ignore', 'pipe', 'ignore'], timeout: 35_000, killSignal: 'SIGKILL',
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.on('error', () => {})
  cleanup(async () => {
    child.kill('SIGTERM')
    await closed
  })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  const [, url, principal] = await vi.waitFor(() => {
    const line = /^serving a local board at (http:\/\/127\.0\.0\.1:\d+\/api\/board) as (local:user:[\w.-]+),/m.exec(stdout)
    if (!line) throw new Error('vb serve did not announce its URL and principal')
    return line
  }, { timeout: 12_000 })
  const cli = (...args: string[]) => run(...args, '--url', url!, '--json')
  return { home, url: url!, principal, cli }
}

it('enables task attention on vb serve and lets the identity it prints answer', async ({ onTestFinished }) => {
  const { home, url, principal, cli } = await cliServe(onTestFinished)
  const discovery = await fetch(url)
  const capabilities = await discovery.json()
  expect.soft(capabilities).toMatchObject({ task_attention: true })
  for (const key of ['politburo', 'agent_ops', 'agent_intents']) expect.soft(capabilities).not.toHaveProperty(key)

  const created = await cli('tasks', 'create', CHANNEL, 'Release the build')
  expect(created.code).toBe(0)
  const { task } = JSON.parse(created.stdout) as { task: MessageView }
  const file = join(home, 'attention.json')
  await writeFile(file, JSON.stringify(draft(task)))
  const asked = await cli('tasks', 'ask', task.id, '--file', file)
  expect(asked.code).toBe(0)
  const { attention } = JSON.parse(asked.stdout) as { attention: AttentionView }
  const answered = await cli('tasks', 'answer', task.id, attention.id, 'go', '--commit', COMMIT)
  expect(answered.code).toBe(0)
  expect(JSON.parse(answered.stdout)).toMatchObject({
    attention: { status: 'answered', receipt: { by: { principal }, option: 'go' } },
  })
}, 30_000)

it('refuses a --responder that is not a principal ID', async ({ onTestFinished }) => {
  const { run } = await cliHome(onTestFinished)
  const result = await run('serve', '--responder', 'ada', '--json')
  expect(result).toMatchObject({ code: 2, stdout: '' })
  expect(JSON.parse(result.stderr)).toMatchObject({ reason: 'invalid_responder' })
}, 15_000)

it('takes no --swarm or --agent-ops option', async ({ onTestFinished }) => {
  const { run } = await cliHome(onTestFinished)
  const help = await run('serve', '--help')
  expect(help.code).toBe(0)
  expect(help.stdout).not.toContain('--swarm')
  expect(help.stdout).not.toContain('--agent-ops')
}, 15_000)
