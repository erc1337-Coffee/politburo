import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ROUTES, ModelRouteError, parseModelRoutes, readModelRoutes } from '../src/model-routes.ts'

const party = `
party:
  id: test
tiers:
  models:
    sprite:
      routes:
        - label: Claude Sonnet (Max)
          provider: anthropic
          model: claude-sonnet
        - label: Kimi (OpenRouter)
          provider: openrouter
          model: moonshotai/kimi
      thinking: medium
`

test('reads the routes of a party file in order', () => {
  assert.deepEqual(parseModelRoutes(party), [
    { label: 'Claude Sonnet (Max)', provider: 'anthropic', model: 'claude-sonnet' },
    { label: 'Kimi (OpenRouter)', provider: 'openrouter', model: 'moonshotai/kimi' },
  ])
})

test('uses the default routes without a party file or without routes in it', () => {
  assert.deepEqual(readModelRoutes(null), DEFAULT_ROUTES)
  assert.deepEqual(parseModelRoutes('party:\n  id: test\n'), DEFAULT_ROUTES)
})

test('refuses malformed routes with the field that is wrong', () => {
  const cases: Array<[string, RegExp]> = [
    ['tiers: { models: { sprite: { routes: [] } } }', /routes: non-empty list expected/],
    ['tiers: { models: { sprite: { routes: [{ label: a, provider: b }] } } }', /routes\[0\]\.model: non-empty string expected/],
    ['tiers: { models: { sprite: { routes: [{ label: a, provider: b, model: c, extra: d }] } } }', /routes\[0\]\.extra: unknown setting/],
    ['tiers: [', /not valid YAML/],
  ]
  for (const [source, message] of cases) assert.throws(() => parseModelRoutes(source), (error: unknown) => error instanceof ModelRouteError && message.test(error.message))
})

test('the routes command prints the routes of a party file as JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-routes-'))
  const file = join(directory, 'party.yaml')
  writeFileSync(file, party)
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'routes', '--party', file], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), parseModelRoutes(party))
})
