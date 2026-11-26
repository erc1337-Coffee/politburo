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

// Only the inspector's own operations reads are faked: the orchestrator's state and its event stream.
function orchestratorAnswers(state: object = snapshot, events = '') {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('/api/operations/state')) return Response.json(state)
    if (url.endsWith('/api/operations/events') && events) return new Response(events, { headers: { 'content-type': 'text/event-stream' } })
    return new Response('{}', { status: 503 })
  })
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

type Segment = { x1: number; y1: number; x2: number; y2: number }
/** A link's straight pieces, from its path: only M, H, V and L, as the schematic draws them. */
function segments(d: string): Segment[] {
  const out: Segment[] = []
  let x = 0
  let y = 0
  for (const [, op, args] of d.matchAll(/([MHVL])\s*([-\d.,\s]+)/g)) {
    const n = args!.split(/[\s,]+/).filter(Boolean).map(Number)
    const next = op === 'H' ? { x: n[0]!, y } : op === 'V' ? { x, y: n[0]! } : { x: n[0]!, y: n[1]! }
    if (op !== 'M') out.push({ x1: x, y1: y, x2: next.x, y2: next.y })
    ;({ x, y } = next)
  }
  return out
}
const between = (v: number, a: number, b: number) => v > Math.min(a, b) + 0.01 && v < Math.max(a, b) - 0.01
/** Whether a horizontal and a vertical piece pass through each other, not just meet at an end. */
const cross = (h: Segment, v: Segment) => h.y1 === h.y2 && v.x1 === v.x2 && between(v.x1, h.x1, h.x2) && between(h.y1, v.y1, v.y2)
const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)) > 0.01
/** Whether two pieces run along each other, so a reader can't tell the links apart. */
const along = (p: Segment, q: Segment) =>
  (p.x1 === p.x2 && q.x1 === q.x2 && p.x1 === q.x1 && overlap(p.y1, p.y2, q.y1, q.y2)) ||
  (p.y1 === p.y2 && q.y1 === q.y2 && p.y1 === q.y1 && overlap(p.x1, p.x2, q.x1, q.x2))

it('draws no two links across or along each other, however many workers there are', async () => {
  const workers = [0, 1, 2, 3].map((n) => ({ ...snapshot.attempts[0]!, attempt_id: `a${n}`, task_id: String(105 + n), channel: `w${n}` }))
  orchestratorAnswers({ ...snapshot, attempts: workers })
  const page = await show({})
  const links = [...page.querySelectorAll<SVGPathElement>('path.link:not(.launch)')].map((path) => ({ id: path.dataset.edge, pieces: segments(path.getAttribute('d')!) }))
  expect(links).toHaveLength(5 + workers.length * 2)
  const crossings: string[] = []
  for (const one of links) for (const other of links) {
    if (one === other) continue
    for (const p of one.pieces) for (const q of other.pieces) if (cross(p, q) || along(p, q)) crossings.push(`${one.id} × ${other.id}`)
  }
  expect(crossings).toEqual([])
})

it('keeps the orchestrator still when it ticks: no glow and no wave', async () => {
  orchestratorAnswers(snapshot, `data: ${JSON.stringify({ seq: 1, at: now, kind: 'tick', sources: ['timer'], live: 1, duration_ms: 3 })}\n\n`)
  const page = await show({})
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(page.querySelectorAll('.node.heart > :not(rect.frame, foreignObject, circle.led, title)')).toHaveLength(0)
  expect(page.querySelector('radialGradient')).toBeNull()
})
