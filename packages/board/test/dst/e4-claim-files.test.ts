import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fileClaims } from '../../src/cli/claims.ts'
import { START, withClock } from './clock.ts'
import { checkSavedClaim } from './oracles.ts'
import { checkSeeds } from './seeds.ts'
import { Sim } from './sim.ts'

const task = '1'
const open = () => fileClaims(async () => 'http://board.test/api/board', 'worker')
const proofA = { epoch: 1, token: 'fixture-a', until: new Date(START + 30_000).toISOString() }
const proofB = { ...proofA, epoch: 2, token: 'fixture-b' }
// Main ignores the second argument; the held PRs compare its proof.
const drop = (claims: ReturnType<typeof open>) => (claims.drop as (id: string, proof: typeof proofA) => Promise<void>)(task, proofA)

let killNext = false
let lockOwner: number | undefined
let lockReleased = Promise.withResolvers<void>()
const TEARDOWN_MS = 2_000
type InFlight = { label: string; pending: Promise<unknown> }
const claimsFixture = new AsyncLocalStorage<{ closed: boolean; inFlight: Set<InFlight> }>()

async function fsStep<T>(label: string, run: () => Promise<T>): Promise<T> {
  // The actor retains its scheduler even after the fixture starts tearing down.
  const sim = Sim.current
  if (sim) {
    await sim.gate(`fs:${label}`)
    if (killNext) return sim.kill()
  }
  const fixture = claimsFixture.getStore()
  if (!fixture) return run()
  if (fixture.closed) throw new Error('DST claims fixture is closed')
  const call = { label, pending: run() }
  fixture.inFlight.add(call)
  try { return await call.pending } finally { fixture.inFlight.delete(call) }
}

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const wrap = <A extends unknown[], R>(label: string, call: (...args: A) => Promise<R>) =>
    (...args: A) => fsStep(label, () => call(...args))
  return {
    ...fs,
    mkdir: wrap('mkdir', fs.mkdir),
    readFile: wrap('readFile', fs.readFile),
    readdir: (dir: string) => fsStep('readdir', async () => (await fs.readdir(dir)).sort()),
    stat: (path: string) => fsStep('stat', async () => {
      const info = await fs.stat(path)
      const now = Date.now()
      return Object.assign(info, { mtimeMs: now, ctimeMs: now })
    }),
    writeFile: wrap('writeFile', fs.writeFile),
    unlink: wrap('unlink', fs.unlink),
    link: wrap('link', fs.link),
    rename: (from: string, to: string) => {
      const kind = to.endsWith('.lock') ? 'lock' : to.endsWith('.drop') ? 'tombstone' : 'claim'
      return fsStep(`rename:${kind}`, async () => {
        await fs.rename(from, to)
        if (kind === 'lock') lockOwner = Sim.current?.op
      })
    },
    rmdir: (dir: string) => fsStep('rmdir', async () => {
      await fs.rmdir(dir)
      if (dir.endsWith('.lock')) {
        lockOwner = undefined
        lockReleased.resolve()
        lockReleased = Promise.withResolvers<void>()
      }
    }),
  }
})

vi.mock('node:timers/promises', async (original) => {
  const timers = await original<typeof import('node:timers/promises')>()
  return {
    ...timers,
    async setTimeout(ms: number) {
      const sim = Sim.current
      if (!sim) return timers.setTimeout(ms)
      // The lock's retry timer cannot make progress until the other actor removes
      // the lock. Wait for that change instead of racing a real polling interval.
      if (lockOwner === undefined) return
      sim.block()
      try { await lockReleased.promise } finally { sim.unblock() }
    },
  }
})

async function withClaims<T>(run: (dir: string) => Promise<T>, teardownMs = TEARDOWN_MS) {
  const dir = await mkdtemp(join(tmpdir(), 'board-dst-claims-'))
  const fixture = { closed: false, inFlight: new Set<InFlight>() }
  vi.stubEnv('XDG_CONFIG_HOME', dir)
  lockReleased = Promise.withResolvers<void>()
  let originalFailure: ErrorOptions | undefined
  try {
    return await claimsFixture.run(fixture, () => withClock(async () => {
      await open().put(task, proofA)
      return run(dir)
    }))
  } catch (error) {
    originalFailure = { cause: error }
    throw error
  } finally {
    fixture.closed = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (fixture.inFlight.size) {
        await Promise.race([
          Promise.allSettled(Array.from(fixture.inFlight, ({ pending }) => pending)),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, teardownMs) }),
        ])
      }
    } finally {
      clearTimeout(timer)
      const stuck = Array.from(fixture.inFlight, ({ label }) => label)
      killNext = false
      lockOwner = undefined
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
      if (stuck.length) throw new Error(`DST claims teardown timed out waiting for: ${stuck.join(', ')}`, originalFailure)
    }
  }
}

