import { expect, it } from 'vitest'
import { leaseRace } from './lease.ts'

it('finds late lease writes when only the test adapter’s clock check is disabled', async () => {
  const guardedViolations: string[] = []
  const caught: number[] = []
  let allowedLiveWrite = false
  for (let seed = 0; seed < 16; seed++) {
    const guarded = await leaseRace(seed, 'local')
    guardedViolations.push(...guarded.violations.map((violation) => `DST_SEED=${seed}: ${violation}`))
    allowedLiveWrite ||= guarded.history.some(({ facts }) => facts.some(({ type }) => type === 'task.renewed'))
    const mutated = await leaseRace(seed, 'ignore-clock')
    if (mutated.violations.some((violation) => violation.startsWith('I1 '))) caught.push(seed)
  }
  expect(guardedViolations).toEqual([])
  expect(allowedLiveWrite, 'the guarded adapter must still let a live renewal land').toBe(true)
  expect(caught.length, 'expected I1 to catch the ignored clock in seeds 0–15').toBeGreaterThan(0)
})

it('replays the same choices, outcomes, and landed lease history from seed 0', async () => {
  const first = await leaseRace(0, 'ignore-clock')
  expect(first.trace.some((step) => step.includes('clock='))).toBe(true)
  expect(await leaseRace(0, 'ignore-clock')).toEqual(first)
})
