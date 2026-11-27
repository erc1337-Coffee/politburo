import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_URL, caller, personToken, testAuth, testBoard } from './harness.ts'
import { localUserToken, testLocal } from './tokens.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

/** A board on the local board's engine with only a store and a watcher on `firehose`, in the environment `env`. */
function bare(env: string) {
  vi.stubEnv('NODE_ENV', env)
  const seen: string[] = []
  const board = testBoard({
    blob: undefined,
    watch: {
      ack: {
        tail: 'firehose',
        run: async ({ event, board }) => {
          if (event.type !== 'message.posted' || event.message?.re !== null) return
          seen.push(event.message.text)
          await board.reply(event.message.id, 'on it')
        },
      },
    },
  })
  return { board, seen }
}

afterEach(() => vi.unstubAllEnvs())

describe("the local board's engine takes a scheduler and a blob store only if it's given them", () => {
  it.each(['development', 'production'])('in %s, runs watchers in the request that wrote, and refuses to schedule', async (env) => {
    const { board, seen } = bare(env)
    const julian = caller(board.fetch, await personToken())
    // Nothing arms a timer: the consumers run in the request that appended, here and in production alike.
    const { body } = await julian('POST', '/messages', { channel: 'firehose', text: 'deploy failed' })
    await vi.waitFor(() => expect(seen).toEqual(['deploy failed']))
    await vi.waitFor(async () => expect((await julian('GET', `/messages/${body.message.id}`)).body.replies.map((reply: { text: string }) => reply.text)).toEqual(['on it']))

    const scheduled = await julian('POST', '/schedules', { re: body.message.id, text: 'still broken?', in: '1d' })
    expect(scheduled).toEqual({
      status: 501,
      body: { error: { code: 'no_scheduler', message: "this board has no scheduler, so it can't send later" } },
    })
    expect((await julian('GET', '/schedules')).body).toEqual({ schedules: [] })
    // Its scheduler route has nothing to run.
    expect((await board.scheduler(new Request(`${BOARD_URL}/a2/scheduler`, { method: 'POST' }))).status).toBe(404)
  })

  it.each(['development', 'production'])('in %s, keeps no files without a blob store', async (env) => {
    const { board } = bare(env)
    const julian = caller(board.fetch, await personToken())
    const noFiles = { code: 'no_files', message: 'this board keeps no files' }

    const upload = await board.fetch(
      new Request(`${BOARD_URL}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${await personToken()}`, 'content-type': 'image/png' }, body: PNG }),
    )
    expect(upload.status).toBe(501)
    expect(await upload.json()).toEqual({ error: noFiles })
    expect(await julian('POST', '/messages', { channel: 'dev', text: 'see attached', attachments: ['AAAAAAAAAAAAAAAAAAAAAA'] })).toEqual({ status: 501, body: { error: noFiles } })
    expect(await julian('GET', '/attachments/AAAAAAAAAAAAAAAAAAAAAA')).toEqual({ status: 501, body: { error: noFiles } })
    await expect(board.upload({ data: PNG, name: 'shot.png' })).rejects.toMatchObject({ status: 501, code: 'no_files' })

  })
})

describe('local() from the build', () => {
  it('sends a scheduled message, on the engine it inlines', async () => {
    // Resolved as an app resolves it, through the package's exports, to what the build put there.
    const require = createRequire(import.meta.url)
    const built = async <T,>(spec: string) => (await import(pathToFileURL(require.resolve(spec)).href)) as T
    expect(require.resolve('@vercel/board/backend-local')).toMatch(/dist\/backend-local\.mjs$/)
    const { local } = await built<typeof import('../src/backend-local/index.ts')>('@vercel/board/backend-local')
    const { board: mounted } = await built<typeof import('../src/server/index.ts')>('@vercel/board')
    const { oidcTokens } = await built<typeof import('../src/access/index.ts')>('@vercel/board/access')
    // Its local user, as `vb serve` signs a token for it.
    const board = mounted({ backend: local({ memory: true }), authenticate: oidcTokens({ ...testAuth, local: testLocal }), url: BOARD_URL })
    const julian = caller(board.fetch, await localUserToken())
    const { body } = await julian('POST', '/messages', { channel: 'dev', text: 'PR #12 is open' })
    expect((await julian('POST', '/schedules', { re: body.message.id, text: 'friendly ping: review?', in: '1s' })).status).toBe(201)
    await vi.waitFor(
      async () => expect((await julian('GET', `/messages/${body.message.id}`)).body.replies).toEqual([expect.objectContaining({ text: 'friendly ping: review?', schedule: { id: expect.anything(), n: 0 } })]),
      { timeout: 5000 },
    )
  })
})
