// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { BlockView, MessageView } from '../src/api/routes.ts'
import { ActivityBlock } from '../src/inspect/app/activity.tsx'
import { IdentitiesContext, type Identities } from '../src/inspect/app/identity.ts'
import { MessageRow, Messages, type RowOptions } from '../src/inspect/app/message.tsx'

let root: Root | undefined

afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
})

function show(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  root ??= createRoot(host)
  flushSync(() => root!.render(node))
  return document.body
}

const at = 1_700_000_000_000
const ITEMS = [
  { at, kind: 'say', text: 'Reading the **config** first.' },
  { at: at + 1_000, kind: 'tool', text: 'read src/config.ts' },
  { at: at + 1_200, kind: 'output', text: 'export const port = 8080' },
  { at: at + 5_200, kind: 'thinking', text: 'The port is hard-coded; it should come from PORT.' },
  { at: at + 6_000, kind: 'tool', text: 'bash pnpm test' },
  { at: at + 9_000, kind: 'error', text: 'Error: 2 tests failed' },
  { at: at + 9_500, kind: 'tool', text: 'edit src/config.ts' },
  { at: at + 9_600, kind: 'warning', text: 'context is 80% full' },
]

const activity = (data: Record<string, unknown>): BlockView => ({ schema: 'worker_activity', version: 1, data: { task: '1', attempt: 1, round: 1, ...data } })

// What each line of a turn reads while its folds are closed.
const lines = (page: HTMLElement) =>
  [...page.querySelectorAll('.turn > *')].map((el) => (el.tagName === 'DETAILS' ? el.querySelector('summary')! : el).textContent!.trim())

it('shows a finished round as a turn: thoughts and actions on one line each, folded, and what the worker said as text', () => {
  const page = show(<ActivityBlock block={activity({ state: 'completed', items: ITEMS, changes: { files: 1, insertions: 3, deletions: 1 }, checks: [{ name: 'test', passed: false }] })} />)
  expect(lines(page)).toEqual([
    'Reading the config first.',
    'Readsrc/config.ts',
    'Thought for 4s',
    'Ranpnpm test',
    'Editedsrc/config.ts',
    'context is 80% full',
    'Worked for 10s1 file +3 −1✗ test',
  ])
  // The worker's words are markdown, as any message's.
  expect(page.querySelector('.turn strong')?.textContent).toBe('config')
  // Each thought and each output is behind its line until it is opened.
  const folds = [...page.querySelectorAll('.turn details')]
  expect(folds.map((fold) => (fold as HTMLDetailsElement).open)).toEqual([false, false, false])
  expect(folds.map((fold) => fold.querySelector('summary + *')?.textContent)).toEqual([
    'export const port = 8080',
    'The port is hard-coded; it should come from PORT.',
    // A failed action holds the error it ended with.
    'Error: 2 tests failed',
  ])
  // An action with nothing to show has nothing to open.
  expect(page.querySelectorAll('.turn > div.turn-action')).toHaveLength(1)
})

it('says the round is working until it ends, and how it ended when it did not complete', () => {
  const page = show(<ActivityBlock block={activity({ state: 'running', items: ITEMS.slice(0, 2) })} />)
  // A running round ends in three pulsing dots, as a chat shows typing.
  expect(page.querySelector('.turn > :last-child')?.matches('.turn-dots[role="status"]')).toBe(true)
  expect(page.querySelectorAll('.turn-dots i')).toHaveLength(3)
  flushSync(() => root!.render(<ActivityBlock block={activity({ state: 'lost_contact', round: 2, items: ITEMS.slice(0, 2) })} />))
  expect(lines(page).at(-1)).toBe('round 2 ended: lost contactWorked for 1s')
})

