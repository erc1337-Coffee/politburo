import { expect, it } from 'vitest'
import { deploymentToken, personToken } from '../harness.ts'
import { withClock } from './clock.ts'
import { outcome } from './fixture.ts'
import { checkRevocation } from './oracles.ts'
import { checkSeeds, type Run } from './seeds.ts'
import { rng, Sim } from './sim.ts'
import { hasFence, hasStages, stagedBoard, stagedHandle } from './staged.ts'

const ADMIN = 'vercel:user:u_admin'
const SCOPER = 'vercel:project:prj_web:production'
const refused = ['forbidden', 'message_not_found']

async function accessRace(seed: number): Promise<Run> {
  return withClock(async () => {
    const sim = new Sim(seed)
    const violations: string[] = []
    await stagedBoard(sim, [ADMIN, SCOPER], async (host, history) => {
      const admin = stagedHandle(host, await personToken('u_admin'))
      const scoper = stagedHandle(host, await deploymentToken('web', 'prj_web'))
      const { grant } = await admin.client.createGrant({
        principals: [{ kind: 'project', project: 'prj_web', environments: ['production'] }],
        can: { work: ['read', 'manage'] },
      })
      const { task: root } = await admin.tasks.create('work', 'Implement the change')
      const { task: need } = await admin.tasks.create('work', 'Prepare the change')
      const moves = [
        { name: 'scope', run: () => outcome(() => scoper.tasks.scope(root.id, 'Scope accepted'), refused) },
        { name: 'stage', run: () => outcome(() => scoper.tasks.stage(root.id, 'rejected', 'Change deferred'), refused) },
        { name: 'assign', run: () => outcome(() => scoper.tasks.assign(root.id, `${ADMIN}+worker`), refused) },
        { name: 'needs', run: () => outcome(() => scoper.tasks.needs(root.id, [need.id]), refused) },
      ]
      await sim.run([
        moves[Math.floor(rng(seed ^ 0x45bb)() * moves.length)]!,
        { name: 'revoke', run: async () => {
          expect(await admin.client.revokeGrant(grant.id)).toEqual({ revoked: true })
          return 'ok'
        } },
      ])
      expect(history.some(({ facts }) => facts.some(({ type, id }) => type === 'grant.deleted' && id === grant.id))).toBe(true)
      violations.push(...checkRevocation(history, grant.id, SCOPER))
    })
    return { violations, trace: sim.trace }
  })
}

const enabled = hasStages && (hasFence || process.env.DST_EXPECT === 'e2')
const title = 'E2: revoking the scoper’s grant fences off staged writes (I3)'
if (!enabled) {
  it.skip(`${title} (needs PR 21 fd0685f staged-work access fence)`, () => {})
} else {
  it(title, async () => { await checkSeeds(accessRace) }, 55_000)
}
