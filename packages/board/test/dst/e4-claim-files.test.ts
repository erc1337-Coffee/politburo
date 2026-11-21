import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, vi } from 'vitest'
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

let sim: Sim | undefined
let killNext = false
let lockOwner: number | undefined
let lockReleased = Promise.withResolvers<void>()
let mode: 'legacy' | 'tombstone' | 'lock'

async function fsStep<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (sim?.op !== undefined) {
    await sim.gate(`fs:${label}`)
    if (killNext) return sim.kill()
  }
  return run()
}

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const wrap = <A extends unknown[], R>(label: string, call: (...args: A) => Promise<R>) =>
    (...args: A) => fsStep(label, () => call(...args))
  return {
    ...fs,
    mkdir: wrap('mkdir', fs.mkdir),
    readFile: wrap('readFile', fs.readFile),
    readdir: wrap('readdir', fs.readdir),
    stat: wrap('stat', fs.stat),
    writeFile: wrap('writeFile', fs.writeFile),
    unlink: wrap('unlink', fs.unlink),
    link: wrap('link', fs.link),
    rename: (from: string, to: string) => {
      const kind = to.endsWith('.lock') ? 'lock' : to.endsWith('.drop') ? 'tombstone' : 'claim'
      return fsStep(`rename:${kind}`, async () => {
        await fs.rename(from, to)
        if (kind === 'lock') {
          mode = 'lock'
          lockOwner = sim?.op
        } else if (kind === 'tombstone') mode = 'tombstone'
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
      if (sim?.op === undefined) return timers.setTimeout(ms)
      // The lock's retry timer cannot make progress until the other actor removes
      // the lock. Wait for that change instead of racing a real polling interval.
      if (lockOwner === undefined) return
      sim.block()
      try { await lockReleased.promise } finally { sim.unblock() }
    },
  }
})

async function withClaims<T>(run: () => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'board-dst-claims-'))
  vi.stubEnv('XDG_CONFIG_HOME', dir)
  mode = 'legacy'
  lockReleased = Promise.withResolvers<void>()
  try {
    return await withClock(async () => {
      await open().put(task, proofA)
      return run()
    })
  } finally {
    sim = undefined
    killNext = false
    lockOwner = undefined
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  }
}

// Observe what this version actually does, not the branch it was checked out from.
const adapter = await withClaims(async () => {
  await drop(open())
  return mode
})

function claimRace(seed: number) {
  return withClaims(async () => {
    const scheduler = sim = new Sim(seed)
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
if (adapter !== 'lock' && process.env.DST_EXPECT !== 'e4') {
  it.skip(`${title} (PR 21 fd0685f has the tombstone window; needs the file-claim lock from 770eb47)`, () => {})
} else {
  it(title, async () => { await checkSeeds(claimRace) }, 55_000)
}

it.skip('E4: PID lock reaping needs a multiprocess fixture for PID reuse and cross-namespace liveness', () => {})
it.skip('E4: an older CLI ignores the new lock; needs a mixed-version fixture', () => {})
it.skip('E4: a kill while holding the PID lock can strand later writers; logical actors share one PID here', () => {})
it.skip('E4: claims.drop can throw after complete committed; needs a command-level cleanup failure fixture', () => {})
it.skip('E4 seed 243: on fd0685f put(B) completes, stale drop(A) renames B to .drop and dies before link; fresh get returns null (I5)', () => {})