it('keeps an opened step open when the oldest items of a running round drop off', () => {
  const page = show(<ActivityBlock block={activity({ state: 'running', items: ITEMS })} />)
  const failed = [...page.querySelectorAll<HTMLDetailsElement>('.turn details')].find((fold) => fold.textContent!.includes('pnpm test'))!
  failed.open = true
  // The orchestrator keeps the newest items of a long round.
  flushSync(() => root!.render(<ActivityBlock block={activity({ state: 'running', items: ITEMS.slice(3) })} />))
  const open = [...page.querySelectorAll<HTMLDetailsElement>('.turn details')].filter((fold) => fold.open)
  expect(open.map((fold) => fold.querySelector('summary')!.textContent)).toEqual(['Ranpnpm test'])
})

const me = 'local:user:ada'
const message = (id: string, actor: string, name: string, text: string, blocks: BlockView[] = []): MessageView =>
  ({
    id, channel: 'general', re: id === '1' ? null : '1', replyTo: null, version: 1, revision: 1,
    by: { actor, principal: actor, profile: null }, author: { kind: 'person', handle: name, name, avatar: null },
    text, blocks, labels: {}, reactions: {}, links: [], attachments: [], editedAt: null, deleted: false,
    createdAt: new Date(at).toISOString(), noSync: false, from: null,
  }) as unknown as MessageView

const options = (chat: boolean): RowOptions => ({
  me, now: at, known: {} as RowOptions['known'], chat,
  viewer: { actor: me, principal: me, profile: null, may: () => false, manages: false, person: true } as unknown as RowOptions['viewer'],
})

// A 1×1 PNG.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const ORCHESTRATOR = 'local:user:ada+orchestrator'
const face = (el: Element) => ({ name: el.querySelector('.author')?.textContent, picture: el.querySelector('.avatar img')?.getAttribute('src') ?? el.querySelector('.avatar')?.textContent })

it('shows a thread as a chat: what you wrote and each agent turn under the name and picture the board gives them', () => {
  const block = activity({ state: 'completed', items: ITEMS.slice(0, 1) })
  const fence = `\`\`\`json#worker_activity@1\n${JSON.stringify(block.data)}\n\`\`\`\n\nDone: PORT is read now.`
  const rows = (identities: Identities) => (
    <IdentitiesContext.Provider value={identities}>
      <MessageRow m={message('1', me, 'Ada', 'Read the port from PORT.')} options={options(true)} />
      <MessageRow m={message('2', ORCHESTRATOR, 'orchestrator', fence, [block])} options={options(true)} />
      <MessageRow m={message('3', ORCHESTRATOR, 'orchestrator', 'Merged.')} options={options(true)} />
      <MessageRow m={{ ...message('4', ORCHESTRATOR, 'orchestrator', 'attempt 1 started.'), labels: { 'politburo.status': 'orchestrator' } } as MessageView} options={options(true)} />
    </IdentitiesContext.Provider>
  )
  const page = show(rows({}))
  // A worker's round is the orchestrator's message, written for the worker: it shows as the worker.
  expect([...page.querySelectorAll('.message')].map(face)).toEqual([
    { name: 'Ada', picture: 'A' },
    { name: 'Worker', picture: 'W' },
    { name: 'orchestrator', picture: 'O' },
  ])
  const status = () => page.querySelector('.status-line')!
  expect([status().querySelector('.status-line-author')?.textContent, status().querySelector('.avatar')?.textContent]).toEqual(['orchestrator', 'O'])
  // The status line reads as a message: who wrote it on one row, what they wrote on the row under it.
  expect([...status().children].map((row) => row.textContent)).toEqual([expect.stringMatching(/^Oorchestrator/), 'attempt 1 started.'])
  flushSync(() => root!.render(rows({ [me]: { name: 'Ada L.', avatar: PIXEL }, [ORCHESTRATOR]: { name: 'Conductor', avatar: null }, worker: { name: 'Builder', avatar: PIXEL } })))
  const [mine, round, said] = [...page.querySelectorAll('.message')]
  expect([mine, round, said].map((el) => face(el!))).toEqual([
    { name: 'Ada L.', picture: PIXEL },
    { name: 'Builder', picture: PIXEL },
    { name: 'Conductor', picture: 'C' },
  ])
  expect([status().querySelector('.status-line-author')?.textContent, status().querySelector('.avatar img')?.getAttribute('src') ?? null]).toEqual(['Conductor', null])
  expect(round!.textContent).toContain('Reading the config first.')
  expect(round!.textContent).toContain('Done: PORT is read now.')
})

