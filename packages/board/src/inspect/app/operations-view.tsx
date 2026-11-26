// /operations: a live schematic of the board, the orchestrator, the relay and the cloud workers, with
// the spend ledger and each component's details in a side panel. Each message travels its link as a
// packet and tints the link while it travels; the orchestrator ripples on each tick; a worker's lamp
// pulses on each heartbeat. At rest nothing moves.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { base } from './nav.tsx'
import { Header } from './ui.tsx'

// --- what the orchestrator and the ledger answer ---------------------------------------------

type WakeSource = 'start' | 'board' | 'telemetry' | 'timer' | 'sweep' | 'request'
type OpsEvent = { seq: number; at: number } & (
  | { kind: 'tick'; sources: WakeSource[]; live: number; duration_ms: number }
  | { kind: 'command'; channel: string; task: string; type: string; bytes: number; outcome: 'sent' | 'failed' }
  | { kind: 'telemetry'; channel: string; task: string; type: string; bytes: number; relay_seq: number }
  | { kind: 'board'; action: string; task: string; channel?: string }
  | { kind: 'github'; action: 'push' | 'draft_pr'; repository: string; task: string; channel: string }
  | { kind: 'launch'; task: string; channel: string; outcome: string }
  | { kind: 'attempt'; attempt: string; task: string; channel: string; state: string }
  | { kind: 'fault'; component: string; code: string; task?: string; channel?: string }
  | { kind: 'usage'; task: string; channel: string; round: number; models: number; input_tokens: number; output_tokens: number; cost_usd: number }
)
type AttemptView = {
  attempt_id: string; task_id: string; attempt_no: number; channel: string; board_channel: string; repository: string; branch: string
  state: string; outcome: string | null; round: number; created_at: number; launched_at: number | null; last_contact_at: number | null
  question_at: number | null; watchdog_due: number | null; cost_usd: number; pr_url: string | null
  heartbeat: { at: number; state: string; round: number; elapsed_seconds: number; pi_alive: boolean } | null
  progress: Record<string, number>; messages: { commands: number; telemetry: number; last_at: number | null }
}
type DirectionStatistics = { messages: number; bytes: number; last_seq: number; last_at: number | null; streams: number }
type Snapshot = {
  at: number; started_at: number
  board: { reachable: boolean | null; paused: boolean | null; error: string | null }
  orchestrator: { status: 'serving' | 'idle'; reason: string | null; actor: string; live: number; live_limit: number; outbox: number; sweep_seconds: number; last_tick: { at: number; sources: WakeSource[]; duration_ms: number } | null; ticks_last_minute: number }
  relay: { host: string; reachable: boolean | null; latency_ms: number | null; checked_at: number | null; error: string | null
    statistics: { started_at: number; channels: Record<string, { commands: DirectionStatistics; telemetry: DirectionStatistics }>; refused: Record<string, number> } | null }
  attempts: AttemptView[]
  last_seq: number
}
type Figures = { records: number; input_tokens: number; output_tokens: number; cost_usd: string; unknown_records: number }
type Usage = {
  available: boolean; error: string | null; last_hour: Figures; today: Figures; total: Figures
  by_attempt: Array<{ attempt: string; work_id: string | null; figures: Figures }>
  by_model: Array<{ model: string; figures: Figures }>
  hourly: Array<{ hour: number; cost_usd: string; output_tokens: number }>
}

const token = () => document.querySelector<HTMLMetaElement>('meta[name="inspect-token"]')?.content ?? ''
const api = (path: string) => `${location.origin}${base}/api/operations/${path}`
/** The server issues a new page token each time it starts: a page from before then reloads itself, at most once a minute. */
function reloadOnStaleToken(status: number) {
  if (status !== 403) return
  try {
    const last = Number(sessionStorage.getItem('operations-reloaded-at') ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem('operations-reloaded-at', String(Date.now()))
  } catch { return }
  location.reload()
}
async function read<T>(path: string): Promise<T> {
  const response = await fetch(api(path), { headers: { 'x-inspect-token': token() } })
  if (!response.ok) {
    reloadOnStaleToken(response.status)
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `status ${response.status}`)
  }
  return response.json() as Promise<T>
}

/** Follows the orchestrator's events, resuming after the last one it saw. */
function followEvents(onEvent: (event: OpsEvent) => void, onReset: () => void, onLive: (live: boolean) => void): () => void {
  let stopped = false
  let last: number | null = null
  let controller: AbortController | null = null
  const run = async () => {
    while (!stopped) {
      controller = new AbortController()
      try {
        const response = await fetch(api('events'), {
          headers: { 'x-inspect-token': token(), ...(last !== null ? { 'last-event-id': String(last) } : {}) },
          signal: controller.signal,
        })
        if (!response.ok || !response.body) { reloadOnStaleToken(response.status); throw new Error(`status ${response.status}`) }
        onLive(true)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            if (/^event: reset$/m.test(frame)) { onReset(); continue }
            const data = /^data: (.*)$/m.exec(frame)?.[1]
            if (!data) continue
            try {
              const event = JSON.parse(data) as OpsEvent
              last = event.seq
              onEvent(event)
            } catch { /* a frame that is not an event */ }
          }
        }
      } catch { /* reconnect below */ }
      onLive(false)
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
  }
}

// --- layout -------------------------------------------------------------------------------

