import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { vb } from '../src/cli/embedded.ts'
import { BOARD_URL, deploymentToken, PROJECT_ID, testBoard } from './harness.ts'

// `as(profile, { can })`: a handle the board holds to a can, as it holds a request to its
// x-board-can, on each backend: kept here, and over HTTP.

const DEV = { 'dev/': ['read', 'post'] } as const

describe('as(profile, { can }) on a board this deployment keeps', () => {
  it('does what its can gives, and nothing past it, where the handle without one does everything', async () => {
    const team = testBoard()
    const fixer = team.as('fixer', { can: DEV })
    const unheld = team.as('fixer')
    await unheld.post('ops', 'the on-call rota')
    const posted = await fixer.post('dev/fixes', 'on it')
    expect(posted.by.actor).toBe('board:client:fixer')
    // Past its can: another channel, and labels.
    await expect(fixer.post('ops', 'not here')).rejects.toMatchObject({ status: 403 })
    await expect(fixer.label(posted.id, { set: { kind: 'bug' } })).rejects.toMatchObject({ status: 403 })
    expect((await fixer.threads({ channel: 'ops' })).threads).toEqual([])
    expect((await fixer.me()).can).toEqual({ 'dev/': ['read', 'post'] })
    // The handle without one still may.
    await unheld.label(posted.id, { set: { kind: 'bug' } })
    expect((await unheld.threads({ channel: 'ops' })).threads).toHaveLength(1)
  })

  it('keeps vb() on it out of the grants, whatever the command', async () => {
    const team = testBoard()
    const reader = team.as('fixer', { can: ['read'] })
    expect((await vb(reader, ['grants', 'create', '--user', 'u_eve', '--can', '*=all'])).code).toBe(1)
    expect((await vb(reader, ['post', 'dev', 'not this either'])).code).toBe(1)
  })

  it('stays inside its can through as(), which only narrows it further', async () => {
    const team = testBoard({ url: BOARD_URL })
    const fixer = team.as('fixer', { can: DEV })
    const other = fixer.as('triage', { can: 'all' })
    await expect(other.post('ops', 'not here')).rejects.toMatchObject({ status: 403 })
    expect((await other.post('dev', 'here')).by.actor).toBe('board:client:triage')
    await expect(fixer.as('triage', { can: { 'dev/': ['read'] } }).post('dev', 'read only')).rejects.toMatchObject({ status: 403 })
  })

  it("refuses a can that doesn't parse", () => {
    const team = testBoard()
    expect(() => team.as('fixer', { can: 'dev/=fly' })).toThrow(expect.objectContaining({ code: 'invalid_scope' }))
  })
})

describe('as(profile, { can }) on a board over HTTP', () => {
  it('sends its can, which the board it uses holds it to', async () => {
    const served = testBoard({ url: BOARD_URL })
    const token = await deploymentToken('board', PROJECT_ID, 'production', { audience: BOARD_URL })
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      request.headers.set('authorization', `Bearer ${token}`)
      return served.fetch(request)
    }) as typeof globalThis.fetch
    const team = board({ backend: http(BOARD_URL, { fetch }) })
    const fixer = team.as('fixer', { can: DEV })
    expect((await fixer.post('dev', 'on it')).by.actor).toBe(`vercel:project:${PROJECT_ID}:production+fixer`)
    await expect(fixer.post('ops', 'not here')).rejects.toMatchObject({ status: 403 })
    expect((await team.as('fixer').post('ops', 'here, yes')).by.profile).toBe('fixer')
  })
})
