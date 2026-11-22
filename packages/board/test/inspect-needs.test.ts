import { expect, it } from 'vitest'
import { createBoardClient } from '../src/client/client.ts'
import { needsAction } from '../src/inspect/app/needs.ts'
import { initialState, merge, type Viewer } from '../src/inspect/app/store.ts'
import { compileAccess } from '../src/server/access.ts'
import { BOARD_URL, personToken, testBoard } from './harness.ts'

it('shows ready work in the order a real claim-next takes it', async () => {
  const board = testBoard()
  const fetcher: typeof fetch = (input, init) => board.fetch(new Request(input, init))
  const token = await personToken('u_julian', BOARD_URL)
  const owner = createBoardClient({ url: BOARD_URL, token, profile: null, fetch: fetcher })
  const worker = createBoardClient({ url: BOARD_URL, token, profile: 'worker', fetch: fetcher })
  const outsider = createBoardClient({ url: BOARD_URL, token: await personToken('u_ada', BOARD_URL), profile: null, fetch: fetcher })
  const { actor, principal, profile, can } = await worker.me()
  const channel = 'work'
  const { task: oldest } = await owner.tasks.create(channel, { text: 'Oldest high', priority: 'high' })
  board.clock.skip(1000)
  const { task: newer } = await owner.tasks.create(channel, { text: 'Another high', priority: 'high' })
  board.clock.skip(1000)
  await owner.tasks.create(channel, { text: 'Assigned high', priority: 'high', for: actor })
  await owner.tasks.create(channel, { text: 'Urgent', priority: 'urgent' })
  await owner.tasks.create(channel, { text: 'Lowest', priority: 'lowest' })
  await owner.tasks.create(channel, { text: 'Another profile’s task', priority: 'urgent', for: `${principal}+other` })
  await outsider.tasks.create(channel, { text: 'Another owner’s task', priority: 'urgent' })
  const { task: parked } = await owner.tasks.create(channel, { text: 'Parked', priority: 'urgent' })
  await owner.tasks.park(parked.id, 'Not scheduled yet')

  const access = compileAccess(can)
  const viewer: Viewer = { actor, principal, profile, may: (permission, path) => access.can(permission, path), person: true, manages: false }
  const { tasks } = await worker.tasks.list({ channel, state: 'open' })
  const state = merge(initialState, tasks.map(({ message }) => message))
  expect(Date.parse(oldest.createdAt)).toBeLessThan(Date.parse(newer.createdAt))
  const ready = needsAction(state, viewer, Date.now()).ready.map(({ id }) => id)
  const taken: string[] = []
  while (true) {
    const claim = await worker.tasks.claim({ channel })
    if (!claim) break
    taken.push(claim.task.id)
  }
  expect(taken).toHaveLength(5)
  expect(ready).toEqual(taken)
})