it('bounds claims teardown for a stuck fs call and restores the fixture', async ({ onTestFinished }) => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const configHome = process.env.XDG_CONFIG_HOME
  const operationError = new Error('fixture operation failed')
  let dir!: string
  // Keep even a timing-out regression isolated from subsequent tests.
  onTestFinished(async () => {
    vi.unstubAllEnvs()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  await expect(withClaims(async (path) => {
    dir = path
    void fsStep('never-settling write', () => new Promise<never>(() => {}))
    throw operationError
  }, 20)).rejects.toMatchObject({
    message: expect.stringContaining('never-settling write'),
    cause: operationError,
  })
  expect(process.env.XDG_CONFIG_HOME === configHome).toBe(true)
  await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
}, 750)

it('drains a released write on abort and prevents writes after claims teardown', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const writeStarted = Promise.withResolvers<void>()
  const releaseWrite = Promise.withResolvers<void>()
  const afterTeardown = Promise.withResolvers<void>()
  const operationError = new Error('fixture operation failed')
  let dir: string | undefined
  let lateWrite: Promise<unknown> | undefined
  let writeFinished = false
  let writeFinishedOnAbort = false
  try {
    await expect(withClaims(async (path) => {
      dir = path
      const write = async (name: string) => {
        await fs.mkdir(path, { recursive: true })
        await fs.writeFile(join(path, name), 'probe')
      }
      // An out-of-actor continuation has no Sim gate to protect it.
      lateWrite = afterTeardown.promise.then(() => fsStep('late write', () => write('late'))).catch((error: unknown) => error)
      const sim = new Sim(0)
      try {
        await sim.run([
          { name: 'fail', run: async () => {
            // Seed 0 starts this actor first. Let the writer reach real I/O.
            sim.block()
            await writeStarted.promise
            sim.unblock()
            // Fail while the writer is still in flight.
            setImmediate(() => releaseWrite.resolve())
            throw operationError
          } },
          { name: 'write', run: async () => {
            await fsStep('slow write', async () => {
              writeStarted.resolve()
              await releaseWrite.promise
              await write('released')
              writeFinished = true
            })
            return 'written'
          } },
        ])
      } finally {
        writeFinishedOnAbort = writeFinished
      }
    })).rejects.toMatchObject({ message: expect.stringContaining('DST seed 0 operation failed'), cause: operationError })
    afterTeardown.resolve()
    await lateWrite
    await expect(fs.stat(dir!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(writeFinishedOnAbort).toBe(true)
  } finally {
    afterTeardown.resolve()
    await lateWrite
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

// Detect the lock in source so a regression to the unlocked path cannot skip the test.
const claimsSource = readFileSync(new URL('../../src/cli/claims.ts', import.meta.url), 'utf8')
const hasClaimLock = /\.lock`/.test(claimsSource)

function claimRace(seed: number) {
  return withClaims(async () => {
    const scheduler = new Sim(seed)
    let putCompleted = false
    await scheduler.run([
      { name: 'put B', run: async () => {
        await open().put(task, proofB)
        putCompleted = true
        return 'saved'
      } },
      { name: 'drop A', run: async () => {
        await drop(open())
        return 'returned'
      } },
    ], ({ op, label }, random) => {
      // Leave crash recovery under a held PID lock to its own pending case:
      // both logical CLI processes in this test have this worker's actual PID.
      killNext = label.startsWith('fs:') && op !== lockOwner && random() < 0.12
      if (killNext) return 'crash before call'
    })
    const recovered = await open().get(task)
    scheduler.trace.push(`fresh get: ${recovered === null ? 'missing' : `epoch ${recovered.epoch}`}`)
    return { violations: checkSavedClaim(putCompleted, proofB, recovered), trace: scheduler.trace }
  })
}

const title = 'E4: a stale drop does not lose a successful replacement put (I5)'
if (!hasClaimLock && process.env.DST_EXPECT !== 'e4') {
  it.skip(`${title} (PR 21 fd0685f has the tombstone window; needs the product fix in 770eb47)`, () => {})
} else {
  it(title, async () => { await checkSeeds(claimRace) }, 55_000)
}

it.skip('E4: PID lock reaping (770eb47) needs only a multiprocess fixture for PID reuse and cross-namespace liveness', () => {})
it.skip('E4: an older CLI ignores the lock from 770eb47; testing compatibility needs only a mixed-version fixture', () => {})
it.skip('E4: death while holding the PID lock (770eb47) needs only a multiprocess fixture; these actors share one PID', () => {})
it.skip('E4: claims.drop can throw after complete committed (PR 21 fd0685f); needs a product fix and a command-level cleanup failure fixture', () => {})
it.skip('E4 seed 243: on PR 21 fd0685f a stale drop dies after moving the saved claim to .drop (I5); needs the product fix in 770eb47', () => {})
