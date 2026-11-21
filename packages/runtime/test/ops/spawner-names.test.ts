import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextSpawnerName, spawnerNames, spawnerTitle } from '../../src/ops/spawner-names.ts'

const expectedNames = [
  'ZAVOD', 'FABRIKA', 'KOMBINAT', 'KOLKHOZ', 'SOVKHOZ',
  'ARTEL', 'SHAKHTA', 'TSEKH', 'DOMNA', 'KOTLOVAN',
  'PRORAB', 'BRIGADIR', 'MASTER', 'NARKOM', 'UDARNIK', 'TREST', 'GLAVK',
  'GOSPLAN', 'NORMA', 'SMENA', 'OTDEL',
  'MOLOT', 'SERP', 'TRAKTOR', 'TURBINA', 'KRAN', 'STAL', 'GUDOK',
  'MAGNITKA', 'URALMASH', 'ZIL', 'GAZ', 'KAMAZ',
]

test('spawnerNames lists unique uppercase ASCII names in allocation order', () => {
  assert.equal(new Set(spawnerNames).size, spawnerNames.length)
  for (const name of spawnerNames) assert.match(name, /^[A-Z]{1,8}$/)
  assert.deepEqual(spawnerNames, expectedNames)
})

test('nextSpawnerName starts at ZAVOD and follows the order as earlier names are taken', () => {
  for (const [index, name] of expectedNames.entries()) {
    assert.equal(nextSpawnerName(expectedNames.slice(0, index)), name, `${index} names in use`)
  }
})

test('nextSpawnerName skips used names even when they are not a prefix', () => {
  const inUse = new Set(['ZAVOD', 'KOMBINAT'])
  assert.equal(nextSpawnerName(inUse), 'FABRIKA')
  assert.deepEqual(inUse, new Set(['ZAVOD', 'KOMBINAT']))
  inUse.add('FABRIKA')
  assert.equal(nextSpawnerName(inUse), 'KOLKHOZ')
})

test('nextSpawnerName accepts a one-shot iterable', () => {
  assert.equal(nextSpawnerName(['ZAVOD', 'FABRIKA'].values()), 'KOMBINAT')
})

test('nextSpawnerName takes the first name again once it is freed', () => {
  const inUse = new Set(['ZAVOD', 'FABRIKA'])
  assert.equal(nextSpawnerName(inUse), 'KOMBINAT')
  inUse.delete('ZAVOD')
  assert.equal(nextSpawnerName(inUse), 'ZAVOD')
})

test('nextSpawnerName ignores unknown strings, including other spellings of pool names', () => {
  const inUse = ['UNKNOWN', 'zavod', ' ZAVOD', 'ZAVOD ']
  assert.equal(nextSpawnerName(inUse), 'ZAVOD')
  assert.equal(nextSpawnerName([...inUse, 'ZAVOD']), 'FABRIKA')
})

test('nextSpawnerName reports exhaustion when every name is in use', () => {
  assert.throws(() => nextSpawnerName(expectedNames), Error)
  assert.throws(() => nextSpawnerName([...expectedNames, 'UNKNOWN']), Error)
  assert.equal(nextSpawnerName(expectedNames.slice(1)), 'ZAVOD')
})

test('the pool cannot be reordered by a caller', () => {
  assert.throws(() => (spawnerNames as unknown as string[]).sort())
  assert.equal(nextSpawnerName([]), 'ZAVOD')
})

test('spawnerTitle joins a valid tag and name with a space', () => {
  assert.equal(spawnerTitle('RW', 'ZAVOD'), 'RW ZAVOD')
  assert.equal(spawnerTitle('rw-2', 'KAMAZ'), 'rw-2 KAMAZ')
})

test('spawnerTitle rejects empty tags and tags containing whitespace', () => {
  for (const tag of ['', ' ', '\t', ' RW', 'RW ', 'R W', 'R\tW', 'R\nW', 'R\u00a0W', 'R\u0085W']) {
    assert.throws(() => spawnerTitle(tag, 'ZAVOD'), RangeError, JSON.stringify(tag))
  }
})

test('spawnerTitle rejects names outside the pool', () => {
  for (const name of ['', 'zavod', ' ZAVOD', 'ZAVOD ', 'UNKNOWN']) {
    assert.throws(() => spawnerTitle('RW', name), RangeError, JSON.stringify(name))
  }
})
