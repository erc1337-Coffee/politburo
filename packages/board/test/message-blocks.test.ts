import { describe, expect, it } from 'vitest'
import { oidcTokens } from '../src/access/index.ts'
import { block } from '../src/contract/blocks.ts'
import { a2 } from '../src/server/a2.ts'
import { memoryBlob } from '../src/server/blob.ts'
import { HttpError } from '../src/server/errors.ts'
import type { Backend, Middleware } from '../src/server/index.ts'
import { memory } from '../src/store/memory.ts'
import { board as boardOn, BOARD_URL, caller, deploymentToken, personToken, testAuth, testBoard, testLocal } from './harness.ts'
import { fakeQueue } from './queue.ts'

const SANDBOX = {
  type: 'object',
  required: ['id', 'action'],
  additionalProperties: false,
  properties: { id: { type: 'string' }, action: { enum: ['started', 'stopped'] }, config: { type: 'object' } },
}
const F = '```'
const fence = (id: string, json: string) => `${F}json#${id}\n${json}\n${F}`
const started = { id: 'sbx-123', action: 'started', config: { vcpus: 4 } }

/** A board with `sandbox@1` registered, Julian on it, and a way to read one message. */
async function setUp(options: Parameters<typeof testBoard>[0] = {}) {
  const board = testBoard(options)
  const julian = caller(board.fetch, await personToken())
  expect((await julian('POST', '/schemas', { name: 'sandbox', version: 1, schema: SANDBOX })).status).toBe(200)
  const read = async (id: string) => {
    const { message, replies } = (await julian('GET', `/messages/${id}`)).body
    return [message, ...replies].find((found: { id: string }) => found.id === id)
  }
  const texts = async (channel = 'deploys') => ((await julian('GET', `/messages?channel=${channel}`)).body.messages as { text: string }[]).map((message) => message.text)
  return { board, julian, read, texts }
}

