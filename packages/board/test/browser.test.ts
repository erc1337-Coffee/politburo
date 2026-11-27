import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { idempotentId } from 'experimental-a2'
import { build } from 'tsdown'
import { describe, expect, it, vi } from 'vitest'
import { http } from '../src/backend-http/index.default.ts'
import { derivedId } from '../src/client/ids.ts'
import { board } from '../src/server/index.default.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, testBoard } from './harness.ts'

/** Node's built-in modules, by either name, as an import or a re-export of one. */
const NODE = /\b(?:from|import)\s*\(?\s*["'](?:node:[\w/]+|(?:fs|path|os|crypto|child_process|http|https|net|dns|util|async_hooks|stream|url|module|worker_threads)(?:\/[\w/]+)?)["']/

/** What a bundle of `files` brings along from Node, file by file. */
async function nodeImports(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const name of await readdir(dir, { recursive: true }))
    if (/\.(m?js)$/.test(name)) {
      const match = (await readFile(join(dir, name), 'utf8')).match(NODE)
      if (match) found.push(`${name}: ${match[0]}`)
    }
  return found
}

/**
 * `lines`, bundled for a browser as a page's bundler would: inside the package, so `@vercel/board`
 * resolves to itself through its exports, with a browser's conditions. Each file's text, by name.
 */
async function bundle(lines: string[], check: (dir: string, files: Record<string, string>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'board-browser-'))
  const entry = join(import.meta.dirname, `.browser-entry-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
  await writeFile(entry, lines.join('\n'))
  try {
    await build({
      config: false,
      entry: { app: entry },
      outDir: dir,
      platform: 'browser',
      format: 'esm',
      dts: false,
      clean: false,
      logLevel: 'silent',
      deps: { alwaysBundle: [/.*/], onlyBundle: false },
    })
    const names = (await readdir(dir)).filter((name) => /\.m?js$/.test(name))
    expect(names.length).toBeGreaterThan(0)
    await check(dir, Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), 'utf8')] as const))))
  } finally {
    await rm(entry, { force: true })
    await rm(dir, { recursive: true, force: true })
  }
}

describe('board() in a browser', () => {
  it('bundles board({ backend }) and nothing from Node, as a browser resolves the package', async () => {
    await bundle(
      [
        "import { board, type Backend } from '@vercel/board'",
        "const elsewhere = { routes: [], keeps: false, bind() {} } as unknown as Backend",
        "export const team = board({ backend: elsewhere })",
        "export const posted = (text: string) => team.as('page').post('dev', text)",
      ],
      async (dir, files) => {
        expect(await nodeImports(dir)).toEqual([])
        // It's the default build it bundled: nothing finds a board in the environment, or verifies a token.
        const all = Object.values(files).join('\n')
        expect(all).not.toMatch(/env\s*(?:\.\s*BOARD_TOKEN|\[\s*["'`]BOARD_TOKEN)/)
        expect(all).not.toContain('jwtVerify')
        // Nor A2: a handle on a board elsewhere never loads the engine local() runs on.
        expect(all).not.toContain('contract name must be a non-empty string')
        expect(all).not.toContain('reducer name must be a non-empty string')
        expect(all).not.toContain('createRemoteJWKSet')
      },
    )
  }, 60_000)

  it("is what the inspector's page runs on, built for a browser", async () => {
    const page = await readFile(join(import.meta.dirname, '../dist/inspect/app.js'), 'utf8')
    expect(page.match(NODE)).toBeNull()
  })

  it("derives the engine's IDs exactly as A2's idempotentId does, so logs that hold them still dedupe", async () => {
    // The engine's write IDs: a prefix, the trigger, and the write's index.
    const cases = [
      ['board-inbound', 'watch:C1|100', '0'],
      ['board-inbound', 'vercel/board#216|comment:1', '3'],
      ['board-inbound', 'ünïcode "quoted" \\ back', '1'],
      [],
    ]
    for (const parts of cases) expect(await derivedId(...parts)).toBe(await idempotentId(...parts))
    // And the IDs themselves, so neither can drift with the other.
    expect(await derivedId('board-inbound', 'item', '0')).toBe('e59bd880-c200-8231-ba81-8507170897d2')
  })
})

const pageToken = () => deploymentToken('page', 'prj_page', 'production')

describe('a board on another one, on the internal http() of the default build', () => {
  it('runs its watchers here, following the board it uses', async () => {
    const team = testBoard()
    await team.createGrant({ principals: [{ kind: 'project', project: 'prj_page', environments: ['production'] }], can: { '*': 'all' } })
    const reads: string[] = []
    const backend = http(BOARD_URL, {
      fetch: bearer((input, init) => {
        const request = new Request(input, init)
        if (new URL(request.url).pathname.endsWith('/events')) reads.push(request.url)
        return team.fetch(request)
      }, pageToken),
    })
    const seen: string[] = []
    const page = board({ backend, watch: { seen: { tail: 'support', run: ({ event }) => void (event.message && seen.push(event.message.text)) } } })
    const julian = caller(team.fetch, await personToken('u_julian'), {})
    try {
      await page.as('deploys').me()
      await vi.waitFor(() => expect(reads.length).toBeGreaterThan(0))
      await julian('POST', '/messages', { channel: 'support', text: 'looking into it' })
      await vi.waitFor(() => expect(seen).toEqual(['looking into it']), { timeout: 5_000 })
      // It registered nothing on the team's board.
      expect((await caller(team.fetch, await pageToken())('GET', '/watchers')).body.watchers).toEqual([])
    } finally {
      backend.close()
    }
  })
})