it('shows who reacted by the names and pictures the board gives them', () => {
  const reacted = { ...message('1', me, 'Ada', 'Ship it?'), reactions: { thumbs_up: [me, ORCHESTRATOR] } } as MessageView
  const page = show(
    <IdentitiesContext.Provider value={{ [me]: { name: 'Ada L.', avatar: PIXEL }, [ORCHESTRATOR]: { name: 'Conductor', avatar: null } }}>
      <MessageRow m={reacted} options={{ ...options(false), names: { [me]: 'Ada', [ORCHESTRATOR]: 'orchestrator' } }} />
    </IdentitiesContext.Provider>,
  )
  const chip = page.querySelector('.chip')!
  expect(chip.getAttribute('title')).toBe(':thumbs_up: Ada L., Conductor')
  expect([...chip.querySelectorAll('.avatar')].map((el) => el.querySelector('img')?.getAttribute('src') ?? el.textContent)).toEqual([PIXEL, 'C'])
  expect(chip.textContent).toContain('2')
})

it('keeps names and avatars outside a chat', () => {
  const page = show(<MessageRow m={message('1', me, 'Ada', 'Read the port from PORT.')} options={options(false)} />)
  expect(page.querySelector('.author')?.textContent).toBe('Ada')
  expect(page.querySelector('.avatar')?.textContent).toBe('A')
})

it('starts a worker round under its own name and picture when it follows the orchestrator in a thread', () => {
  const block = activity({ state: 'completed', items: ITEMS.slice(0, 1) })
  const fence = `\`\`\`json#worker_activity@1\n${JSON.stringify(block.data)}\n\`\`\`\n\nDone.`
  // The orchestrator's actor writes all of them, a few seconds apart. A status line is a row of its own,
  // so the message after it starts under its name again.
  const status = { ...message('2', ORCHESTRATOR, 'orchestrator', 'attempt 1 started.'), labels: { 'politburo.status': 'orchestrator' } } as MessageView
  const page = show(
    <Messages
      now={at}
      options={options(true)}
      after={message('1', me, 'Ada', 'Say hello.')}
      messages={[status, message('7', ORCHESTRATOR, 'orchestrator', 'Round 1 sent.'), message('3', ORCHESTRATOR, 'orchestrator', fence, [block]), { ...status, id: '4', text: 'merged.' } as MessageView, message('5', ORCHESTRATOR, 'orchestrator', 'Branch kept.'), message('6', ORCHESTRATOR, 'orchestrator', 'Draft closed.')]}
    />,
  )
  expect([...page.querySelectorAll('.message')].map((el) => el.querySelector('.author')?.textContent ?? null)).toEqual(['orchestrator', 'Worker', 'orchestrator', null])
})

it("heads a worker round's answer with the worker's name and picture, and not its thoughts and actions", () => {
  const round = (state: string, answer: string) => {
    const block = activity({ state, items: ITEMS.slice(0, 2) })
    return message('2', ORCHESTRATOR, 'orchestrator', `\`\`\`json#worker_activity@1\n${JSON.stringify(block.data)}\n\`\`\`${answer}`, [block])
  }
  const page = show(<MessageRow m={round('completed', '\n\nDone: PORT is read now.')} options={options(true)} />)
  // What the row reads, top to bottom: the turn, then who answered, then the answer.
  const body = page.querySelector('.message .body')!
  expect([...body.children].map((el) => el.className.split(' ')[0])).toEqual(['turn', 'meta-line', 'text'])
  expect(body.querySelector('.meta-line .author')?.textContent).toBe('Worker')
  // A round still running has said nothing back yet: nothing heads it.
  flushSync(() => root!.render(<MessageRow m={round('running', '')} options={options(true)} />))
  expect(page.querySelector('.message .turn')).not.toBeNull()
  expect(page.querySelector('.message .meta-line')).toBeNull()
})
