// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { THEME_BOOT, THEME_KEY } from '../src/inspect/theme.ts'

// What the page's head runs before it paints: your pick of a theme, or nothing, so the page follows the system.
const boot = (stored: string | null) => {
  if (stored === null) localStorage.removeItem(THEME_KEY)
  else localStorage.setItem(THEME_KEY, stored)
  delete document.documentElement.dataset.theme
  new Function(THEME_BOOT)()
  return document.documentElement.dataset.theme ?? null
}

afterEach(() => localStorage.clear())

it.each([['dark', 'dark'], ['light', 'light'], [null, null], ['sepia', null], ['"dark"', null]])('boots a page whose stored pick is %j as %j', (stored, shown) => {
  expect(boot(stored)).toBe(shown)
})

it('boots a page that cannot read storage as the system does', () => {
  const getItem = Storage.prototype.getItem
  Storage.prototype.getItem = () => { throw new Error('storage is off') }
  try {
    expect(boot(null)).toBeNull()
  } finally {
    Storage.prototype.getItem = getItem
  }
})
