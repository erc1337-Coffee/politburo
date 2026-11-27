import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { decodeJwt } from 'jose'
import { BoardError, type ProfileOption, type Resolvable } from './client.ts'
import { configDir, savedJoinToken } from './join-config.ts'

export { configDir }

/**
 * A Git checkout's root: `.git` is a directory with a `HEAD`, or a worktree's
 * `gitdir:` file. A stray empty `.git` (say, in `~` or `/tmp`) isn't one.
 */
function isCheckout(directory: string): boolean {
  const git = join(directory, '.git')
  try {
    if (statSync(git).isDirectory()) return existsSync(join(git, 'HEAD'))
    return readFileSync(git, 'utf8').startsWith('gitdir:')
  } catch {
    return false
  }
}

/** The project `cwd` is in: its Git checkout's root, or `cwd` outside one. */
export function projectDir(cwd = process.cwd()): string {
  let directory = resolve(cwd)
  while (true) {
    if (isCheckout(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(cwd)
    directory = parent
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Where `vb serve` leaves the token for the board it runs at `url`: only this user can read it. */
export function localTokenFile(url: string): string {
  const normalized = url.replace(/\/+$/, '')
  return join(configDir(), 'local', `${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}.json`)
}

/** The token a local board on this machine left for you, if `url` is one. */
function localToken(url: string): { token: string } | null {
  try {
    if (!LOOPBACK.has(new URL(url).hostname)) return null
    const saved = JSON.parse(readFileSync(localTokenFile(url), 'utf8')) as { url?: string; token?: string }
    if (saved.url !== url.replace(/\/+$/, '') || typeof saved.token !== 'string') return null
    return { token: saved.token }
  } catch {
    return null
  }
}

/** When `token` expires, in milliseconds: its `exp`, or five minutes from now for one that says none. */
export const expiry = (token: string): number => {
  try {
    const { exp } = decodeJwt(token)
    return exp ? exp * 1000 : Date.now() + 5 * 60_000
  } catch {
    return Date.now() + 5 * 60_000
  }
}

/** The board the environment points at: `BOARD_URL`. */
export function boardUrl(): string {
  const url = process.env.BOARD_URL?.replace(/\/+$/, '')
  if (!url) throw new BoardError('no_board', "There's no board URL: BOARD_URL isn't set.", 0, { hint: 'Set BOARD_URL, or pass the URL to http().' })
  return url
}

/** Invite redemption must not use the normal credential. */
export function redeemFetch(input: RequestInfo | URL, init: RequestInit = {}, send: typeof fetch = globalThis.fetch): Promise<Response> {
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  for (const name of ['authorization', 'cookie', 'x-board-profile', 'x-board-can']) headers.delete(name)
  return send(input, { ...init, headers, credentials: 'omit', redirect: 'error' })
}

/** Where `vb whoami` says a saved join credential came from. */
export const JOINED = 'vb join'

/** How `vb` reaches a board from Node: a fetch that carries your credentials, and who it found you are. */
export type NodeTransport = {
  /** Every request to the board, with a token for it (all but discovery). */
  fetch: typeof fetch
  /** Where the token came from, in words, once one was found: `BOARD_TOKEN`, `vb serve`, … */
  source(): string | null
}

/**
 * How a client reaches the board at `url` from Node: with a token from `token`, `BOARD_TOKEN`, a
 * local board's token file (`vb serve`), or a joined board's credential (`vb join`), in that order.
 * Who you are is the token's to say: the board names you from what it verifies. With none of them,
 * a request goes with no token, for the board to say whose it is.
 */
export function connect(
  url: string,
  options: { token?: Resolvable<string> | undefined; fetch?: typeof fetch | undefined } = {},
): NodeTransport {
  url = url.replace(/\/+$/, '')
  const rawFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const doFetch: typeof fetch = (input, init = {}) => through(rawFetch, input, init)
  const joinedFetch: typeof fetch = (input, init) => rawFetch(input, { ...init, redirect: init?.redirect === 'manual' ? 'manual' : 'error' })

  /** A token to send, or null where none is found: its requests go without one. */
  type Found = { token: string | null; expiresAt: number }
  let cached: Found | null = null
  let source: string | null = null
  // `source` says which of these it picked, for `vb whoami`.
  const find = async (): Promise<Found> => {
    if (options.token !== undefined) {
      const token = typeof options.token === 'function' ? await options.token() : options.token
      return { token, expiresAt: expiry(token) }
    }
    if (process.env.BOARD_TOKEN) {
      const token = process.env.BOARD_TOKEN
      source = 'BOARD_TOKEN'
      return { token, expiresAt: expiry(token) }
    }
    const local = localToken(url)
    if (local) {
      source = 'vb serve'
      return { token: local.token, expiresAt: expiry(local.token) }
    }
    const joined = await savedJoinToken(url)
    if (joined) {
      source = JOINED
      return { token: joined, expiresAt: Infinity }
    }
    return { token: null, expiresAt: Date.now() + 5 * 60_000 }
  }
  const token = async () => {
    // One handed over is asked again each time: a function returns a fresh one.
    if (options.token !== undefined || !cached || cached.expiresAt - 60_000 < Date.now()) cached = await find()
    return cached.token
  }

  const send = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = input instanceof Request ? input.url : String(input)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'POST' && href === `${url}/invites/redeem`) return redeemFetch(input, init, rawFetch)
    const path = (href.startsWith(url) ? href.slice(url.length) : new URL(href).pathname).split('?')[0] || '/'
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    // Discovery is public: it needs no credential.
    const publicRead = method === 'GET' && path === '/'
    let bare = false
    let joined = false
    if (!publicRead && !headers.has('authorization')) {
      const credential = await token()
      if (credential !== null) headers.set('authorization', `Bearer ${credential}`)
      else bare = true
      joined = source === JOINED
    } else if (publicRead && options.token === undefined && !process.env.BOARD_TOKEN && !localToken(url)) {
      joined = source === JOINED || (await savedJoinToken(url)) !== null
    }
    // A joined credential is only for this board, and never follows redirects.
    const response = await (joined ? joinedFetch : doFetch)(input, { ...init, headers })
    // It went with no token, and the board took it for no one's.
    if (bare && response.status === 401) {
      await response.body?.cancel().catch(() => {})
      throw new BoardError('no_token', `The board at ${url} doesn't know who you are without a token.`, 0, {
        hint: 'Pass a token it accepts in BOARD_TOKEN.',
      })
    }
    return response
  }) as typeof fetch

  return { fetch: send, source: () => source }
}

/**
 * The profile the environment names: `BOARD_PROFILE`, with `BOARD_AVATAR`. Nothing else picks one, a coding
 * agent included: without it, you write as yourself.
 */
export function environmentProfile(): ProfileOption {
  const name = process.env.BOARD_PROFILE
  const avatar = process.env.BOARD_AVATAR
  return name ? (avatar ? { name, avatar } : name) : null
}

/** `location` against `base`, or null when it isn't a URL. */
function urlOf(location: string, base: string): URL | null {
  try {
    return new URL(location, base)
  } catch {
    return null
  }
}

/**
 * One request, with its redirects followed as fetch would for a GET or HEAD, dropping the token on
 * the way to another origin; a redirected POST comes back as its 3xx, and so does any redirect a
 * caller asked to handle itself (`redirect: 'manual'`).
 */
async function through(doFetch: typeof fetch, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  let target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  let headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  for (let hops = 0; ; hops++) {
    const response = await doFetch(hops === 0 ? input : target, { ...init, headers, redirect: 'manual' })
    const redirected = response.status >= 300 && response.status < 400
    // A caller that asked for the redirect itself (a claim's request, which goes nowhere else) gets it back before anything reads it.
    if (redirected && init.redirect === 'manual') return response
    const location = redirected ? response.headers.get('location') : null
    // A `Location` that isn't a URL goes nowhere: the 3xx comes back as it is.
    const next = location ? urlOf(location, target) : null
    if (!location || !next || (method !== 'GET' && method !== 'HEAD')) return response
    if (hops >= 20) throw new BoardError('too_many_redirects', `${target} redirected more than 20 times.`, response.status)
    if (next.origin !== new URL(target).origin) {
      headers = new Headers(headers)
      headers.delete('authorization')
    }
    target = next.href
  }
}
