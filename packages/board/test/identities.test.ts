import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearer, BOARD_URL, personToken, testBoard } from './harness.ts'

// How the board shows people, agents and services, as a person at the inspector sets and reads it:
// over HTTP, to a board in this process.

type Fetch = (request: Request) => Promise<Response>
const handleAs = (fetch: Fetch, token: () => Promise<string>) => board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)

// A 1×1 PNG.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe("the board's identities", () => {
  it('are read back by key, replaced by the next write, and gone when set to nothing', async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    expect(await julian.identities()).toEqual([])
    expect(await julian.setIdentity('relay', { name: 'Courier', avatar: null })).toEqual({ key: 'relay', name: 'Courier', avatar: null })
    await julian.setIdentity('local:user:ada+orchestrator', { name: 'Conductor', avatar: PIXEL })
    expect(await julian.identities()).toEqual([
      { key: 'local:user:ada+orchestrator', name: 'Conductor', avatar: PIXEL },
      { key: 'relay', name: 'Courier', avatar: null },
    ])
    await julian.setIdentity('relay', { name: null, avatar: PIXEL })
    await julian.setIdentity('local:user:ada+orchestrator', { name: null, avatar: null })
    expect(await julian.identities()).toEqual([{ key: 'relay', name: null, avatar: PIXEL }])
  })

  it('keep a key named like what every object inherits as a key of its own', async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    await julian.setIdentity('__proto__', { name: 'Odd', avatar: null })
    expect(await julian.identities()).toEqual([{ key: '__proto__', name: 'Odd', avatar: null }])
  })

  it('take only a small inline picture: no URL, no SVG, nothing large', async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    const large = `data:image/png;base64,${'A'.repeat(64_000)}`
    for (const avatar of ['https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zy8+', large])
      await expect(julian.setIdentity('relay', { name: null, avatar })).rejects.toMatchObject({ status: 400 })
    await expect(julian.setIdentity('relay', { name: ' ', avatar: null })).rejects.toMatchObject({ status: 400 })
    expect(await julian.identities()).toEqual([])
  })
})
