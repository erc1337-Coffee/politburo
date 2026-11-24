import { describe, expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearer, BOARD_URL, personToken, testBoard } from './harness.ts'

// A channel's settings, as a person at the inspector or the CLI sets and reads them: over HTTP,
// to a board in this process.

type Fetch = (request: Request) => Promise<Response>
const handleAs = (fetch: Fetch, token: () => Promise<string>) => board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)

const routes = [
  { key: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet (Max)', provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { key: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3 (OpenRouter)', provider: 'openrouter', model: 'moonshotai/kimi-k3' },
]

describe("a channel's settings", () => {
  it('are read back with the channel list, replaced whole by the next write', async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    await julian.createChannel('acme-web/auth')
    const settings = { repository: 'https://github.com/acme/web.git', routes: [{ key: 'openrouter/moonshotai/kimi-k3', enabled: true }, { key: 'anthropic/claude-sonnet-5-5', enabled: false }] }
    expect(await julian.configureChannel('acme-web/auth', settings)).toMatchObject({ path: 'acme-web/auth', settings })
    expect((await julian.channels({ prefix: 'acme-web/' })).channels).toMatchObject([{ path: 'acme-web/auth', settings }])

    await julian.configureChannel('acme-web/auth', { repository: null, routes: [] })
    expect((await julian.channels({ prefix: 'acme-web/' })).channels[0]?.settings).toEqual({ repository: null, routes: [] })
  })

  it('make no channel: one that is not there is 404 no_channel', async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    await expect(julian.configureChannel('nowhere', { repository: null, routes: [] })).rejects.toMatchObject({ status: 404, code: 'no_channel' })
    expect((await julian.channels()).channels).toEqual([])
  })

  it('take only an https repository with no credentials, and each route once', async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    await julian.createChannel('dev')
    for (const repository of ['git@github.com:acme/web.git', 'https://token@github.com/acme/web', 'http://github.com/acme/web', 'https://github.com/acme/web?x=1', '--upload-pack=x'])
      await expect(julian.configureChannel('dev', { repository, routes: [] })).rejects.toMatchObject({ status: 400 })
    const twice = [{ key: 'anthropic/claude-sonnet-5-5', enabled: true }, { key: 'anthropic/claude-sonnet-5-5', enabled: false }]
    await expect(julian.configureChannel('dev', { repository: null, routes: twice })).rejects.toMatchObject({ status: 400 })
  })
})

describe('the model routes and repositories a board offers', () => {
  it('are what board() was given', async () => {
    const found: (string | undefined)[] = []
    const team = testBoard({
      modelRoutes: routes,
      repositories: async (query) => (found.push(query), [{ name: 'acme/web', url: 'https://github.com/acme/web.git', private: true, description: null }]),
    })
    const julian = handleAs(team.fetch, () => personToken())
    expect(await julian.modelRoutes()).toEqual(routes)
    expect(await julian.repositories('web')).toEqual([{ name: 'acme/web', url: 'https://github.com/acme/web.git', private: true, description: null }])
    expect(found).toEqual(['web'])
  })

  it('a board given no Git account answers 501 no_repositories, and no routes', async () => {
    const team = testBoard()
    const julian = handleAs(team.fetch, () => personToken())
    expect(await julian.modelRoutes()).toEqual([])
    await expect(julian.repositories()).rejects.toMatchObject({ status: 501, code: 'no_repositories' })
  })
})
