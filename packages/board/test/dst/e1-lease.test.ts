import { it } from 'vitest'
import { hasAppendGuard, leaseRace } from './lease.ts'
import { checkSeeds } from './seeds.ts'

const enabled = hasAppendGuard || process.env.DST_EXPECT === 'e1'
const title = 'E1: lease writes land only before the deadline and under the current epoch'

if (!enabled) {
  it.skip(`${title} (main permits expiry at append; needs PR 20 e8fe0f6)`, () => {})
} else {
  it(title, async () => { await checkSeeds(leaseRace) }, 55_000)
}