describe('blocks in messages', () => {
  it('shows what a message carries as its blocks: one alone, one among prose, and several in order', async () => {
    const { julian } = await setUp()
    const alone = await julian('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', started) })
    expect(alone.status).toBe(201)
    expect(alone.body.message.blocks).toEqual([{ schema: 'sandbox', version: 1, data: started }])

    const text = `sandbox sbx-123 stopped, built from this commit\n\n${fence('sandbox@1', '{ "id": "sbx-123", "action": "stopped" }')}\n\n${fence('git-commit@1', JSON.stringify({ sha: 'a'.repeat(40), title: 'fix the build' }))}`
    const mixed = await julian('POST', '/messages', { re: alone.body.message.id, text })
    expect(mixed.body.message).toMatchObject({
      text,
      blocks: [
        { schema: 'sandbox', version: 1, data: { id: 'sbx-123', action: 'stopped' } },
        { schema: 'git-commit', version: 1, data: { sha: 'a'.repeat(40), title: 'fix the build' } },
      ],
    })
    // Every read shows them: the thread, the channel's messages, and the events.
    const thread = (await julian('GET', `/messages/${alone.body.message.id}`)).body
    expect([thread.message, ...thread.replies].map((message: { blocks: unknown[] }) => message.blocks.length)).toEqual([1, 2])
    const listed = (await julian('GET', '/messages?channel=deploys')).body.messages
    expect(listed.map((message: { blocks: { schema: string }[] }) => message.blocks.map((found) => found.schema))).toEqual([['sandbox'], ['sandbox', 'git-commit']])
    const events = (await julian('GET', '/events?after=0&channel=deploys')).body.events.filter((event: { type: string }) => event.type === 'message.posted')
    expect(events.map((event: { message: { blocks: unknown[] } }) => event.message.blocks.length)).toEqual([1, 2])
    // A message with none says so.
    expect((await julian('POST', '/messages', { channel: 'deploys', text: 'all quiet' })).body.message.blocks).toEqual([])
  })

  it("refuses a write whose block doesn't match its schema, and writes nothing", async () => {
    const { julian, texts } = await setUp()
    const refused: [string, string][] = [
      ['invalid_block', block('sandbox@1', { id: 'sbx-9', action: 'boot' })],
      ['invalid_block', block('sandbox@1', { action: 'started' })],
      ['invalid_block', block('sandbox@1', { id: 'sbx-9', action: 'started', extra: true })],
      ['invalid_block', fence('sandbox@1', '{ id: sbx-9 }')],
      ['invalid_block', fence('sandbox@1', '["sbx-9"]')],
      ['invalid_block', `${F}json#sandbox@1\n{"id":"sbx-9","action":"started"}`],
      ['invalid_block', fence('Sandbox', '{"id":"sbx-9"}')],
      ['invalid_block', block('git-commit@1', { sha: 'abc', title: 'not a full sha' })],
      // Every block is checked: one that would pass, before or after one that doesn't.
      ['invalid_block', `${block('sandbox@1', { id: 'sbx-9', action: 'boot' })}\n\n${block('sandbox@1', started)}`],
      ['invalid_block', `${block('sandbox@1', started)}\n\n${block('sandbox@1', { id: 'sbx-9', action: 'boot' })}`],
      ['schema_not_found', block('sandbox@2', started)],
      ['schema_not_found', block('nothing@1', {})],
    ]
    for (const [code, text] of refused) expect(await julian('POST', '/messages', { channel: 'deploys', text }), text).toMatchObject({ status: 400, body: { error: { code } } })
    expect(await texts()).toEqual([])
    // What's wrong is said of the field it's wrong in.
    const { body } = await julian('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', { id: 'sbx-9', action: 'boot' }) })
    expect(body.error.message).toContain('action must be "started" or "stopped"')
  })

  it('checks an edit and a schedule as it checks a post', async () => {
    const { julian, read } = await setUp({ scheduler: fakeQueue().scheduler })
    const { message } = (await julian('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', started) })).body
    const bad = block('sandbox@1', { id: 'sbx-123', action: 'paused' })

    expect(await julian('POST', `/messages/${message.id}/edit`, { text: bad })).toMatchObject({ status: 400, body: { error: { code: 'invalid_block' } } })
    expect((await read(message.id)).blocks).toEqual([{ schema: 'sandbox', version: 1, data: started }])
    // An edit that matches changes what it carries, and one to plain text carries nothing.
    expect((await julian('POST', `/messages/${message.id}/edit`, { text: block('sandbox@1', { id: 'sbx-123', action: 'stopped' }) })).status).toBe(200)
    expect((await read(message.id)).blocks).toEqual([{ schema: 'sandbox', version: 1, data: { id: 'sbx-123', action: 'stopped' } }])
    expect((await julian('POST', `/messages/${message.id}/edit`, { text: 'it stopped' })).status).toBe(200)
    expect((await read(message.id)).blocks).toEqual([])

    expect(await julian('POST', '/schedules', { channel: 'deploys', text: bad, in: '1h' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_block' } } })
    expect((await julian('GET', '/schedules')).body.schedules).toEqual([])
    expect((await julian('POST', '/schedules', { channel: 'deploys', text: block('sandbox@1', started), in: '1h' })).status).toBe(201)
  })

  it('leaves a fence that only shows a block alone: neither checked nor carried', async () => {
    const { julian } = await setUp()
    const shown = `To post one:\n\n${F}${F}markdown\n${fence('sandbox@1', '{ "id": "sbx-9", "action": "boot" }')}\n${F}${F}\n\nor quoted:\n\n> ${F}json#nothing@1\n> {}\n> ${F}\n\nand ${F}json${F} is just code:\n\n${F}json\n{"id":1}\n${F}`
    const posted = await julian('POST', '/messages', { channel: 'deploys', text: shown })
    expect(posted.status).toBe(201)
    expect(posted.body.message.blocks).toEqual([])
  })

  it('drops its blocks with a deleted message', async () => {
    const { julian, read } = await setUp()
    const { message } = (await julian('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', started) })).body
    expect((await julian('POST', `/messages/${message.id}/delete`, {})).status).toBe(200)
    expect(await read(message.id)).toMatchObject({ deleted: true, blocks: [] })
  })

  it('checks what the middleware passed on, when it changed the text', async () => {
    // A middleware that redacts an ID, and one that breaks the block it rewrites.
    const redact: Middleware = async ({ write, next }) => next({ text: write.text.replace('sbx-123', 'sbx-xxx') })
    const breaks: Middleware = async ({ write, next }) => next({ text: write.text.replace('"started"', '"rewritten"') })
    const redacting = await setUp({ middleware: [redact] })
    const kept = await redacting.julian('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', started) })
    expect(kept.body.message.blocks).toEqual([{ schema: 'sandbox', version: 1, data: { ...started, id: 'sbx-xxx' } }])

    const breaking = await setUp({ middleware: [breaks] })
    expect(await breaking.julian('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', started) })).toMatchObject({ status: 400, body: { error: { code: 'invalid_block' } } })
    expect(await breaking.texts()).toEqual([])
  })

  it('checks a block for anyone who may post, whether or not they could register its schema', async () => {
    const { board, texts } = await setUp()
    const deployment = caller(board.fetch, await deploymentToken())
    expect((await deployment('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', started) })).status).toBe(201)
    expect((await deployment('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', { id: 'sbx-9', action: 'boot' }) })).status).toBe(400)
    expect(await texts()).toEqual([block('sandbox@1', started)])
  })

  it('reads a schema as the board itself: a write is checked the same whoever may read schemas, and whoever wrote first', async () => {
    // A board whose backend lets no request's caller read a schema, as Vercel's API refuses some.
    const inner = a2({ store: memory(), blob: memoryBlob() })
    const backend: Backend = {
      ...inner,
      schema: async (who, input, signal) => {
        if ('identity' in who) throw new HttpError(403, 'forbidden', "this token can't read schemas")
        return inner.schema(who, input, signal)
      },
    }
    const team = boardOn({ backend, url: BOARD_URL, authenticate: oidcTokens({ ...testAuth, local: testLocal }) })
    await team.createSchema({ name: 'sandbox', version: 1, schema: SANDBOX })
    const julian = caller(team.fetch, await personToken())
    expect((await julian('GET', '/schemas/sandbox@1')).status).toBe(403)
    // Nothing has read the schema yet, and Julian can't: his block is checked all the same.
    expect(await julian('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', { id: 'sbx-9', action: 'boot' }) })).toMatchObject({ status: 400, body: { error: { code: 'invalid_block' } } })
    expect((await julian('POST', '/messages', { channel: 'deploys', text: block('sandbox@1', started) })).body.message.blocks).toEqual([{ schema: 'sandbox', version: 1, data: started }])
  })

  it('answers a caller who may not post there as it would for any text, whatever its blocks say', async () => {
    const { board, julian } = await setUp()
    const reader = caller(board.fetch, await personToken(), { 'x-board-can': 'deploys=read' })
    const { message } = (await julian('POST', '/messages', { channel: 'deploys', text: 'a thread' })).body
    const bad = block('sandbox@1', { id: 'sbx-9', action: 'boot' })
    const plain = [
      await reader('POST', '/messages', { channel: 'deploys', text: 'plain text' }),
      await reader('POST', '/messages', { re: message.id, text: 'plain text' }),
      await reader('POST', `/messages/${message.id}/edit`, { text: 'plain text' }),
      await reader('POST', '/schedules', { channel: 'deploys', text: 'plain text', in: '1h' }),
    ]
    const withBlock = [
      await reader('POST', '/messages', { channel: 'deploys', text: bad }),
      await reader('POST', '/messages', { re: message.id, text: bad }),
      await reader('POST', `/messages/${message.id}/edit`, { text: bad }),
      await reader('POST', '/schedules', { channel: 'deploys', text: bad, in: '1h' }),
    ]
    expect(plain.map((answer) => answer.status)).toEqual([403, 403, 403, 403])
    expect(withBlock.map((answer) => [answer.status, answer.body.error.code])).toEqual(plain.map((answer) => [answer.status, answer.body.error.code]))
    // Where it may post, its block is checked.
    const poster = caller(board.fetch, await personToken(), { 'x-board-can': 'deploys=post' })
    expect((await poster('POST', '/messages', { channel: 'deploys', text: bad })).status).toBe(400)
  })

  it("posts a block from the board's own code, built with block()", async () => {
    const team = testBoard()
    await team.createSchema({ name: 'sandbox', version: 1, schema: SANDBOX })
    const message = await team.post('deploys', block('sandbox@1', started))
    expect(message.blocks).toEqual([{ schema: 'sandbox', version: 1, data: started }])
    const said = await team.reply(message.id, `it stopped\n\n${block('sandbox@1', { id: 'sbx-123', action: 'stopped' })}`)
    expect(said.blocks).toEqual([{ schema: 'sandbox', version: 1, data: { id: 'sbx-123', action: 'stopped' } }])
    await expect(team.post('deploys', block('sandbox@1', { id: 'sbx-9', action: 'boot' }))).rejects.toMatchObject({ status: 400, code: 'invalid_block' })
  })
})
