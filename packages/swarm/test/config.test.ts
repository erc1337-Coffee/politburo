import assert from 'node:assert/strict'
import test from 'node:test'
import { stringify } from 'yaml'
import { ConfigError, defaultConfig, loadConfig, parseConfigText, validateConfig } from '../src/index.ts'

test('defaults are invalid or change through a JSON or YAML round trip', () => {
  const tree = defaultConfig()
  validateConfig(tree)
  assert.deepEqual(parseConfigText(JSON.stringify(tree)), tree)
  assert.deepEqual(parseConfigText(stringify(tree)), tree)
})

test('a misspelled party field is accepted or reported at the wrong path', () => {
  assert.throws(
    () => loadConfig({ party: { claims: { houres: 1 } } }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.field, 'claims.houres')
      return true
    },
  )
})

test('a non-integer claim duration is accepted or reported at the wrong path', () => {
  assert.throws(
    () => loadConfig({ party: { claims: { hours: 'invalid' } } }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.field, 'claims.hours')
      return true
    },
  )
})

test('layers apply out of order, append to an array, or drop untouched defaults', () => {
  const defaults = defaultConfig()
  const partyHours = defaults.claims.hours + 1
  const repoHours = partyHours + 1
  const partyCooldown = defaults.claims.reclaim_cooldown_minutes + 1
  const tree = loadConfig({
    party: {
      claims: { hours: partyHours, reclaim_cooldown_minutes: partyCooldown },
      names: { spawners: ['custom'] },
    },
    repo: { claims: { hours: repoHours } },
  })
  assert.equal(tree.claims.hours, repoHours)
  assert.equal(tree.claims.reclaim_cooldown_minutes, partyCooldown)
  assert.deepEqual(tree.names.spawners, ['custom'])
  assert.equal(tree.claims.pause_on_downtime, defaults.claims.pause_on_downtime)
  assert.deepEqual(tree.labels, defaults.labels)
})

test('a duplicate spawner name is accepted or reported outside its pool', () => {
  assert.throws(
    () => loadConfig({ party: { names: { spawners: ['custom', 'custom'] } } }),
    (error) => error instanceof ConfigError && /^names\.spawners(?:\.|$)/.test(error.field),
  )
})

test('mutating a returned name pool leaks into the next default tree', () => {
  const tree = defaultConfig()
  const names = [...tree.names.spawners]
  tree.names.spawners.length = 0
  assert.deepEqual(defaultConfig().names.spawners, names)
})
