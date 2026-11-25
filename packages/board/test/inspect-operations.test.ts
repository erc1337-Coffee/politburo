import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openLedger, type Envelope, type SpendRecord } from '@remilia/politburo-ledger'
import { createBoardClient } from '../src/client/client.ts'
import { route } from '../src/inspect/app/routes.ts'
import { summarizeUsage } from '../src/inspect/operations.ts'
import { startInspector, type Inspector } from '../src/inspect/server.ts'
import { serve } from './http.ts'
import { personToken, testBoard } from './harness.ts'

const envelope: Envelope = {
  party: 'default', repo: 'owner/repo', work_id: 'task-7', attempt: '00000000-0000-4000-8000-000000000001', tier: 'mob', parent: null,
  session: 's1', trace: { id: 'task-7-a1-x', execution_id: '00000000-0000-4000-8000-000000000001' },
}
const record = (id: string, occurred: string, cost: string | null, output: number | null): SpendRecord => ({
  record_id: id, revises: null, dedupe_key: `worker-result:${id}`, envelope, source: 'worker-result', source_version: '1',
  source_event_key: id, evidence_ref: `relay:${id}`, provider: 'openrouter', requested_route: 'openrouter/m', actual_model: 'm',
  auth_class: null, occurred, received: occurred, started: null, ended: null, status: 'completed', exit_reason: 'completed',
  tokens: { input_uncached: 100, input_total: null, output, cache_read: null, cache_write: null, reasoning: null },
  amount: cost === null ? null : { value: cost, unit: 'USD' }, basis: cost === null ? 'unknown' : 'priced_estimate',
  coverage: {
    state: 'partial',
    field_quality: {
      'tokens.input_uncached': 'provider_reported', 'tokens.input_total': 'unknown', 'tokens.output': output === null ? 'unknown' : 'provider_reported',
      'tokens.cache_read': 'unknown', 'tokens.cache_write': 'unknown', 'tokens.reasoning': 'unknown', amount: cost === null ? 'unknown' : 'priced_estimate',
    },
  },
})

let directory: string
let ledgerFile: string
let orchestrator: Server
let inspector: Inspector
let boardServer: Awaited<ReturnType<typeof serve>>
let token: string
const now = Date.now()

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'inspect-operations-'))
  ledgerFile = join(directory, 'ledger.sqlite')
  const ledger = openLedger(ledgerFile, { journal: 'rollback' })
  ledger.createDispatch({ envelope, sponsor: null, created: new Date(now - 7_200_000).toISOString() })
  ledger.append(record('r1', new Date(now - 60_000).toISOString(), '0.1', 50))
  ledger.append(record('r2', new Date(now - 30_000).toISOString(), '0.2', 70))
  ledger.append(record('r3', new Date(now - 20_000).toISOString(), null, null))
  ledger.close()

  orchestrator = createServer((request, response) => {
    if (request.url === '/state') return void response.writeHead(200, { 'content-type': 'application/json' }).end('{"last_seq":3,"attempts":[]}')
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`id: 4\ndata: {"seq":4,"after":"${request.headers['last-event-id'] ?? ''}"}\n\n`)
      return
    }
    response.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => orchestrator.listen(0, '127.0.0.1', resolve))
  boardServer = await serve(testBoard({ url: undefined }).fetch)
  const url = `${boardServer.origin}/api/board`
  const client = createBoardClient({ url, token: await personToken('u_julian', url), profile: null })
  inspector = await startInspector({
    client, port: 0,
    operations: { url: `http://127.0.0.1:${(orchestrator.address() as AddressInfo).port}`, ledgerFile },
  })
  const page = await (await fetch(`${inspector.url}/`)).text()
  token = /<meta name="inspect-token" content="([^"]+)">/.exec(page)![1]!
})

afterAll(async () => {
  await inspector.close()
  boardServer.close()
  orchestrator.closeAllConnections()
  orchestrator.close()
  rmSync(directory, { recursive: true, force: true })
})

const operations = (path: string, init: RequestInit = {}, withToken = true) =>
  fetch(`${inspector.url}/api/operations/${path}`, { ...init, headers: { ...(withToken ? { 'x-inspect-token': token } : {}), ...(init.headers as Record<string, string> ?? {}) } })

describe('operations view', () => {
  it('has its own route', () => {
    expect(route('/operations')).toEqual({ view: 'operations' })
  })

  it("answers only the page's token, and only reads", async () => {
    expect((await operations('state', {}, false)).status).toBe(403)
    expect((await operations('state', { headers: { 'x-inspect-token': 'wrong' } }, false)).status).toBe(403)
    expect((await operations('state', { method: 'POST', body: '{}' })).status).toBe(405)
    expect((await operations('nothing')).status).toBe(404)
  })

  it("forwards the orchestrator's state and events", async () => {
    const state = await operations('state')
    expect(state.status).toBe(200)
    expect(await state.json()).toEqual({ last_seq: 3, attempts: [] })
    const controller = new AbortController()
    const events = await operations('events', { headers: { 'last-event-id': '3' }, signal: controller.signal })
    expect(events.headers.get('content-type')).toContain('text/event-stream')
    const reader = events.body!.getReader()
    const { value } = await reader.read()
    controller.abort()
    expect(new TextDecoder().decode(value)).toContain('"after":"3"')
  })

  it('sums usage from the ledger, and counts unknown records apart', async () => {
    const answer = await operations('usage')
    expect(answer.status).toBe(200)
    const usage = await answer.json()
    expect(usage.available).toBe(true)
    expect(usage.last_hour).toEqual({ records: 3, input_tokens: 300, output_tokens: 120, cost_usd: '0.3', unknown_records: 1 })
    expect(usage.by_attempt[0].attempt).toBe(envelope.trace.execution_id)
    expect(usage.by_model[0].model).toBe('openrouter/m')
    expect(usage.hourly).toHaveLength(24)
    expect(usage.hourly.reduce((sum: number, slot: { cost_usd: string }) => sum + Number(slot.cost_usd), 0)).toBeCloseTo(0.3)
  })

  it('says when the ledger has no file yet', async () => {
    await expect(summarizeUsage(join(directory, 'missing.sqlite'))).rejects.toThrow()
  })
})
