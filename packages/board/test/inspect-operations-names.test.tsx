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

// Each service's box, as it reads: its first line, its picture, then its details.
const box = (page: HTMLElement, node: string) => {
  const card = page.querySelector(`.node.${node} .ops-node`)!
  return {
    name: card.querySelector('.ops-node-name')?.textContent,
    picture: card.querySelector('.ops-node-head .avatar img')?.getAttribute('src') ?? card.querySelector('.ops-node-head .avatar')?.textContent ?? null,
    details: [...card.querySelectorAll('.ops-node-detail')].map((line) => line.textContent),
  }
}

// A 1×1 PNG.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

it('shows the orchestrator, the relay and each worker as boxes: picture and name first, details under them', async () => {
  orchestratorAnswers()
  const page = await show({ [ORCHESTRATOR]: { name: 'Conductor', avatar: PIXEL }, relay: { name: 'Courier', avatar: PIXEL }, worker: { name: 'Builder', avatar: PIXEL } })
  expect(page.querySelectorAll('.node.heart circle.frame, .node.relay circle.frame')).toHaveLength(0)
  expect(box(page, 'heart')).toEqual({ name: 'Conductor', picture: PIXEL, details: ['1/4 live'] })
  expect(box(page, 'relay')).toEqual({ name: 'Courier', picture: PIXEL, details: ['12 ms'] })
  expect(box(page, 'worker')).toEqual({ name: 'Builder', picture: PIXEL, details: ['running · #105 · round 1 · attempt 1', expect.stringMatching(/^web · task-105 · /)] })
  expect([...page.querySelectorAll('.ops-card-head h2')].map((h) => h.textContent)).toEqual(expect.arrayContaining(['Conductor', 'Courier']))
})

it('keeps their own names and initials when the board gives none', async () => {
  orchestratorAnswers()
  const page = await show({})
  expect([box(page, 'heart'), box(page, 'relay'), box(page, 'worker')].map(({ name, picture }) => ({ name, picture }))).toEqual([
    { name: 'Orchestrator', picture: 'O' },
    { name: 'Relay', picture: 'R' },
    { name: 'Worker', picture: 'W' },
  ])
})
