import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Load SQLite before capturing CLI stderr, so Node's one-time warning isn't CLI output.
import 'node:sqlite'
import { build } from 'tsdown'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, type Failure } from '../src/cli/embedded.ts'
import { main } from '../src/cli/main.ts'
import { local } from '../src/cli/local.ts'
import { env, url, useBoard } from './cli-harness.ts'

/** What `run` printed, and the exit code it answered. */
async function capture(run: () => Promise<number>) {
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true))
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((stderr += String(chunk)), true))
  try {
    return { code: await run(), stdout, stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

/**
 * This process's environment as a fresh machine's, for the CLI: no board, agent, Vercel, or Actions
 * variables, as the subprocess tests clear them, and an empty home, so no cached token answers.
 */
async function isolated(): Promise<string> {
  for (const key of Object.keys(process.env)) if (/^(CLAUDE|CODEX|GROK|PI_|AI_AGENT|BOARD|VERCEL|ACTIONS_ID_TOKEN)/.test(key)) vi.stubEnv(key, undefined)
  const home = await mkdtemp(join(tmpdir(), 'board-home-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('XDG_CONFIG_HOME', home)
  return home
}

/** Markers only the inspector, `serve`, and A2's stores have. */
const MARKERS = { inspector: 'x-inspect-token', serve: 'serving a local board', a2: 'board-tables' }

/**
 * `entry`, bundled as the Vercel CLI bundles what it imports: for Node, every dependency inlined, in
 * a directory of its own, away from board's `dist`. Its files by name; `app.mjs` is the entry.
 */
async function bundleTo(entry: string, dir: string): Promise<Map<string, string>> {
  const file = join(import.meta.dirname, `.cli-entry-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
  await writeFile(file, entry)
  try {
    await build({ config: false, entry: { app: file }, outDir: dir, platform: 'node', format: 'esm', dts: false, clean: false, logLevel: 'silent', deps: { alwaysBundle: [/.*/], onlyBundle: false } })
    const names = (await readdir(dir, { recursive: true })).filter((name) => /\.m?js$/.test(name))
    return new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), 'utf8')] as const)))
  } finally {
    await rm(file, { force: true })
  }
}

async function bundled(entry: string): Promise<Map<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'board-cli-'))
  try {
    return await bundleTo(entry, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const everything = (files: Map<string, string>) => [...files.values()].join('\n')

describe('the embedded CLI', () => {
  useBoard()

  beforeAll(async () => {
    // The board's first authenticated request warns about its inferred URL. Let it do so
    // before capturing the CLI's stderr in this same process.
    const response = await fetch(`${url}/me`, { headers: { authorization: `Bearer ${env.BOARD_TOKEN}` } })
    expect(response.status).toBe(200)
    await response.text()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('names the app that runs it in help, usage, and errors, and has neither inspect nor serve', async () => {
    const app = createApp({ appName: 'vercel board' })
    const help = await capture(() => app.run(['help']))
    expect(help.code).toBe(0)
    expect(help.stdout).toMatch(/^vercel board \d+\.\d+\.\d+\S*: your Vercel team's message board, for people and agents\n\nusage: vercel board <command> \[options\]\n/)
    expect(help.stdout).not.toMatch(/also installed as|^\s+(serve|inspect) /m)
    for (const command of ['inspect', 'serve'])
      expect(await capture(() => app.run([command]))).toEqual({ code: 2, stdout: '', stderr: `error: Unknown command ${command} for vercel board.\n\n  See all commands:\n    vercel board --help\n` })
    const extra = await capture(() => app.run(['conformance', 'extra']))
    expect(extra).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: conformance takes no arguments/) })
    expect(extra.stderr).toContain('    vercel board conformance --help\n')
    expect(await capture(() => app.run(['--nope']))).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Unknown option --nope for vercel board\.\n[\s\S]*    vercel board --help\n$/) })
  })

  it('hands failures to the app that runs it, to show as its own', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    const failures: [unknown, { json: boolean }][] = []
    const app = createApp({ appName: 'vercel board', onError: (failure, mode) => void failures.push([failure, mode]) })
    expect(await capture(() => app.run(['read', '99999']))).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(await capture(() => app.run(['read', '99999', '--json']))).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(failures).toEqual([
      [expect.objectContaining({ class: 'not_found', reason: 'message_not_found', message: "Couldn't find message #99999." }), { json: false }],
      [expect.objectContaining({ reason: 'message_not_found' }), { json: true }],
    ])
    // Misuse, with how to recover as a command it can run.
    expect(await capture(() => app.run(['raed', 'dev']))).toMatchObject({ code: 2, stderr: '' })
    expect(failures.at(-1)![0]).toMatchObject({ class: 'usage', reason: 'unknown_command', next: [{ argv: ['vercel', 'board', '--help'] }] })
  })

  it("has tasks, names the app in a task's ways out, and keeps a claim between its runs", async () => {
    const home = await isolated()
    vi.stubEnv('BOARD_URL', url)
    vi.stubEnv('BOARD_TOKEN', env.BOARD_TOKEN)
    const app = createApp({ appName: 'vercel board' })
    expect((await capture(() => app.run(['help']))).stdout).toMatch(/^ {2}tasks \[channel\] +open tasks, oldest first/m)
    expect((await capture(() => app.run(['tasks', 'claim', '--help']))).stdout).toContain('\n    vercel board tasks claim 812\n')

    const made = await capture(() => app.run(['tasks', 'create', 'embedded', 'fix CVE-123 in acme/web']))
    expect(made).toMatchObject({ code: 0, stderr: '' })
    const id = made.stdout.trim()
    // What to run next is the app's command, not vb's.
    expect(await capture(() => app.run(['tasks', 'complete', id, 'done']))).toEqual({ code: 1, stdout: '', stderr: `error: You hold no claim on task #${id} as yourself.\n\n  Claim it:\n    vercel board tasks claim ${id}\n` })
    const reserved = await capture(() => app.run(['label', id, 'board.task=claimed']))
    expect(reserved).toMatchObject({ code: 2, stdout: '' })
    expect(reserved.stderr).toMatch(new RegExp(`^error: Can't label #${id}\\. Labels under board\\. are the board's own\\.\\n  [^\\n]+\\n\\n  Claim it:\\n    vercel board tasks claim ${id}\\n$`))

    // One run claims and the next settles: the claim is kept where the app's CLI keeps its state.
    expect(await capture(() => app.run(['tasks', 'claim', id]))).toEqual({ code: 0, stdout: `#${id}  yours for 15m  fix CVE-123 in acme/web\n`, stderr: '' })
    expect((await readdir(join(home, 'board', 'claims'))).filter((name) => name.endsWith('.json'))).toHaveLength(1)
    expect(await capture(() => app.run(['tasks', 'complete', id, 'fixed in a1b2c3']))).toEqual({ code: 0, stdout: `completed ${id}\n`, stderr: '' })
    expect(await readdir(join(home, 'board', 'claims'))).toEqual([])
    expect(await capture(() => app.run(['tasks', 'embedded', '--state', 'all']))).toEqual({ code: 0, stdout: `#${id}  completed  fix CVE-123 in acme/web         fixed in a1b2c3\n`, stderr: '' })

    // What a task waits for is set there too, and a command cut short names the app's help.
    const next = (await capture(() => app.run(['tasks', 'create', 'embedded/next', 'review the fix']))).stdout.trim()
    const first = (await capture(() => app.run(['tasks', 'create', 'embedded/next', 'tag the release']))).stdout.trim()
    expect(await capture(() => app.run(['tasks', 'needs', next, first]))).toEqual({ code: 0, stdout: `${next} needs #${first}\n`, stderr: '' })
    expect(await capture(() => app.run(['tasks', 'needs', next]))).toEqual({ code: 2, stdout: '', stderr: 'error: Missing the tasks it waits for now, by ID, or --none for nothing.\n\n  See how to use it:\n    vercel board tasks --help\n' })
    expect(await capture(() => app.run(['tasks', 'needs', next, '--none']))).toEqual({ code: 0, stdout: `${next} needs nothing\n`, stderr: '' })
    expect(await capture(() => app.run(['tasks', 'embedded/next']))).toEqual({ code: 0, stdout: `#${next}  ready      review the fix\n#${first}  ready      tag the release\n`, stderr: '' })

    // A plan from a file, in as many writes as it takes: one that stops midway names the app's command to finish it.
    const steps = Array.from({ length: 101 }, (_, n) => ({ text: `step ${n}`, ...(n === 100 ? { needs: ['999999'] } : {}) }))
    const plan = join(home, 'plan.json')
    await writeFile(plan, JSON.stringify(steps))
    const stopped = await capture(() => app.run(['tasks', 'create', 'embedded-plan', '--file', plan]))
    expect(stopped).toMatchObject({ code: 2, stdout: '' })
    expect(stopped.stderr).toMatch(new RegExp(`\\n  made 100 of 101: #\\d+ to #\\d+\\n\\n  Make the rest, under the same key: what was made stays as it is:\\n    vercel board tasks create embedded-plan --file ${plan} --idempotency-key [0-9a-f-]{36}\\n$`))
  }, 30_000)

  it('points the words people type for search, claim, and mentions at the commands that do them', async () => {
    const home = await isolated()
    const run = async (...args: string[]) => JSON.parse((await capture(() => main([...args, '--json'], { name: 'board', commands: local }))).stderr).next
    try {
      expect(await run('search', 'ENOTFOUND')).toMatchObject([{ argv: ['vb', 'read', '<CHANNEL>', '--text', '<PHRASE>'] }, { argv: ['vb', '--help'] }])
      expect(await run('mentions')).toMatchObject([{ argv: ['vb', 'read', '--mentions'] }, { argv: ['vb', '--help'] }])
      expect(await run('grep', 'ENOTFOUND', '--url', 'http://localhost:4000')).toMatchObject([{ argv: ['vb', 'read', '<CHANNEL>', '--text', '<PHRASE>'] }, { argv: ['vb', '--help'] }])
      expect(await run('claim', '812')).toMatchObject([{ argv: ['vb', 'tasks', 'claim', '<ID>'] }, { argv: ['vb', '--help'] }])
      expect(await run('assign', '812', '--url', 'http://localhost:4000')).toMatchObject([{ argv: ['vb', 'tasks', 'assign', '<ID>', '<PROFILE>'] }, { argv: ['vb', '--help'] }])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('checks only a board someone named, since it posts and changes grants', async () => {
    const home = await isolated()
    const fetching = vi.spyOn(globalThis, 'fetch')
    const run = (...args: string[]) => capture(() => main(args, { name: 'board', commands: local }))
    const cwd = process.cwd()
    process.chdir(home)
    try {
      const refused = await run('conformance')
      expect(refused).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: conformance posts and changes grants, so name a scratch board for it\.\n/) })
      expect(refused.stderr).toContain('    vb conformance --url <URL>\n')
      expect(fetching).not.toHaveBeenCalled()
    } finally {
      fetching.mockRestore()
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('says how to point it at a board when nothing names one', async () => {
    const home = await isolated()
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await capture(() => main(['read', 'dev'], { name: 'board', commands: local }))).toMatchObject({
        code: 2,
        stderr: expect.stringMatching(/^error: No board to use\. [\s\S]*\n    vb read dev --url <URL>\n/),
      })
    } finally {
      process.chdir(cwd)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('lists inspect and serve in the standalone board only, in a section of their own after wait', async () => {
    const help = await capture(() => main(['help'], { name: 'board', commands: local }))
    expect(help.stdout).toMatch(/^usage: board <command> \[options\]      \(also installed as `vb`\)$/m)
    // inspect and serve after wait, in a section of their own, and then the options every command takes.
    expect(help.stdout).toMatch(/\n  wait \[channel\|id\] \[filters\] \[--after id\] \[--timeout 10m\][^\n]*\n(?: {4,}[^\n]*\n)*\n  inspect +the board in your browser[^\n]*\n(?: {4,}[^\n]*\n)*  serve +run a board on this machine[\s\S]*local:user:<your OS\s+user>\n\nfilters:/)
  })

  it('leaves no Ctrl-C handler behind once wait or tail is done, since the process it runs in goes on', async () => {
    await isolated()
    vi.stubEnv('BOARD_URL', url)
    vi.stubEnv('BOARD_TOKEN', env.BOARD_TOKEN)
    const before = process.listenerCount('SIGINT')
    const app = createApp({ appName: 'vercel board' })
    expect((await capture(() => app.run(['wait', 'quiet', '--timeout', '1s']))).code).toBe(1)
    // No board answers there, so tail fails before it reads anything.
    vi.stubEnv('BOARD_URL', url.replace(/\/api\/board$/, '/nowhere'))
    expect((await capture(() => app.run(['tail', 'quiet']))).code).toBe(1)
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('never brings the inspector, serve, or A2 into an app that bundles it', async () => {
    const embedded = await bundled("import { createApp } from '../src/cli/embedded.ts'\nawait createApp({ appName: 'vercel board' }).run(process.argv.slice(2))")
    expect(everything(embedded).includes(MARKERS.serve), 'serve in the embedded CLI').toBe(false)
    expect(everything(embedded).includes(MARKERS.a2), 'A2 in the embedded CLI').toBe(false)
    expect(everything(embedded).includes(MARKERS.inspector), 'the inspector in the embedded CLI').toBe(false)
    // The standalone CLI has all three, so the markers find what they look for.
    const standalone = everything(await bundled("import '../src/cli/bin.ts'"))
    for (const [what, marker] of Object.entries(MARKERS)) expect(standalone.includes(marker), `${what} in the standalone CLI`).toBe(true)
  }, 120_000)

  /** `inspect` as a subprocess, until it says where it serves; `stop` is Ctrl-C, answering the exit code. */
  async function inspecting(argv: string[], extra: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, [...argv, 'inspect', '--port', '0', '--no-open'], { env: { ...env, ...extra } })
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const address = await new Promise<string | null>((resolve) => {
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        const found = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)
        if (found) resolve(found[1]!)
      })
      child.on('close', () => resolve(null))
    })
    return {
      address,
      stdout: () => stdout,
      stderr: () => stderr,
      exited,
      stop: () => (child.kill('SIGINT'), exited),
    }
  }

  it("serves the page it's installed with, standalone", async () => {
    const served = await inspecting([join(import.meta.dirname, '../dist/cli.mjs')])
    expect(await (await fetch(`${served.address}/app.js`)).text()).toBe(await readFile(join(import.meta.dirname, '../dist/inspect/app.js'), 'utf8'))
    expect(await served.stop()).toBe(0)
  }, 30_000)
})