const WIDTH = 960
const TOP = 46
const ROW = 74
const SHOWN_WORKERS = 8
const COLUMN = { lan: 0, relay: 420, cloud: 560 }
const BOX = { x: 36, w: 156, h: 58 }
const HEART_R = 46
const RELAY_R = 32
const ORCHESTRATOR_X = 304
const RELAY_X = 490
const WORKER = { x: 588, w: 352, h: 58 }

type Kind = 'command' | 'telemetry' | 'question' | 'result' | 'external' | 'usage'
const COLOR: Record<Kind, string> = {
  command: 'var(--ops-command)', telemetry: 'var(--ops-telemetry)', question: 'var(--warning)',
  result: 'var(--ops-result)', external: 'var(--ops-external)', usage: 'var(--ops-command)',
}
const LEGEND: Array<[Kind, string]> = [['command', 'command'], ['telemetry', 'telemetry'], ['question', 'question'], ['result', 'result'], ['external', 'board / GitHub']]
const BEAT: Record<WakeSource, string> = {
  start: 'var(--bright)', board: 'var(--ops-external)', telemetry: 'var(--ops-telemetry)', timer: 'var(--ops-command)', sweep: 'var(--muted)', request: 'var(--muted)',
}

type Packet = { edge: string; kind: Kind; size: number; ring: boolean; started: number; duration: number; label: string; then?: Omit<Packet, 'started'> }
type Point = { x: number; y: number }

