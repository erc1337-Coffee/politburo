#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, fstatSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Only script-authored text can reach stderr. Child logs can include credentials
// in arbitrary formats, so never replay them, even on failure.
class MetricError extends Error {}
function requireThat(ok, reason) {
  if (!ok) throw new MetricError(reason)
}

function options(argv) {
  const opts = { repo: fileURLToPath(new URL('../..', import.meta.url)), head: 'HEAD', timeout: '1200' }
  const seen = new Set()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    requireThat(['--repo', '--head', '--timeout'].includes(flag), 'unknown argument')
    requireThat(!seen.has(flag), `duplicate ${flag}`)
    requireThat(value && !value.startsWith('--'), `missing value for ${flag}`)
    seen.add(flag)
    opts[flag.slice(2)] = value
  }
  requireThat(!opts.head.startsWith('-'), 'invalid --head ref')
  // Node timers use signed 32-bit milliseconds.
  requireThat(/^[1-9][0-9]*$/.test(opts.timeout) && Number(opts.timeout) <= 2147483,
    '--timeout must be a positive integer up to 2147483 seconds')
  return opts
}

function readTail(path, max = 64 * 1024) {
  const fd = openSync(path, 'r')
  try {
    const end = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(max, end))
    return buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, end - buf.length))
  } finally {
    closeSync(fd)
  }
}

function networkHint(log) {
  // Extract only known error markers and public hosts, not URLs or log lines.
  const tail = readTail(log).split(/\r?\n/).filter(Boolean).slice(-5).join('\n')
  const code = tail.match(/\b(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_PNPM_FETCH_[45][0-9]{2})\b/)?.[0]
  const hosts = ['registry.npmjs.org', 'registry.npmjs.com', 'github.com', 'codeload.github.com']
  const host = hosts.find((name) => tail.includes(`://${name}/`))
  return code ? ` (${code}${host ? ` at ${host}` : ''})` : ''
}

function freePort(signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const socket = createServer()
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    socket.once('error', () => {
      signal.removeEventListener('abort', abort)
      reject(new MetricError('could not reserve a loopback port'))
    })
    socket.once('close', () => signal.removeEventListener('abort', abort))
    socket.listen({ host: '127.0.0.1', port: 0, signal }, () => {
      const { port } = socket.address()
      socket.close((err) => err ? reject(new MetricError('could not release the loopback port')) : resolve(port))
    })
  })
}

const killGroup = (pid) => {
  if (!pid) return
  try { process.kill(-pid, 'SIGKILL') } catch (err) { if (err.code !== 'ESRCH') throw err }
}

