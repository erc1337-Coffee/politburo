import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openLedger, readLedger, rollupBy, type Envelope, type SpendRecord } from '../src/index.ts'

const envelope: Envelope = {
  party: 'default', repo: 'owner/repo', work_id: 'task-1', attempt: 'a1', tier: 'mob', parent: null, session: 's1',
  trace: { id: 'c1', execution_id: 'a1' },
}
const record: SpendRecord = {
  record_id: 'c1:r1:m0', revises: null, dedupe_key: 'worker-result:c1:r1:p/m', envelope, source: 'worker-result',
  source_version: '1', source_event_key: 'c1:r1:m0', evidence_ref: 'relay:c1:result:1', provider: 'p', requested_route: 'p/m',
  actual_model: 'm', auth_class: null, occurred: '2026-11-26T10:00:00.000Z', received: '2026-11-26T10:00:00.000Z',
  started: null, ended: null, status: 'completed', exit_reason: 'completed',
  tokens: { input_uncached: 10, input_total: null, output: 5, cache_read: null, cache_write: null, reasoning: null },
  amount: { value: '0.5', unit: 'USD' }, basis: 'priced_estimate',
  coverage: {
    state: 'partial',
    field_quality: {
      'tokens.input_uncached': 'provider_reported', 'tokens.input_total': 'unknown', 'tokens.output': 'provider_reported',
      'tokens.cache_read': 'unknown', 'tokens.cache_write': 'unknown', 'tokens.reasoning': 'unknown', amount: 'priced_estimate',
    },
  },
}

test('reads a closed ledger from a read-only directory and rolls it up', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-read-'))
  const directory = join(root, 'ledger')
  mkdirSync(directory)
  const file = join(directory, 'ledger.sqlite')
  try {
    const writer = openLedger(file, { journal: 'rollback' })
    writer.createDispatch({ envelope, sponsor: null, created: '2026-11-26T10:00:00.000Z' })
    assert.equal(writer.append(record).outcome, 'appended')
    writer.close()
    assert.deepEqual(readdirSync(directory), ['ledger.sqlite'], 'the writer leaves no journal file behind')
    chmodSync(directory, 0o555)
    const snapshot = readLedger(file)
    assert.equal(snapshot.dispatches().length, 1)
    assert.equal(snapshot.heads()[0]!.envelope?.work_id, 'task-1')
    const [row] = rollupBy(snapshot, 'work_id')
    assert.deepEqual(row!.totals.amounts, [{ basis: 'priced_estimate', unit: 'USD', known: '0.5', records: 1 }])
  } finally {
    chmodSync(directory, 0o755)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a reader waits for the writer to close, and a writer waits for a reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-read-'))
  const file = join(root, 'ledger.sqlite')
  try {
    openLedger(file, { journal: 'rollback' }).close()
    const writer = openLedger(file, { journal: 'rollback' })
    assert.throws(() => readLedger(file, 50), 'the writer holds the file while open')
    writer.close()
    assert.equal(readLedger(file).dispatches().length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses a file that is not a ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-read-'))
  try {
    assert.throws(() => readLedger(join(root, 'missing.sqlite')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
