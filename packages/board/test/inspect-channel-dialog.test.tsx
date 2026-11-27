// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

// The dialog reads the channel's settings and the board's models from the page's data layer.
vi.mock('../src/inspect/app/board.ts', () => ({
  getState: () => ({ channels: { web: { settings: { repository: 'https://github.com/acme/web', routes: [] } }, notes: { settings: { repository: null, routes: [] } } } }),
  loadModelRoutes: () => Promise.resolve([]),
  findRepositories: () => Promise.resolve([]),
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

it("says nothing of a channel's repository under the input that shows it", () => {
  const { input, hint } = open('web')
  expect(input.value).toBe('acme/web')
  expect(hint()).toBeNull()
  type(input, 'https://github.com/acme/api')
  expect(hint()).toBeNull()
})

it('says a channel without a repository is local', () => {
  const { hint } = open('notes')
  expect(hint()).toBe('local')
})

it("names a new channel, and not the repository it was typed from", () => {
  const { input, hint } = open()
  type(input, 'https://github.com/acme/web.git')
  expect(hint()).toBe('#web')
  type(input, 'Release notes')
  expect(hint()).toBe('#release-notes · local')
})
