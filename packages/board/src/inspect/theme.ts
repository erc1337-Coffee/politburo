// The page's light and dark themes. Until you pick one, the page follows the system's; your pick is
// kept in this browser only (`localStorage`), under one key the page and its boot script share.

export type Theme = 'light' | 'dark'

export const THEME_KEY = 'board.theme'

/** The theme you picked, or null when you never did (or storage is off): the page follows the system. */
export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

/** Applies `theme` and keeps it for the next visit. */
export function pickTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {}
}

/** The theme the page shows now: your pick, else the system's. */
export const shownTheme = (): Theme => storedTheme() ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

/**
 * Runs in the page's head before it paints, so a picked theme never flashes the other one. It sets
 * the attribute only for a pick: without one, the stylesheet follows the system, live.
 */
export const THEME_BOOT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`

/** `THEME_BOOT`'s SHA-256, so the page's policy runs it and no other inline script. */
export const THEME_BOOT_HASH = 'sha256-eCEenva6C8Xe/UxuNbZPiJZp6u3DQakgXNnRj8b/dtc='
