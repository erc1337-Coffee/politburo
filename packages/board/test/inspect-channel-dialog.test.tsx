// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

// The dialog reads the channel's settings and the board's models from the page's data layer.
const findRepositories = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
const { channels } = vi.hoisted(() => ({ channels: { web: { settings: { repository: 'https://github.com/acme/web', routes: [] } }, notes: { settings: { repository: null, routes: [] } } } }))
vi.mock('../src/inspect/app/board.ts', () => ({
  getState: () => ({ channels }),
  useBoard: () => ({ channels }),
  loadModelRoutes: () => Promise.resolve([]),
  findRepositories,
  saveChannel: () => Promise.resolve(null),
}))
const { ChannelDialog } = await import('../src/inspect/app/channel-dialog.tsx')

let root: Root | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
})

function open(channel?: string) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  flushSync(() => root!.render(<ChannelDialog {...(channel ? { channel } : {})} open onOpenChange={() => {}} />))
  return { input: document.querySelector<HTMLInputElement>('.channel-form input')!, hint: () => document.querySelector('.channel-form div.field > .hint')?.textContent ?? null }
}

function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  flushSync(() => {
    set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('says nothing under the input that the input already shows', () => {
  const { input, hint } = open('web')
  expect(input.value).toBe('acme/web')
  expect(hint()).toBeNull()
  type(input, 'https://github.com/acme/api')
  expect(hint()).toBeNull()
})

it('says nothing under the input of a channel without a repository', () => {
  const { hint } = open('notes')
  expect(hint()).toBeNull()
})

it("says nothing under the input of a new channel's name", () => {
  const { input, hint } = open()
  type(input, 'https://github.com/acme/web.git')
  expect(hint()).toBeNull()
  type(input, 'Release notes')
  expect(hint()).toBeNull()
})

it('says under the input why the repository search failed', async () => {
  findRepositories.mockRejectedValueOnce(new Error('GitHub answered 401'))
  const { input, hint } = open()
  type(input, 'acme')
  await vi.waitFor(() => expect(hint()).toBe('GitHub answered 401'), { timeout: 2_000 })
})