const usd = (value: string | number) => {
  const number = typeof value === 'number' ? value : Number(value)
  return `$${number.toFixed(2)}`
}
const tokens = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value)
const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`
}
const ago = (now: number, at: number | null) => at === null ? 'never' : now - at < 1000 ? 'now' : `${span(now - at)} ago`
const clock = (at: number | null) => at === null ? '—' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const clip = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text
const words = (state: string) => state.replaceAll('_', ' ')
const onCircle = (c: Point, r: number, degrees: number): Point => ({ x: c.x + r * Math.cos((degrees * Math.PI) / 180), y: c.y + r * Math.sin((degrees * Math.PI) / 180) })
/** A link of straight segments: across, then up or down at a right angle halfway, then across. */
const curve = (a: Point, b: Point, bend = 0) => {
  const mx = Math.round((a.x + b.x) / 2) + bend
  return Math.abs(a.y - b.y) < 0.5
    ? `M${a.x.toFixed(1)},${a.y.toFixed(1)} H${b.x.toFixed(1)}`
    : `M${a.x.toFixed(1)},${a.y.toFixed(1)} H${mx} V${b.y.toFixed(1)} H${b.x.toFixed(1)}`
}
/** How long a packet takes along one link, slow enough to read its label. */
const PACKET_MS = 2_400
const LIVE = new Set(['claimed', 'launching', 'awaiting_contact', 'running', 'waiting_answer', 'deciding', 'publishing', 'stopping'])

function packetsOf(event: OpsEvent): Array<Omit<Packet, 'started'>> {
  const chain = (edges: string[], kind: Kind, label: string, size = 3, ring = false): Array<Omit<Packet, 'started'>> => {
    let next: Omit<Packet, 'started'> | undefined
    for (const edge of [...edges].reverse()) next = { edge, kind, size, ring, duration: PACKET_MS, label, ...(next ? { then: next } : {}) }
    return next ? [next] : []
  }
  switch (event.kind) {
    case 'command': return event.outcome === 'sent' ? chain(['orchestrator>relay', `relay>${event.channel}`], event.type === 'answer' ? 'question' : 'command', words(event.type)) : []
    case 'telemetry': {
      if (event.type === 'heartbeat') return chain([`${event.channel}>relay`, 'relay>orchestrator'], 'telemetry', '', 2)
      const kind: Kind = event.type === 'question' ? 'question' : event.type === 'result' || event.type === 'bundle_part' ? 'result' : 'telemetry'
      return chain([`${event.channel}>relay`, 'relay>orchestrator'], kind, words(event.type), event.type === 'bundle_part' ? 4 : 3, event.type === 'result')
    }
    case 'board': return chain(['orchestrator>board'], 'external', words(event.action))
    case 'github': return chain(['orchestrator>github'], 'external', event.action === 'draft_pr' ? 'draft PR' : 'push', 4)
    case 'launch': return chain([`launch>${event.channel}`], 'command', 'launch', 4)
    case 'tick': return event.sources.includes('board') ? chain(['board>orchestrator'], 'external', '', 2) : []
    default: return []
  }
}

// --- the view -------------------------------------------------------------------------------

export function Operations(props: { lead?: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [log, setLog] = useState<OpsEvent[]>([])
  const [beat, setBeat] = useState<{ n: number; color: string }>({ n: 0, color: 'var(--ops-command)' })
  const [heartbeats, setHeartbeats] = useState<Record<string, number>>({})
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [faults, setFaults] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const packets = useRef<Packet[]>([])
  const recent = useRef<Array<{ edge: string; at: number }>>([])
  const layer = useRef<SVGGElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const refresh = useRef<() => void>(() => {})

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      clearTimeout(timer)
      try {
        const next = await read<Snapshot>('state')
        if (!stopped) { setSnapshot(next); setStateError(null) }
      } catch (error) {
        if (!stopped) setStateError((error as Error).message)
      }
      if (!stopped) timer = setTimeout(load, 5_000)
    }
    refresh.current = () => void load()
    void load()
    const loadUsage = async () => {
      try {
        const next = await read<Usage>('usage')
        if (!stopped) { setUsage(next); setUsageError(null) }
      } catch (error) {
        if (!stopped) setUsageError((error as Error).message)
      }
    }
    void loadUsage()
    const usageTimer = setInterval(loadUsage, 10_000)
    const clockTimer = setInterval(() => setNow(Date.now()), 1_000)
    const stop = followEvents((event) => {
      setLog((rows) => [event, ...rows].slice(0, 120))
      const at = performance.now()
      for (const packet of packetsOf(event)) {
        packets.current.push({ ...packet, started: at })
        for (let p: Omit<Packet, 'started'> | undefined = packet; p; p = p.then) recent.current.push({ edge: p.edge, at: Date.now() })
      }
      if (event.kind === 'tick') setBeat((b) => ({ n: b.n + 1, color: BEAT[event.sources[0] ?? 'request'] }))
      if (event.kind === 'telemetry' && event.type === 'heartbeat') setHeartbeats((h) => ({ ...h, [event.channel]: (h[event.channel] ?? 0) + 1 }))
      if (event.kind === 'telemetry' && event.type === 'progress') setProgress((p) => ({ ...p, [event.channel]: (p[event.channel] ?? 0) + 1 }))
      if (event.kind === 'fault') setFaults((f) => ({ ...f, [event.channel ?? event.component]: (f[event.channel ?? event.component] ?? 0) + 1 }))
      if (event.kind === 'attempt' || event.kind === 'launch' || event.kind === 'github') refresh.current()
      if (event.kind === 'usage') void loadUsage()
    }, () => refresh.current(), setLive)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(usageTimer)
      clearInterval(clockTimer)
      stop()
    }
  }, [])

  // Packets are drawn outside React: a dot with a short fading trail along the link's path.
  // A link carries its packet's colour while one travels it, and fades back when it arrives.
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const group = layer.current
      const root = svg.current
      if (group && root) {
        const t = performance.now()
        const next: Packet[] = []
        group.replaceChildren()
        const hot = new Map<string, string>()
        const dot = (x: number, y: number, r: number, color: string, opacity: number, className = 'packet') => {
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
          circle.setAttribute('cx', x.toFixed(1))
          circle.setAttribute('cy', y.toFixed(1))
          circle.setAttribute('r', r.toFixed(2))
          circle.setAttribute('class', className)
          circle.style.setProperty('--c', color)
          circle.style.opacity = String(opacity)
          group.append(circle)
        }
        for (const packet of packets.current) {
          const path = root.querySelector<SVGPathElement>(`path[data-edge="${CSS.escape(packet.edge)}"]`)
          const linear = (t - packet.started) / packet.duration
          if (!path || linear >= 1) {
            if (path && packet.then) next.push({ ...packet.then, started: t })
            continue
          }
          const eased = linear < 0.5 ? 2 * linear * linear : 1 - (-2 * linear + 2) ** 2 / 2
          const length = path.getTotalLength()
          const color = COLOR[packet.kind]
          hot.set(packet.edge, color)
          for (let i = 4; i >= 1; i--) {
            const behind = Math.max(0, eased - i * 0.028)
            const p = path.getPointAtLength(behind * length)
            dot(p.x, p.y, packet.size * (1 - i * 0.15), color, 0.5 - i * 0.1)
          }
          const point = path.getPointAtLength(Math.max(0, eased) * length)
          dot(point.x, point.y, packet.size + 3.5, color, 0.18)
          dot(point.x, point.y, packet.size, color, 1, `packet${packet.ring ? ' ring' : ''}`)
          if (packet.label && linear > 0.3 && linear < 0.7) {
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
            label.setAttribute('x', (point.x + 8).toFixed(1))
            label.setAttribute('y', (point.y - 8).toFixed(1))
            label.setAttribute('class', 'packet-label')
            label.style.setProperty('--c', color)
            label.style.opacity = String(Math.min(1, Math.min(linear - 0.3, 0.7 - linear) * 12))
            label.textContent = packet.label
            group.append(label)
          }
          next.push(packet)
        }
        for (const path of root.querySelectorAll<SVGPathElement>('path[data-edge]')) {
          const color = hot.get(path.dataset.edge!)
          path.classList.toggle('hot', color !== undefined)
          if (color) path.style.setProperty('--hot', color)
        }
        packets.current = next.slice(-300)
        const cutoff = Date.now() - 60_000
        recent.current = recent.current.filter((row) => row.at > cutoff)
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  const attempts = snapshot?.attempts ?? []
  const workers = useMemo(() => (snapshot?.attempts ?? []).slice(0, SHOWN_WORKERS), [snapshot])
  const block = workers.length > 0 ? workers.length * ROW - (ROW - WORKER.h) : 0
  const height = Math.max(316, TOP + block + 30)
  const mid = Math.max(TOP + 128, TOP + block / 2)
  const workerTop = mid - block / 2
  const workerAt = (index: number) => ({ x: WORKER.x, y: workerTop + index * ROW })
  const o = { x: ORCHESTRATOR_X, y: mid }
  const r = { x: RELAY_X, y: mid }
  const board = { x: BOX.x, y: mid - 104 }
  const github = { x: BOX.x, y: mid + 46 }

  const used = (edge: string) => recent.current.some((row) => row.edge === edge)
  const edge = (id: string, d: string, extra = '') => <path key={id} data-edge={id} d={d} className={`link${used(id) ? ' used' : ''}${extra ? ` ${extra}` : ''}`} />

  const serving = snapshot?.orchestrator.status === 'serving'
  const offline = stateError !== null || !snapshot
  const statistics = snapshot?.relay.statistics
  const lanes = statistics ? Object.values(statistics.channels) : []
  const streams = lanes.reduce((sum, c) => sum + c.commands.streams + c.telemetry.streams, 0)
  const relayDown = offline || !serving || snapshot?.relay.reachable === false
  const boardDown = snapshot?.board.reachable === false
  const liveCount = attempts.filter((a) => LIVE.has(a.state)).length
  const lastTick = snapshot?.orchestrator.last_tick
  const chosen = attempts.find((a) => a.attempt_id === selected) ?? null

  const led = (state: 'ok' | 'warn' | 'fault' | 'off') => state
  const boardLed = offline ? led('off') : boardDown ? led('fault') : snapshot.board.paused ? led('warn') : led('ok')
  const relayLed = offline || !serving ? led('off') : snapshot.relay.reachable === false ? led('fault') : led('ok')
  const orchestratorLed = offline ? led('fault') : serving ? led('ok') : led('warn')

  return (
    <>
      <Header title="operations" live={live ? 'live' : 'reconnecting'} lead={props.lead} />
      <div className="view-body operations-view">
        <div className="ops-layout">
          <div className="ops-main">
            <section className="ops-card ops-stage">
              <header className="ops-card-head">
                <h2>Schematic</h2>
              </header>
              <svg ref={svg} className="ops-schematic" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="operations schematic">
                <defs>
                  <pattern id="ops-grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.9" className="grid-dot" /></pattern>
                  <radialGradient id="ops-heart"><stop offset="60%" stopColor="var(--gold)" stopOpacity="0.14" /><stop offset="100%" stopColor="var(--gold)" stopOpacity="0" /></radialGradient>
                </defs>
                <rect className="grid" x={0} y={0} width={WIDTH} height={height} fill="url(#ops-grid)" />
                <line className="divider" x1={COLUMN.relay} y1={14} x2={COLUMN.relay} y2={height - 14} />
                <line className="divider" x1={COLUMN.cloud} y1={14} x2={COLUMN.cloud} y2={height - 14} />
                <text className="column-label" x={COLUMN.lan + 18} y={26}>LAN</text>
                <text className="column-label" x={COLUMN.relay + 16} y={26}>RELAY</text>
                <text className="column-label" x={COLUMN.cloud + 16} y={26}>CLOUD</text>

                {edge('board>orchestrator', curve({ x: board.x + BOX.w, y: board.y + 22 }, onCircle(o, HEART_R + 3, 206)))}
                {edge('orchestrator>board', curve(onCircle(o, HEART_R + 3, 222), { x: board.x + BOX.w, y: board.y + 40 }, 8))}
                {edge('orchestrator>github', curve(onCircle(o, HEART_R + 3, 148), { x: github.x + BOX.w, y: github.y + 29 }))}
                {edge('orchestrator>relay', curve(onCircle(o, HEART_R + 3, -12), onCircle(r, RELAY_R + 3, 192)), relayDown ? 'down' : '')}
                {edge('relay>orchestrator', curve(onCircle(r, RELAY_R + 3, 168), onCircle(o, HEART_R + 3, 12), 8), relayDown ? 'down' : '')}
                {workers.map((attempt, index) => {
                  const at = workerAt(index)
                  const settled = !LIVE.has(attempt.state)
                  return (
                    <g key={`links-${attempt.attempt_id}`} className={settled ? 'settled' : ''}>
                      {edge(`relay>${attempt.channel}`, curve(onCircle(r, RELAY_R + 3, -10), { x: at.x - 2, y: at.y + 21 }))}
                      {edge(`${attempt.channel}>relay`, curve({ x: at.x - 2, y: at.y + 37 }, onCircle(r, RELAY_R + 3, 10), 8))}
                      {edge(`launch>${attempt.channel}`, curve(onCircle(o, HEART_R + 3, 58), { x: at.x - 2, y: at.y + WORKER.h / 2 }), 'launch')}
                    </g>
                  )
                })}

                <g className={`node${boardDown ? ' fault' : ''}${offline ? ' down' : ''}`}>
                  <rect className="frame" x={board.x} y={board.y} width={BOX.w} height={BOX.h} rx={7} />
                  <circle className={`led ${boardLed}`} cx={board.x + BOX.w - 14} cy={board.y + 18} r={3.5} />
                  <text className="node-title" x={board.x + 14} y={board.y + 24}>Board</text>
                  <text className="node-line small" x={board.x + 14} y={board.y + 43}>{offline ? '—' : boardDown ? 'unreachable' : snapshot.board.paused ? 'paused' : `${liveCount} claimed`}</text>
                  {snapshot?.board.error && <title>{snapshot.board.error}</title>}
                </g>

                <g className={`node${faults.github ? ' fault' : ''}`}>
                  <rect className="frame" x={github.x} y={github.y} width={BOX.w} height={BOX.h} rx={7} />
                  <circle className={`led ${faults.github ? 'fault' : offline ? 'off' : 'ok'}`} cx={github.x + BOX.w - 14} cy={github.y + 18} r={3.5} />
                  <text className="node-title" x={github.x + 14} y={github.y + 24}>GitHub</text>
                  <text className="node-line small" x={github.x + 14} y={github.y + 43}>{plural(attempts.filter((a) => a.pr_url).length, 'draft PR')}</text>
                </g>

                <g className={`node heart${offline ? ' down fault' : !serving ? ' down' : ''}`}>
                  {serving && <circle className="glow" cx={o.x} cy={o.y} r={HEART_R + 26} fill="url(#ops-heart)" />}
                  <circle className="frame" cx={o.x} cy={o.y} r={HEART_R} />
                  {serving && beat.n > 0 && <circle key={beat.n} className="ripple" cx={o.x} cy={o.y} r={HEART_R} style={{ ['--c' as string]: beat.color }} />}
                  <circle className={`led ${orchestratorLed}`} cx={o.x} cy={o.y - 26} r={3.5} />
                  <text className="node-title" x={o.x} y={o.y + 2} textAnchor="middle">Orchestrator</text>
                  <text className="node-line small" x={o.x} y={o.y + 18} textAnchor="middle">{offline ? 'unreachable' : serving ? `${snapshot.orchestrator.live}/${snapshot.orchestrator.live_limit} live` : 'idle'}</text>
                  {(snapshot?.orchestrator.reason || stateError) && <title>{snapshot?.orchestrator.reason ?? stateError}</title>}
                </g>

                <g className={`node relay${relayDown ? ' down' : ''}${snapshot?.relay.reachable === false ? ' fault' : ''}`}>
                  <circle className="frame" cx={r.x} cy={r.y} r={RELAY_R} />
                  {!relayDown && streams > 0 && <circle className="ring" cx={r.x} cy={r.y} r={RELAY_R + 6} style={{ ['--spin' as string]: `${Math.max(4, 24 / streams).toFixed(1)}s` }} />}
                  <circle className={`led ${relayLed}`} cx={r.x} cy={r.y - 17} r={3} />
                  <text className="node-title" x={r.x} y={r.y + 5} textAnchor="middle">Relay</text>
                  <text className="node-line small" x={r.x} y={r.y + 19} textAnchor="middle">{snapshot?.relay.reachable === false ? 'down' : snapshot?.relay.latency_ms != null ? `${snapshot.relay.latency_ms} ms` : '—'}</text>
                  {snapshot?.relay.error && <title>{snapshot.relay.error}</title>}
                </g>

                {workers.length === 0 && (
                  <g className="empty">
                    <text className="node-line" x={(COLUMN.cloud + WIDTH) / 2} y={mid - 4} textAnchor="middle">No workers</text>
                    <text className="node-line faint" x={(COLUMN.cloud + WIDTH) / 2} y={mid + 14} textAnchor="middle">
                      {snapshot ? `${snapshot.orchestrator.live} of ${snapshot.orchestrator.live_limit} slots in use` : ''}
                    </text>
                  </g>
                )}
                {workers.map((attempt, index) => (
                  <Worker key={attempt.attempt_id} attempt={attempt} at={workerAt(index)} now={now}
                    figures={usage?.by_attempt.find((row) => row.attempt === attempt.attempt_id)?.figures}
                    heartbeat={heartbeats[attempt.channel] ?? 0} progress={progress[attempt.channel] ?? 0} fault={(faults[attempt.channel] ?? 0) > 0}
                    selected={selected === attempt.attempt_id} onSelect={() => setSelected(selected === attempt.attempt_id ? null : attempt.attempt_id)} />
                ))}
                {attempts.length > SHOWN_WORKERS && <text className="node-line faint" x={WORKER.x} y={height - 10}>{attempts.length - SHOWN_WORKERS} more attempts are not shown</text>}

                <g ref={layer} className="packets" />
              </svg>
              <ul className="ops-legend" aria-label="packet colours">
                {LEGEND.map(([kind, label]) => <li key={kind}><i style={{ background: COLOR[kind] }} />{label}</li>)}
              </ul>
            </section>

            <section className="ops-card ops-messages">
              <header className="ops-card-head">
                <h2>{chosen ? `Messages · #${chosen.task_id}` : 'Messages'}</h2>
                <span className="ops-head-meta">{chosen ? `attempt ${chosen.attempt_no} · ${chosen.channel}` : 'all channels'}</span>
                <span className="spacer" />
                {chosen && <button type="button" className="act" onClick={() => setSelected(null)}>show all</button>}
              </header>
              <AttemptLog selected={selected} log={log} snapshot={snapshot} />
            </section>
          </div>

          <aside className="ops-side" aria-label="details">
            <UsagePanel usage={usage} error={usageError} now={now} />
            {chosen && <AttemptPanel attempt={chosen} now={now} figures={usage?.by_attempt.find((row) => row.attempt === chosen.attempt_id)?.figures} onClose={() => setSelected(null)} />}
            <section className="ops-card">
              <header className="ops-card-head"><h2>Orchestrator</h2><span className="spacer" /><Status state={orchestratorLed} text={offline ? 'unreachable' : snapshot.orchestrator.status} /></header>
              <Facts rows={[
                ['Live attempts', snapshot && `${snapshot.orchestrator.live} of ${snapshot.orchestrator.live_limit}`],
                ['Outbox', snapshot?.orchestrator.outbox],
                ['Last tick', lastTick && ago(now, lastTick.at)],
                ['Tick cause', lastTick && lastTick.sources.join(', ')],
                ['Ticks, last minute', snapshot?.orchestrator.ticks_last_minute],
                ['Uptime', snapshot && span(now - snapshot.started_at)],
              ]} />
            </section>
            <section className="ops-card">
              <header className="ops-card-head"><h2>Relay</h2><span className="spacer" /><Status state={relayLed} text={snapshot?.relay.reachable === false ? 'unreachable' : snapshot?.relay.reachable ? 'reachable' : 'unknown'} /></header>
              <Facts rows={[
                ['Host', snapshot?.relay.host],
                ['Latency', snapshot?.relay.latency_ms != null ? `${snapshot.relay.latency_ms} ms` : null],
                ['Channels', statistics ? Object.keys(statistics.channels).length : null],
                ['Open streams', statistics ? streams : null],
                ['Commands', statistics ? `${lanes.reduce((s, c) => s + c.commands.messages, 0)} · ${bytes(lanes.reduce((s, c) => s + c.commands.bytes, 0))}` : null],
                ['Telemetry', statistics ? `${lanes.reduce((s, c) => s + c.telemetry.messages, 0)} · ${bytes(lanes.reduce((s, c) => s + c.telemetry.bytes, 0))}` : null],
                ['Refused', statistics ? Object.entries(statistics.refused).map(([why, n]) => `${words(why)} ${n}`).join(', ') || '0' : null],
                ['Uptime', statistics ? span(now - statistics.started_at) : null],
              ]} />
              {snapshot?.relay.error && <p className="ops-note">{snapshot.relay.error}</p>}
            </section>
            <section className="ops-card">
              <header className="ops-card-head"><h2>Board</h2><span className="spacer" /><Status state={boardLed} text={offline ? 'unknown' : boardDown ? 'unreachable' : snapshot.board.paused ? 'paused' : 'reachable'} /></header>
              <Facts rows={[
                ['Claimed tasks', snapshot ? liveCount : null],
                ['Attempts shown', snapshot ? attempts.length : null],
                ['Draft PRs', snapshot ? attempts.filter((a) => a.pr_url).length : null],
              ]} />
              {snapshot?.board.error && <p className="ops-note">{snapshot.board.error}</p>}
            </section>
          </aside>
        </div>
      </div>
    </>
  )
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const bytes = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : value >= 1e3 ? `${(value / 1e3).toFixed(1)} kB` : `${value} B`

