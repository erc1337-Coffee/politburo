/** The sections of the board's settings, each a tab at `/settings/<section>`. */
export const SECTIONS = ['access', 'identities', 'schemas', 'schedules', 'watchers'] as const
export type Section = (typeof SECTIONS)[number]

/** How Work groups its rows: by swarm group (the default), by board state, or not at all. */
export const GROUPINGS = ['swarm', 'state', 'none'] as const
export type Grouping = (typeof GROUPINGS)[number]

export function groupingOf(params: URLSearchParams): Grouping {
  const by = params.get('by')
  return by === 'state' || by === 'none' ? by : 'swarm'
}

/** The view a path names. Settings includes its section and what's open in it. */
export type Route =
  | { view: 'inbox' }
  | { view: 'cell'; cell: string }
  | { view: 'work' }
  | { view: 'operations' }
  | { view: 'channel'; channel: string }
  | { view: 'settings'; section: Section; open: string | null }
  | { view: 'missing' }

export function route(path: string): Route {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return { view: 'missing' }
  }
  if (decoded === '/') return { view: 'inbox' }
  if (decoded.startsWith('/cell/') && decoded.length > 6) return { view: 'cell', cell: decoded.slice(6) }
  if (decoded === '/work') return { view: 'work' }
  if (decoded === '/operations') return { view: 'operations' }
  if (decoded.startsWith('/c/') && decoded.length > 3) return { view: 'channel', channel: decoded.slice(3) }
  const [, settings, section, ...rest] = decoded.split('/')
  if (settings === 'settings' && (SECTIONS as readonly string[]).includes(section ?? 'access'))
    return { view: 'settings', section: (section ?? 'access') as Section, open: rest.join('/') || null }
  return { view: 'missing' }
}
