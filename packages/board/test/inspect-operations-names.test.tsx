// @vitest-environment happy-dom
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Operations } from '../src/inspect/app/operations-view.tsx'

let root: Root | undefined

afterEach(() => {
  root?.unmount()
  root = undefined
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

const ORCHESTRATOR = 'local:user:ada+orchestrator'
const now = Date.now()
const snapshot = {
  at: now, started_at: now - 60_000, last_seq: 0,
  board: { reachable: true, paused: false, error: null },
  orchestrator: { status: 'serving', reason: null, actor: ORCHESTRATOR, live: 1, live_limit: 4, outbox: 0, sweep_seconds: 30, last_tick: null, ticks_last_minute: 0 },
  relay: { host: 'relay.example.com', reachable: true, latency_ms: 12, checked_at: now, error: null, statistics: null },
  attempts: [{
    attempt_id: 'a1', task_id: '105', attempt_no: 1, channel: 'w1', board_channel: 'dev', repository: 'acme/web', branch: 'task-105',
    state: 'running', outcome: null, round: 1, created_at: now, launched_at: now, last_contact_at: now, question_at: null, watchdog_due: null,
    cost_usd: 0, pr_url: null, heartbeat: null, progress: {}, messages: { commands: 0, telemetry: 0, last_at: null },
  }],
}

// Only the inspector's own operations reads are faked: the orchestrator's state, and nothing else yet.
function orchestratorAnswers() {
  vi.stubGlobal('fetch', async (input: string | URL) =>
    String(input).endsWith('/api/operations/state') ? Response.json(snapshot) : new Response('{}', { status: 503 }))
}

async function show(identities: Parameters<typeof Operations>[0]['identities']) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  flushSync(() => root!.render(<Operations identities={identities} />))
  await vi.waitFor(() => expect(document.body.textContent).toContain('relay.example.com'))
  return document.body
}

it('names the orchestrator, the relay and each worker as the board does', async () => {
  orchestratorAnswers()
  const page = await show({ [ORCHESTRATOR]: { name: 'Conductor', avatar: null }, relay: { name: 'Courier', avatar: null }, worker: { name: 'Builder', avatar: null } })
  const titles = [...page.querySelectorAll('.node-title, .ops-card-head h2')].map((el) => el.textContent)
  expect(titles).toEqual(expect.arrayContaining(['Conductor', 'Courier']))
  expect(page.querySelector('.node.worker .node-title')?.textContent).toContain('Builder · round 1')
})

it('keeps their own names when the board gives none', async () => {
  orchestratorAnswers()
  const page = await show({})
  const titles = [...page.querySelectorAll('.node-title, .ops-card-head h2')].map((el) => el.textContent)
  expect(titles).toEqual(expect.arrayContaining(['Orchestrator', 'Relay']))
  expect(page.querySelector('.node.worker .node-title')?.textContent).toContain('Worker · round 1')
})