function Status(props: { state: 'ok' | 'warn' | 'fault' | 'off'; text: string }) {
  return <span className={`ops-status ${props.state}`}><i />{props.text}</span>
}

/** Names and their values, one per row; a missing value shows as a dash. */
function Facts(props: { rows: Array<[string, ReactNode | null | undefined]> }) {
  return (
    <dl className="ops-facts">
      {props.rows.map(([name, value]) => (
        <div key={name}><dt>{name}</dt><dd>{value === null || value === undefined || value === '' ? <span className="faint">—</span> : value}</dd></div>
      ))}
    </dl>
  )
}

function Worker(props: {
  attempt: AttemptView; at: Point; now: number; figures: Figures | undefined; heartbeat: number; progress: number
  fault: boolean; selected: boolean; onSelect: () => void
}) {
  const { attempt, at, now } = props
  const waiting = attempt.state === 'waiting_answer'
  const settled = !LIVE.has(attempt.state)
  const late = attempt.state === 'awaiting_contact' && attempt.watchdog_due !== null && attempt.watchdog_due - now < 120_000
  const fault = props.fault || late || attempt.outcome === 'failed'
  const state = settled ? 'off' : fault ? 'fault' : waiting ? 'warn' : attempt.heartbeat?.pi_alive === false ? 'warn' : 'ok'
  const where = `${attempt.repository.split('/').pop() ?? attempt.repository} · ${attempt.branch}`
  const shown = settled ? attempt.outcome ?? words(attempt.state) : words(attempt.state)
  return (
    <g className={`node worker${waiting ? ' waiting' : ''}${settled ? ' settled' : ''}${fault ? ' fault' : ''}${props.selected ? ' selected' : ''}`}
      onClick={props.onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onSelect() } }}
      role="button" tabIndex={0} aria-pressed={props.selected} aria-label={`task ${attempt.task_id}, ${words(attempt.state)}`}>
      <rect className="frame" x={at.x} y={at.y} width={WORKER.w} height={WORKER.h} rx={7} />
      <circle className={`led ${state}`} cx={at.x + 16} cy={at.y + 20} r={3.5} />
      {props.heartbeat > 0 && !settled && <circle key={props.heartbeat} className="pulse" cx={at.x + 16} cy={at.y + 20} r={3.5} />}
      <text className="node-title" x={at.x + 30} y={at.y + 25}>
        #{attempt.task_id}<tspan className="node-detail" dx={8}>round {attempt.round} · attempt {attempt.attempt_no}</tspan>
      </text>
      <text className="node-line" x={at.x + 30} y={at.y + 43}>
        <tspan className={`state state-${attempt.state}`}>{shown}</tspan>
        <tspan className="node-detail" dx={8}>{clip(where, Math.max(8, 30 - shown.length))}</tspan>
      </text>
      <text className="node-figure" x={at.x + WORKER.w - 14} y={at.y + 25} textAnchor="end">{usd(props.figures?.cost_usd ?? attempt.cost_usd)}</text>
      <text className="node-detail" x={at.x + WORKER.w - 14} y={at.y + 43} textAnchor="end">{ago(now, attempt.last_contact_at)}</text>
      <rect className="track" x={at.x + 10} y={at.y + WORKER.h - 4} width={WORKER.w - 20} height={1.5} rx={0.75} />
      {props.progress > 0 && !settled && <rect key={props.progress} className="sweep" x={at.x + 10} y={at.y + WORKER.h - 4} width={WORKER.w - 20} height={1.5} rx={0.75} />}
      <title>{`${attempt.repository} ${attempt.branch}\ncommands ${attempt.messages.commands} · telemetry ${attempt.messages.telemetry}`}</title>
    </g>
  )
}

