import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readRegistry, tagProblems } from '../src/tags.ts'

test('the checked-in registry has no malformed or duplicate entries', async () => {
  assert.deepEqual(tagProblems(await readRegistry()), [])
})

test('the tag check does not silently accept a duplicate tag', () => {
  const problems = tagProblems({
    tags: [
      { tag: 'abc', project: 'First' },
      { tag: 'abc', project: 'Second' },
    ],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /\babc\b/)
})

test('the tag check rejects uppercase, short, long, and digit-containing tags', () => {
  for (const tag of ['ABC', 'ab', 'abcd', 'ab1']) {
    assert.equal(tagProblems({ tags: [{ tag, project: 'Example' }] }).length, 1, tag)
  }
})
