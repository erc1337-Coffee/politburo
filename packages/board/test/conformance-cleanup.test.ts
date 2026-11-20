import { expect, it } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { bearer, BOARD_URL, localBoard, personToken } from './harness.ts'

type Fetch = (request: Request) => Promise<Response>

const CHANNEL = 'conformance'
const RUN_HEALTH = 'confirms a claimed run only through a taken and reported status probe'
const TOMBSTONE = 'deletes a message, leaving a tombstone'
const INVITE_ACCESS = 'lets a joined caller read and post only as granted'
const NOT_THE_RUNS = "conformance: not the run's"

const handle = async (fetch: Fetch) => board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), await personToken()) }) }).as(null)

/** The ID of what a request that made something with `text` answered, or null. */
function madeBy(sent: string, response: Response, text: string): Promise<string | null> {
  const body = (() => { try { return JSON.parse(sent) as { text?: string } } catch { return null } })()
  if (!response.ok || body?.text !== text) return Promise.resolve(null)
  return response.clone().json().then((answered: { message?: { id: string }; task?: { id: string } }) => answered.message?.id ?? answered.task?.id ?? null)
}

/**
 * A mount that is pointed at another board in the middle of a run: requests go to a first board
 * until something with `text` is created and read back, and from the next request on to a second, as a mount
 * does that a deploy or a proxy changes. The second has a message by the same principal under the
 * same ID as what was just created, which is what a cleanup that deletes by ID would take.
 */
async function swapping(text: string, onTestFinished: (cleanup: () => void) => void) {
  const first = localBoard({ agentOps: true })
  const second = localBoard({ agentOps: true })
  onTestFinished(() => { first.close(); second.close() })
  const elsewhere = await handle(second.fetch)
  let mount: Fetch = first.fetch
  let created: string | null = null
  let swapped = false
  let readBack = false
  /** Posts on the second board until it has a message under `id`. */
  const plant = async (id: string) => {
    for (let made = { id: '0' }; Number(made.id) < Number(id); ) made = await elsewhere.post(CHANNEL, { text: NOT_THE_RUNS, noSync: true })
    expect((await elsewhere.thread(id)).message.text).toBe(NOT_THE_RUNS)
  }
  const fetch: Fetch = async (request) => {
    // The run reads what it made back once, to know it again: the mount changes after that.
    if (created !== null && !readBack) readBack = true
    else if (created !== null && !swapped) {
      swapped = true
      mount = second.fetch
      await plant(created)
    }
    const sent = request.method === 'POST' ? await request.clone().text() : ''
    const response = await mount(request)
    if (created === null) created = await madeBy(sent, response, text)
    return response
  }
  return { client: await handle(fetch), fetch, elsewhere, planted: () => (swapped ? created : null) }
}

/** What the second board still has under `id`. */
const survives = async (elsewhere: Awaited<ReturnType<typeof handle>>, id: string) => {
  const { message } = await elsewhere.thread(id)
  return { text: message.text, deleted: message.deleted }
}

it("leaves another board's message alone, and reports it, when the mount changes boards after the run-health probe is made", async ({ onTestFinished }) => {
  const { client, elsewhere, planted } = await swapping('conformance: run health', onTestFinished)
  const report = await conformance(client, { channel: CHANNEL })
  const id = planted()
  expect(id).not.toBeNull()
  // The same ID, by the same principal, on a board the probe was never made on.
  expect(await survives(elsewhere, id!)).toEqual({ text: NOT_THE_RUNS, deleted: false })
  expect(report.checks.find(({ name }) => name === RUN_HEALTH)).toMatchObject({
    status: 'failed', detail: expect.stringMatching(new RegExp(`${id} is not the message this run created .*, so it was not touched`)),
  })
  expect(report.ok).toBe(false)
}, 60_000)

it("fails a delete a check makes rather than send it to another board's message with the same ID", async ({ onTestFinished }) => {
  const { client, elsewhere, planted } = await swapping('conformance: to delete', onTestFinished)
  const report = await conformance(client, { channel: CHANNEL })
  const id = planted()
  expect(id).not.toBeNull()
  expect(await survives(elsewhere, id!)).toEqual({ text: NOT_THE_RUNS, deleted: false })
  // The check says it once, as the delete it didn't make: the end of the run doesn't repeat it.
  const check = report.checks.find(({ name }) => name === TOMBSTONE)
  expect(check).toMatchObject({ status: 'failed', detail: expect.stringContaining(`${id} is not the message this run created`) })
  expect(check!.detail!.match(new RegExp(`${id} is not the message this run created`, 'g'))).toHaveLength(1)
  expect(report.ok).toBe(false)
}, 60_000)

it("leaves another board's message alone when the mount changes boards after an invitee's post, which only the invitee can delete", async ({ onTestFinished }) => {
  const { client, fetch, elsewhere, planted } = await swapping('conformance: joined caller', onTestFinished)
  // The joined caller's transport goes through the same mount, as it would in a deploy.
  const withInviteToken = (token: string) => board({
    backend: http(BOARD_URL, {
      fetch: (input, init) => {
        const request = new Request(input, { ...init, redirect: 'error' })
        request.headers.set('authorization', `Bearer ${token}`)
        return fetch(request)
      },
    }),
  }).as(null)
  const report = await conformance(client, { channel: CHANNEL, withInviteToken })
  const id = planted()
  expect(id).not.toBeNull()
  expect(await survives(elsewhere, id!)).toEqual({ text: NOT_THE_RUNS, deleted: false })
  expect(report.checks.find(({ name }) => name === INVITE_ACCESS)).toMatchObject({
    status: 'failed', detail: expect.stringContaining(`deleting the invitee posts: ${id} is not the message this run created`),
  })
  expect(report.ok).toBe(false)
}, 90_000)