function UsagePanel(props: { usage: Usage | null; error: string | null; now: number }) {
  const { usage } = props
  const problem = usage?.error ?? props.error ?? (usage && !usage.available ? 'the ledger is not available' : null)
  const hourly = usage?.hourly ?? []
  const peak = Math.max(0, ...hourly.map((slot) => Number(slot.cost_usd)))
  return (
    <section className="ops-card ops-usage">
      <header className="ops-card-head"><h2>Usage</h2><span className="spacer" /><span title={problem ?? undefined}><Status state={problem ? 'fault' : usage ? 'ok' : 'off'} text={problem ? 'unavailable' : usage ? 'ledger' : 'loading'} /></span></header>
      <div className="ops-figures">
        <div><span className="ops-figure" key={usage?.today.cost_usd}>{usage ? usd(usage.today.cost_usd) : '—'}</span><span className="ops-figure-label">today</span></div>
        <div><span className="ops-figure small">{usage ? usd(usage.last_hour.cost_usd) : '—'}</span><span className="ops-figure-label">last hour</span></div>
        <div><span className="ops-figure small">{usage ? usd(usage.total.cost_usd) : '—'}</span><span className="ops-figure-label">total</span></div>
      </div>
      {hourly.length > 0 && (
        <div className="ops-hours">
          <div className="ops-bars" role="img" aria-label="cost per hour, last 24 hours">
            {hourly.map((slot) => {
              const value = Number(slot.cost_usd)
              return <i key={slot.hour} className={value > 0 ? 'spent' : ''} style={{ height: `${peak > 0 ? Math.max(4, (value / peak) * 100) : 4}%` }}
                title={`${new Date(slot.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${usd(slot.cost_usd)} · ${tokens(slot.output_tokens)} out`} />
            })}
          </div>
          <div className="ops-axis"><span>24 h ago</span><span>peak {usd(peak)}</span><span>now</span></div>
        </div>
      )}
      <Facts rows={[
        ['Input tokens', usage ? `${tokens(usage.today.input_tokens)}/${tokens(usage.total.input_tokens)}` : null],
        ['Output tokens', usage ? `${tokens(usage.today.output_tokens)}/${tokens(usage.total.output_tokens)}` : null],
        ['Unknown', usage ? usage.total.unknown_records : null],
      ]} />
      {usage && usage.by_model.length > 0 && (
        <>
          <h3>By model</h3>
          <dl className="ops-facts">
            {usage.by_model.map((row) => (
              <div key={row.model} title={`${tokens(row.figures.input_tokens)} in · ${tokens(row.figures.output_tokens)} out · ${row.figures.records} records`}>
                <dt>{row.model}</dt><dd>{usd(row.figures.cost_usd)}<span className="faint"> · {tokens(row.figures.output_tokens)} out</span></dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  )
}

function AttemptPanel(props: { attempt: AttemptView; now: number; figures: Figures | undefined; onClose: () => void }) {
  const { attempt, now } = props
  const beat = attempt.heartbeat
  return (
    <section className="ops-card ops-attempt">
      <header className="ops-card-head">
        <h2>#{attempt.task_id} · attempt {attempt.attempt_no}</h2>
        <span className="spacer" />
        <button type="button" className="act" onClick={props.onClose} aria-label="close attempt details">close</button>
      </header>
      <Facts rows={[
        ['State', <span className={`state state-${attempt.state}`}>{words(attempt.state)}</span>],
        ['Outcome', attempt.outcome],
        ['Round', attempt.round],
        ['Repository', attempt.repository],
        ['Branch', attempt.branch],
        ['Worker channel', attempt.channel],
        ['Board channel', attempt.board_channel],
        ['Created', clock(attempt.created_at)],
        ['Launched', attempt.launched_at && clock(attempt.launched_at)],
        ['Last contact', ago(now, attempt.last_contact_at)],
        ['Heartbeat', beat && `${words(beat.state)} · ${span(beat.elapsed_seconds * 1000)} · ${beat.pi_alive ? 'agent alive' : 'agent stopped'}`],
        ['Watchdog', attempt.watchdog_due && (attempt.watchdog_due > now ? `in ${span(attempt.watchdog_due - now)}` : `${span(now - attempt.watchdog_due)} overdue`)],
        ['Question asked', attempt.question_at && ago(now, attempt.question_at)],
        ['Commands', attempt.messages.commands],
        ['Telemetry', attempt.messages.telemetry],
        ['Cost', usd(props.figures?.cost_usd ?? attempt.cost_usd)],
        ['Tokens', props.figures && `${tokens(props.figures.input_tokens)} in · ${tokens(props.figures.output_tokens)} out`],
        ['Progress', Object.keys(attempt.progress).length > 0 ? Object.entries(attempt.progress).map(([name, n]) => `${words(name)} ${n}`).join(', ') : null],
        ['Pull request', attempt.pr_url && <a href={attempt.pr_url} target="_blank" rel="noreferrer">{attempt.pr_url.replace(/^https:\/\/github\.com\//, '')}</a>],
      ]} />
    </section>
  )
}

/** Events worth a line: no heartbeats, ticks or thread replies, which only repeat what the state says. */
const worthShowing = (event: OpsEvent) =>
  event.kind !== 'tick' && !(event.kind === 'telemetry' && event.type === 'heartbeat') && !(event.kind === 'board' && event.action === 'reply')

function EventRows({ events }: { events: OpsEvent[] }) {
  return (
    <ol className="ops-log">
      {events.map((event) => (
        <li key={event.seq} className={event.kind === 'fault' ? 'fault' : ''}>
          <time>{clock(event.at)}</time>
          <i style={{ background: event.kind === 'fault' ? 'var(--red)' : COLOR[kindOf(event)] }} />
          <span className="ops-log-text">{describe(event)}</span>
        </li>
      ))}
    </ol>
  )
}

type TaskRow = { task: string; state: string; first: number; last: number; cost: number; faults: number; events: OpsEvent[] }

/** One row per task, newest first: its latest attempt state, how long it has run, and its cost; it opens into its events. */
function taskRows(log: OpsEvent[]): { rows: TaskRow[]; other: OpsEvent[] } {
  const rows = new Map<string, TaskRow>()
  const other: OpsEvent[] = []
  for (const event of log) {
    if (!worthShowing(event)) continue
    const task = 'task' in event && event.task ? event.task : null
    if (!task) {
      other.push(event)
      continue
    }
    const row = rows.get(task) ?? { task, state: '', first: event.at, last: event.at, cost: 0, faults: 0, events: [] }
    row.events.push(event)
    row.first = Math.min(row.first, event.at)
    row.last = Math.max(row.last, event.at)
    if (event.kind === 'attempt' && !row.state) row.state = event.state
    if (event.kind === 'usage') row.cost += event.cost_usd
    if (event.kind === 'fault') row.faults += 1
    rows.set(task, row)
  }
  return { rows: [...rows.values()].sort((a, b) => b.last - a.last), other }
}

function AttemptLog(props: { selected: string | null; log: OpsEvent[]; snapshot: Snapshot | null }) {
  const [history, setHistory] = useState<OpsEvent[] | null>(null)
  useEffect(() => {
    setHistory(null)
    if (!props.selected) return
    let stopped = false
    read<{ events: OpsEvent[] }>(`attempts/${props.selected}/events`).then((answer) => { if (!stopped) setHistory(answer.events.slice().reverse()) }).catch(() => { if (!stopped) setHistory([]) })
    return () => { stopped = true }
  }, [props.selected])
  const channel = props.snapshot?.attempts.find((a) => a.attempt_id === props.selected)?.channel
  if (props.selected) {
    const events = [...props.log.filter((event) => 'channel' in event && event.channel === channel), ...(history ?? [])]
      .filter((event, index, all) => worthShowing(event) && all.findIndex((other) => other.seq === event.seq) === index).slice(0, 120)
    return events.length === 0 ? <p className="ops-empty">No messages since this page opened.</p> : <EventRows events={events} />
  }
  const { rows, other } = taskRows(props.log)
  if (rows.length === 0 && other.length === 0) return <p className="ops-empty">No messages since this page opened.</p>
  return (
    <div className="ops-tasks">
      {rows.slice(0, 40).map((row) => (
        <details key={row.task} className={`ops-task${row.faults ? ' fault' : ''}`}>
          <summary>
            <span className="ops-task-id">#{row.task}</span>
            <span className="ops-task-state">{words(row.state || 'active')}</span>
            <span className="ops-task-figure">{span(row.last - row.first)}</span>
            <span className="ops-task-figure">{usd(row.cost)}</span>
            {row.faults > 0 && <span className="ops-task-fault">{row.faults} fault{row.faults === 1 ? '' : 's'}</span>}
            <time>{clock(row.last)}</time>
          </summary>
          <EventRows events={row.events} />
        </details>
      ))}
      {other.length > 0 && <EventRows events={other.slice(0, 20)} />}
    </div>
  )
}

function kindOf(event: OpsEvent): Kind {
  switch (event.kind) {
    case 'command': return event.type === 'answer' ? 'question' : 'command'
    case 'telemetry': return event.type === 'question' ? 'question' : event.type === 'result' || event.type === 'bundle_part' ? 'result' : 'telemetry'
    case 'usage': return 'usage'
    case 'fault': return 'question'
    default: return 'external'
  }
}

function describe(event: OpsEvent): string {
  switch (event.kind) {
    case 'tick': return `${event.sources.join(' + ')} · ${event.duration_ms} ms`
    case 'command': return `← ${words(event.type)}${event.outcome === 'failed' ? ' · failed' : ''}`
    case 'telemetry': return `→ ${words(event.type)}`
    case 'board': return `board ${words(event.action)}`
    case 'github': return `${event.action === 'draft_pr' ? 'draft PR' : 'push'} · ${event.repository}`
    case 'launch': return `launch ${words(event.outcome)}`
    case 'attempt': return words(event.state)
    case 'fault': return `${event.component} · ${words(event.code)}${event.task ? ` · #${event.task}` : ''}`
    case 'usage': return `round ${event.round} · ${usd(event.cost_usd)} · ${tokens(event.input_tokens)} in · ${tokens(event.output_tokens)} out`
  }
}