async function measure({ repo, head: headRef, timeout }) {
  process.umask(0o077)
  const tmp = mkdtempSync(join(tmpdir(), 'first-claim-'))
  const checkout = join(tmp, 'repo')
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(?:BOARD_|VERCEL|GIT_|XDG_|NPM_CONFIG_|PNPM_|COREPACK_)/i.test(key) ||
        ['NODE_OPTIONS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'ENV', 'BASH_ENV', 'CDPATH'].includes(key)) delete env[key]
  }
  // Preserve ambient proxy and CA variables, including npm's proxy / CA knobs.
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_config_(?:proxy|https_proxy|noproxy|ca|cafile|strict_ssl)$/i.test(key)) env[key] = value
  }
  Object.assign(env, {
    HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'config'), XDG_CACHE_HOME: join(tmp, 'cache'),
    XDG_DATA_HOME: join(tmp, 'share'), XDG_STATE_HOME: join(tmp, 'state'), TMPDIR: tmp,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', CI: 'true',
  })

  const phases = {}
  const groups = new Set()
  const controller = new AbortController()
  const { signal } = controller
  const interrupt = () => controller.abort(new MetricError('interrupted'))
  const start = performance.now()
  const deadline = start + Number(timeout) * 1000
  const overall = setTimeout(() => controller.abort(new MetricError('overall timeout exceeded')), deadline - start)
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, interrupt)
  let commands = 0
  let cleaningUp = false

  function checkDeadline() {
    signal.throwIfAborted()
    requireThat(performance.now() < deadline, 'overall timeout exceeded')
  }

  function launch(label, command, args, { cwd = checkout, capture = false, limit = Infinity, serving = false } = {}) {
    checkDeadline()
    commands++
    const log = join(tmp, `${commands}.log`)
    const output = capture ? join(tmp, `${commands}.stdout`) : log
    const logFd = openSync(log, 'a')
    let outFd = logFd
    let child
    try {
      if (capture) outFd = openSync(output, 'a')
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', outFd, logFd] })
    } finally {
      if (outFd !== logFd) closeSync(outFd)
      closeSync(logFd)
    }
    const pid = child.pid
    if (pid) groups.add(pid)
    // The deadline timers, not a child that failed to exit, keep Node alive.
    child.unref()
    let exited = false
    const done = new Promise((resolve, reject) => {
      const stop = (reason) => {
        killGroup(pid)
        reject(reason)
      }
      const abort = () => stop(signal.reason)
      const timer = setTimeout(() => stop(new MetricError(`${label} timed out`)),
        Math.max(1, Math.min(limit, deadline - performance.now()))).unref()
      const finish = () => {
        exited = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        // Kill remaining group members even if the command leader exited.
        killGroup(pid)
        groups.delete(pid)
      }
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', () => {
        finish()
        reject(new MetricError(`${label} could not start`))
      })
      child.once('exit', (code, receivedSignal) => {
        finish()
        if (cleaningUp || signal.aborted) return
        try {
          if (code === 0 && !serving) resolve(capture ? readTail(output) : undefined)
          else reject(new MetricError(`${label} ${serving ? 'stopped' : 'failed'} (${receivedSignal ?? `exit ${code}`})${networkHint(log)}`))
        } catch {
          reject(new MetricError(`${label} log could not be read`))
        }
      })
    })
    // serve is monitored for the entire run, including between readiness polls.
    if (serving) done.catch((err) => controller.abort(err))
    return { done, log, get exited() { return exited } }
  }

  const run = (...args) => launch(...args).done
  const git = (label, args, opts) => run(label, 'git', args, { limit: 120_000, ...opts })
  const cli = 'packages/board/dist/cli.mjs'
  async function vb(label, ...args) {
    const stdout = await run(label, process.execPath, [cli, ...args, '--json'], { capture: true, limit: 60_000 })
    try { return JSON.parse(stdout) } catch { throw new MetricError(`${label} did not return JSON`) }
  }
  async function phase(name, action) {
    const before = performance.now()
    const result = await action()
    checkDeadline()
    phases[name] = (performance.now() - before) / 1000
    return result
  }

  try {
    const head = await phase('clone', async () => {
      // Clone from the caller's cwd so relative --repo paths keep their meaning.
      await git('clone', ['clone', '--no-local', '--no-checkout', '--', repo, checkout], { cwd: process.cwd() })
      const resolve = async (ref) => (await git('resolve head',
        ['rev-parse', '--revs-only', '--end-of-options', `${ref}^{commit}`], { capture: true })).trim()
      let sha = await resolve(headRef)
      // A normal clone stores non-default branches as remote-tracking refs.
      if (!sha && !headRef.startsWith('refs/remotes/') && !headRef.startsWith('refs/tags/')) {
        sha = await resolve(`refs/remotes/origin/${headRef.replace(/^refs\/heads\//, '')}`)
      }
      requireThat(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha), 'could not resolve cloned head to a commit')
      await git('checkout', ['checkout', '--detach', sha, '--'])
      return sha
    })
    await phase('install', () => run('install', 'pnpm', ['install', '--frozen-lockfile']))
    await phase('build', () => run('build', 'pnpm', ['--filter', '@vercel/board', 'build']))
    await phase('serve_ready', async () => {
      const port = await freePort(signal)
      const url = `http://127.0.0.1:${port}/api/board`
      const serve = launch('serve', process.execPath,
        [cli, 'serve', '--port', String(port), '--dir', join(tmp, 'data'), '--no-inspect', '--agent-ops'],
        { serving: true })
      const readyBy = performance.now() + 60_000
      const banner = `serving a local board at ${url} as `
      for (;;) {
        checkDeadline()
        requireThat(!serve.exited && performance.now() < readyBy, 'serve did not become ready')
        if (readTail(serve.log).split('\n').some((line) => line.startsWith(banner))) break
        await sleep(25, undefined, { signal })
      }
      env.BOARD_URL = url
    })
    const channel = 'demo/acme/web'
    const worker = 'demo-worker'
    const task = await phase('create', async () => {
      const { task } = await vb('create task', 'tasks', 'create', channel,
        'For fictional acme/web, draft a wording-only README change. Fixture: `A sample app.` Replace it with `A sample app for local task handoffs.` Report the exact replacement and check; do not publish.', '--no-sync')
      requireThat(typeof task?.id === 'string' && task.id.length > 0 && task.task?.state === 'ready' &&
        task.by?.profile === null, 'create did not return a ready task from the local principal')
      return task
    })
    await phase('claim', async () => {
      const { agent } = await vb('register worker', 'agents', 'register', channel,
        '--role', 'implementation-worker', '--harness', 'shell', '--as', worker)
      requireThat(agent?.status === 'enabled' && agent.binding?.profile === worker, 'worker registration was not confirmed')
      const { task: claimed } = await vb('claim task', '--as', worker, 'tasks', 'claim', task.id, '--lease', '15m')
      requireThat(claimed?.id === task.id && claimed.task?.state === 'claimed' &&
        agent.binding.principal === task.by.principal &&
        claimed.task.claim?.actor === `${agent.binding.principal}+${worker}` &&
        claimed.task.claim.actor !== task.task.owner, 'claim by the second identity was not confirmed')
    })
    await phase('complete', async () => {
      await vb('reply with candidate', '--as', worker, 'reply', task.id, '--no-sync',
        '--idempotency-key', `demo-review-${task.id}-v1`,
        'Candidate: replace `A sample app.` with `A sample app for local task handoffs.` Checked against the fixture text. No repository or app tests run.')
      const { task: completed, outcome } = await vb('complete task', '--as', worker, 'tasks', 'complete', task.id,
        'Candidate recorded for human review')
      requireThat(completed?.id === task.id && completed.task?.state === 'completed' && outcome === 'completed', 'completion was not confirmed')
    })
    const seconds = (performance.now() - start) / 1000
    return {
      metric: 'time_to_first_claim', value: seconds,
      unit: 'seconds from fresh clone to second identity completing a claimed task',
      seconds, commands, phases, head,
    }
  } catch (err) {
    throw signal.aborted ? signal.reason : err
  } finally {
    cleaningUp = true
    clearTimeout(overall)
    try {
      for (const pid of groups) killGroup(pid)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, interrupt)
    }
  }
}

try {
  const value = await measure(options(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(value)}\n`)
} catch (err) {
  process.stderr.write(`error: ${err instanceof MetricError ? err.message : 'time-to-first-claim measurement failed'}\n`)
  process.exitCode = 1
}
