// /operations: a live schematic of the board, the orchestrator, the relay, the cloud workers,
// GitHub and the spend ledger. Each message travels its link as a packet and makes the link bold;
// the orchestrator beats on each tick; each worker is an engine whose piston moves on its heartbeats.
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
  board: { reachable: boolean | null; paused: boolean | null; checked_at: number | null; error: string | null }
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
async function read<T>(path: string): Promise<T> {
  const response = await fetch(api(path), { headers: { 'x-inspect-token': token() } })
  if (!response.ok) {
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
        if (!response.ok || !response.body) throw new Error(`status ${response.status}`)
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

const WIDTH = 1000
const ROW = 84
const TOP = 34
const SHOWN_WORKERS = 8
const BOX = { w: 136, h: 58 }
const AT = { board: { x: 20, y: 60 }, github: { x: 20, y: 230 }, orchestrator: { x: 300, y: 180 }, ledger: { x: 232, y: 270 }, relay: { x: 520 } }
const HEART_R = 50
const RELAY_R = 38
const WORKER = { x: 640, w: 340, h: 70 }

type Kind = 'command' | 'telemetry' | 'question' | 'result' | 'external' | 'usage'
const COLOR: Record<Kind, string> = {
  command: 'var(--accent)', telemetry: '#9be7a0', question: 'var(--warning)', result: '#d6a6ff', external: '#ffb3c7', usage: '#7fd6ff',
}
const BEAT: Record<WakeSource, string> = {
  start: 'var(--bright)', board: '#ffb3c7', telemetry: '#9be7a0', timer: 'var(--accent)', sweep: 'var(--muted)', request: 'var(--muted)',
}

type Packet = { edge: string; kind: Kind; size: number; ring: boolean; started: number; duration: number; label: string; then?: Omit<Packet, 'started'> }

const usd = (value: string | number) => {
  const number = typeof value === 'number' ? value : Number(value)
  return number >= 100 ? `$${number.toFixed(0)}` : number >= 1 ? `$${number.toFixed(2)}` : `$${number.toFixed(3)}`
}
const tokens = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value)
const ago = (now: number, at: number | null) => at === null ? 'never' : now - at < 1000 ? 'now' : now - at < 60_000 ? `${Math.round((now - at) / 1000)}s` : `${Math.round((now - at) / 60_000)}m`
const LIVE = new Set(['claimed', 'launching', 'awaiting_contact', 'running', 'waiting_answer', 'deciding', 'publishing', 'stopping'])

function packetsOf(event: OpsEvent): Array<Omit<Packet, 'started'>> {
  const chain = (edges: string[], kind: Kind, label: string, size = 4, ring = false): Array<Omit<Packet, 'started'>> => {
    let next: Omit<Packet, 'started'> | undefined
    for (const edge of [...edges].reverse()) next = { edge, kind, size, ring, duration: 650, label, ...(next ? { then: next } : {}) }
    return next ? [next] : []
  }
  switch (event.kind) {
    case 'command': return event.outcome === 'sent' ? chain(['orchestrator>relay', `relay>${event.channel}`], event.type === 'answer' ? 'question' : 'command', event.type) : []
    case 'telemetry': {
      const kind: Kind = event.type === 'question' ? 'question' : event.type === 'result' || event.type === 'bundle_part' ? 'result' : 'telemetry'
      return chain([`${event.channel}>relay`, 'relay>orchestrator'], kind, event.type, event.type === 'bundle_part' ? 6 : 4, event.type === 'result')
    }
    case 'board': return chain(['orchestrator>board'], 'external', event.action)
    case 'github': return chain(['orchestrator>github'], 'external', event.action === 'draft_pr' ? 'draft PR' : 'push', 5)
    case 'launch': return chain([`launch>${event.channel}`], 'command', 'launch', 5)
    case 'usage': return chain(['orchestrator>ledger'], 'usage', usd(event.cost_usd), 5, true)
    case 'tick': return event.sources.includes('board') ? chain(['board>orchestrator'], 'external', '', 3) : []
    default: return []
  }
}

// --- the view -------------------------------------------------------------------------------

export function Operations(props: { lead?: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [live, setLive] = useState(false)
  const [log, setLog] = useState<OpsEvent[]>([])
  const [beat, setBeat] = useState<{ n: number; color: string }>({ n: 0, color: 'var(--accent)' })
  const [pistons, setPistons] = useState<Record<string, number>>({})
  const [spin, setSpin] = useState<Record<string, number>>({})
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
      try { if (!stopped) setUsage(await read<Usage>('usage')) } catch { /* shown as unavailable */ }
    }
    void loadUsage()
    const usageTimer = setInterval(loadUsage, 10_000)
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    const stop = followEvents((event) => {
      setLog((rows) => [event, ...rows].slice(0, 60))
      const at = performance.now()
      for (const packet of packetsOf(event)) {
        packets.current.push({ ...packet, started: at })
        for (let p: Omit<Packet, 'started'> | undefined = packet; p; p = p.then) recent.current.push({ edge: p.edge, at: Date.now() })
      }
      if (event.kind === 'tick') setBeat((b) => ({ n: b.n + 1, color: BEAT[event.sources[0] ?? 'request'] }))
      if (event.kind === 'telemetry' || event.kind === 'command') setBeat((b) => ({ n: b.n + 1, color: COLOR[event.kind === 'telemetry' ? 'telemetry' : 'command'] }))
      if (event.kind === 'telemetry' && event.type === 'heartbeat') setPistons((p) => ({ ...p, [event.channel]: (p[event.channel] ?? 0) + 1 }))
      if (event.kind === 'telemetry' && event.type === 'progress') setSpin((s) => ({ ...s, [event.channel]: Date.now() }))
      if (event.kind === 'fault') setFaults((f) => ({ ...f, [event.channel ?? event.component]: (f[event.channel ?? event.component] ?? 0) + 1 }))
      if (event.kind === 'attempt' || event.kind === 'launch' || event.kind === 'github') refresh.current()
      if (event.kind === 'usage') void loadUsage()
    }, () => refresh.current(), setLive)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(usageTimer)
      clearInterval(clock)
      stop()
    }
  }, [])

  const workers = useMemo(() => (snapshot?.attempts ?? []).slice(0, SHOWN_WORKERS), [snapshot])
  const height = Math.max(340, TOP + workers.length * ROW + 10)
  const relay = { x: AT.relay.x, y: Math.max(AT.orchestrator.y, TOP + (workers.length * ROW) / 2 - 7) }
  const workerAt = (index: number) => ({ x: WORKER.x, y: TOP + index * ROW })

  // Packets are drawn outside React: one frame each, along the link's path.
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const group = layer.current
      const root = svg.current
      if (group && root) {
        const t = performance.now()
        const next: Packet[] = []
        group.replaceChildren()
        const hot = new Set<string>()
        for (const packet of packets.current) {
          const path = root.querySelector<SVGPathElement>(`path[data-edge="${CSS.escape(packet.edge)}"]`)
          const progress = (t - packet.started) / packet.duration
          if (!path || progress >= 1) {
            if (packet.then) next.push({ ...packet.then, started: t })
            continue
          }
          hot.add(packet.edge)
          path.style.setProperty('--hot', COLOR[packet.kind])
          const point = path.getPointAtLength(Math.max(0, progress) * path.getTotalLength())
          const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
          dot.setAttribute('cx', String(point.x))
          dot.setAttribute('cy', String(point.y))
          dot.setAttribute('r', String(packet.size))
          dot.setAttribute('class', `packet${packet.ring ? ' ring' : ''}`)
          dot.style.setProperty('--c', COLOR[packet.kind])
          group.append(dot)
          if (packet.label && progress > 0.2 && progress < 0.8) {
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
            label.setAttribute('x', String(point.x + 7))
            label.setAttribute('y', String(point.y - 7))
            label.setAttribute('class', 'packet-label')
            label.style.setProperty('--c', COLOR[packet.kind])
            label.textContent = packet.label
            group.append(label)
          }
          next.push(packet)
        }
        for (const path of root.querySelectorAll<SVGPathElement>('path[data-edge]')) path.classList.toggle('hot', hot.has(path.dataset.edge!))
        packets.current = next.slice(-300)
        const cutoff = Date.now() - 60_000
        recent.current = recent.current.filter((row) => row.at > cutoff)
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  const rate = (edge: string) => recent.current.filter((row) => row.edge === edge).length
  const flow = (edge: string) => ({ ['--flow' as string]: `${Math.max(0.6, 12 / (1 + rate(edge) / 4)).toFixed(2)}s`, ['--width' as string]: `${Math.min(4, 1.5 + rate(edge) / 10).toFixed(2)}px` })
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const mx = (a.x + b.x) / 2
    return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`
  }
  const edge = (id: string, d: string, extra = '') => <path key={id} data-edge={id} d={d} className={`link ${extra}`} style={flow(id)} markerEnd="url(#ops-arrow)" />

  const o = AT.orchestrator
  const serving = snapshot?.orchestrator.status === 'serving'
  const offline = stateError !== null || !snapshot
  const orchestratorState = offline ? 'offline' : serving ? `${snapshot.orchestrator.live}/${snapshot.orchestrator.live_limit} live` : 'idle'
  const lastTick = snapshot?.orchestrator.last_tick
  const statistics = snapshot?.relay.statistics
  const streams = statistics ? Object.values(statistics.channels).reduce((sum, c) => sum + c.commands.streams + c.telemetry.streams, 0) : 0
  const usageOf = (attempt: string) => usage?.by_attempt.find((row) => row.attempt === attempt)?.figures
  const hourlyMax = Math.max(0.000001, ...(usage?.hourly ?? []).map((slot) => Number(slot.cost_usd)))
  const box = (x: number, y: number, w = BOX.w, h = BOX.h) => <rect x={x} y={y} width={w} height={h} rx={8} />
  const relayDown = offline || !serving || snapshot?.relay.reachable === false
  const boardDown = snapshot?.board.reachable === false

  return (
    <>
      <Header title="operations" live={live ? 'live' : 'reconnecting'} lead={props.lead} />
      <div className="view-body operations-view">
        <svg ref={svg} className="ops-schematic" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="operations">
          <defs>
            <marker id="ops-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" className="arrowhead" /></marker>
            <radialGradient id="ops-heart"><stop offset="55%" stopColor="var(--accent)" stopOpacity="0.18" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></radialGradient>
          </defs>
          <rect className="zone" x={6} y={6} width={440} height={height - 12} rx={12} />
          <text className="zone-label" x={18} y={22}>lan</text>
          <rect className="zone" x={462} y={6} width={116} height={height - 12} rx={12} />
          <text className="zone-label" x={474} y={22}>relay</text>
          <rect className="zone" x={594} y={6} width={400} height={height - 12} rx={12} />
          <text className="zone-label" x={606} y={22}>cloud</text>

          {edge('board>orchestrator', curve({ x: AT.board.x + BOX.w, y: AT.board.y + 22 }, { x: o.x - HEART_R - 4, y: o.y - 16 }))}
          {edge('orchestrator>board', curve({ x: o.x - HEART_R - 2, y: o.y - 30 }, { x: AT.board.x + BOX.w + 4, y: AT.board.y + 40 }))}
          {edge('orchestrator>github', curve({ x: o.x - HEART_R - 2, y: o.y + 20 }, { x: AT.github.x + BOX.w + 4, y: AT.github.y + 29 }))}
          {edge('orchestrator>ledger', `M${o.x},${o.y + HEART_R + 2} L${o.x},${AT.ledger.y - 4}`)}
          {edge('orchestrator>relay', curve({ x: o.x + HEART_R + 2, y: o.y - 12 }, { x: relay.x - RELAY_R - 4, y: relay.y - 12 }), relayDown ? 'down' : '')}
          {edge('relay>orchestrator', curve({ x: relay.x - RELAY_R - 2, y: relay.y + 12 }, { x: o.x + HEART_R + 4, y: o.y + 12 }), relayDown ? 'down' : '')}
          {workers.map((attempt, index) => {
            const at = workerAt(index)
            const settled = !LIVE.has(attempt.state)
            return (
              <g key={`links-${attempt.attempt_id}`} className={settled ? 'settled' : ''}>
                {edge(`relay>${attempt.channel}`, curve({ x: relay.x + RELAY_R + 2, y: relay.y - 6 }, { x: at.x - 4, y: at.y + 24 }))}
                {edge(`${attempt.channel}>relay`, curve({ x: at.x - 2, y: at.y + 46 }, { x: relay.x + RELAY_R + 4, y: relay.y + 6 }))}
                {edge(`launch>${attempt.channel}`, curve({ x: o.x + 20, y: o.y + HEART_R }, { x: at.x - 4, y: at.y + 60 }), 'launch')}
              </g>
            )
          })}

          <g className={`node${boardDown ? ' fault' : ''}`} key={`board-${faults.board ?? 0}`}>
            {box(AT.board.x, AT.board.y)}
            <text className="node-title" x={AT.board.x + 12} y={AT.board.y + 24}>Board</text>
            <text className="node-line" x={AT.board.x + 12} y={AT.board.y + 44}>{offline || !serving ? '—' : boardDown ? 'offline' : snapshot!.board.paused ? 'paused' : `${snapshot!.attempts.filter((a) => LIVE.has(a.state)).length} claimed`}</text>
          </g>

          <g className={`node${faults.github ? ' fault' : ''}`} key={`github-${faults.github ?? 0}`}>
            {box(AT.github.x, AT.github.y)}
            <text className="node-title" x={AT.github.x + 12} y={AT.github.y + 24}>GitHub</text>
            <text className="node-line" x={AT.github.x + 12} y={AT.github.y + 44}>{snapshot?.attempts.filter((a) => a.pr_url).length ?? 0} PRs</text>
          </g>

          <g className={`node heart${offline || !serving ? ' down' : ''}${(snapshot?.orchestrator.live ?? 0) === 0 ? ' idle' : ''}`}>
            {serving && <circle className="glow" cx={o.x} cy={o.y} r={HEART_R + 22} fill="url(#ops-heart)" />}
            <g key={beat.n} className="beat" style={{ ['--beat' as string]: beat.color }}>
              <circle cx={o.x} cy={o.y} r={HEART_R} />
            </g>
            <text className="node-title" x={o.x} y={o.y - 4} textAnchor="middle">Orchestrator</text>
            <text className="node-line" x={o.x} y={o.y + 16} textAnchor="middle">{orchestratorState}</text>
            {serving && lastTick && <text className="node-line faint" x={o.x} y={o.y + 32} textAnchor="middle">{ago(now, lastTick.at)}</text>}
            {snapshot?.orchestrator.reason && <title>{snapshot.orchestrator.reason}</title>}
            {stateError && <title>{stateError}</title>}
          </g>

          <g className={`node ledger${faults.ledger || usage?.error ? ' fault' : ''}`}>
            {box(AT.ledger.x, AT.ledger.y, 136, 62)}
            <text className="node-title" x={AT.ledger.x + 12} y={AT.ledger.y + 22}>Usage</text>
            <text className="node-line" x={AT.ledger.x + 124} y={AT.ledger.y + 22} textAnchor="end">{usage?.error ?? (usage ? usd(usage.today.cost_usd) : '—')}</text>
            {usage?.hourly.map((slot, index) => {
              const h = Math.max(1, (Number(slot.cost_usd) / hourlyMax) * 22)
              return <rect key={slot.hour} className="spark" x={AT.ledger.x + 12 + index * 4.7} y={AT.ledger.y + 54 - h} width={3.4} height={h}><title>{`${new Date(slot.hour).getHours()}:00 ${usd(slot.cost_usd)}`}</title></rect>
            })}
          </g>

          <g className={`node relay${relayDown ? ' down' : ''}${snapshot?.relay.reachable === false ? ' fault' : ''}`} key={`relay-${faults.relay ?? 0}`}>
            <circle cx={relay.x} cy={relay.y} r={RELAY_R} />
            {!relayDown && <circle className="ring" cx={relay.x} cy={relay.y} r={RELAY_R + 7} style={{ ['--spin' as string]: `${Math.max(1.5, 20 / (1 + streams)).toFixed(1)}s` }} />}
            <text className="node-title" x={relay.x} y={relay.y - 2} textAnchor="middle">Relay</text>
            <text className="node-line" x={relay.x} y={relay.y + 16} textAnchor="middle">{snapshot?.relay.reachable === false ? 'offline' : snapshot?.relay.latency_ms != null ? `${snapshot.relay.latency_ms} ms` : '—'}</text>
            {snapshot?.relay.error && <title>{snapshot.relay.error}</title>}
          </g>

          {workers.map((attempt, index) => {
            const at = workerAt(index)
            const lane = statistics?.channels[attempt.channel]
            const waiting = attempt.state === 'waiting_answer'
            const running = attempt.heartbeat?.pi_alive === true && attempt.state === 'running'
            const fast = now - (spin[attempt.channel] ?? 0) < 2_500
            const figures = usageOf(attempt.attempt_id)
            const settled = !LIVE.has(attempt.state)
            const late = attempt.state === 'awaiting_contact' && attempt.watchdog_due !== null && attempt.watchdog_due - now < 120_000
            const select = () => setSelected(selected === attempt.attempt_id ? null : attempt.attempt_id)
            return (
              <g key={`${attempt.attempt_id}-${faults[attempt.channel] ?? 0}`}
                className={`node worker${waiting ? ' waiting' : ''}${settled ? ' settled' : ''}${faults[attempt.channel] || late ? ' fault' : ''}${selected === attempt.attempt_id ? ' selected' : ''}`}
                onClick={select} onKeyDown={(event) => { if (event.key === 'Enter') select() }} role="button" tabIndex={0}>
                {box(at.x, at.y, WORKER.w, WORKER.h)}
                <rect className="cylinder" x={at.x + 12} y={at.y + 14} width={26} height={42} rx={3} />
                <rect key={pistons[attempt.channel] ?? 0} className="piston" x={at.x + 15} y={at.y + 17} width={20} height={12} rx={2} />
                <g className={`gear${running ? ' turning' : ''}${fast ? ' fast' : ''}${waiting ? ' stopped' : ''}`} style={{ transformOrigin: `${at.x + 64}px ${at.y + 35}px` }}>
                  <path d={gearPath(at.x + 64, at.y + 35, 15, 10, 8)} />
                  <circle cx={at.x + 64} cy={at.y + 35} r={3.5} className="hub" />
                </g>
                <text className="node-title" x={at.x + 92} y={at.y + 26}>#{attempt.task_id} r{attempt.round}</text>
                <text className={`node-line state-${attempt.state}`} x={at.x + 92} y={at.y + 46}>{settled ? attempt.outcome ?? attempt.state : attempt.state.replace('_', ' ')}</text>
                <text className="node-line faint" x={at.x + WORKER.w - 12} y={at.y + 26} textAnchor="end">{figures ? usd(figures.cost_usd) : usd(attempt.cost_usd)}</text>
                <text className="node-line faint" x={at.x + WORKER.w - 12} y={at.y + 46} textAnchor="end">{ago(now, attempt.last_contact_at)}</text>
                <title>{`${attempt.repository} ${attempt.branch} · commands ${lane?.commands.messages ?? attempt.messages.commands} · telemetry ${lane?.telemetry.messages ?? attempt.messages.telemetry}`}</title>
              </g>
            )
          })}
          {(snapshot?.attempts.length ?? 0) > SHOWN_WORKERS && <text className="node-line faint" x={WORKER.x} y={height - 14}>+{snapshot!.attempts.length - SHOWN_WORKERS}</text>}

          <g ref={layer} className="packets" />
        </svg>
        {(stateError || snapshot?.orchestrator.reason) && <p className="ops-note">{snapshot?.orchestrator.reason ?? stateError}</p>}

        <div className="ops-panels">
          <section className="ops-panel">
            <h2>Usage</h2>
            {usage?.available && usage.by_model.length > 0 ? (
              <table className="ops-table">
                <thead><tr><th>model</th><th>in</th><th>out</th><th>cost</th><th>unknown</th></tr></thead>
                <tbody>{usage.by_model.map((row) => (
                  <tr key={row.model}><td>{row.model}</td><td>{tokens(row.figures.input_tokens)}</td><td>{tokens(row.figures.output_tokens)}</td><td>{usd(row.figures.cost_usd)}</td><td>{row.figures.unknown_records || ''}</td></tr>
                ))}</tbody>
                <tfoot><tr><td>total</td><td>{tokens(usage.total.input_tokens)}</td><td>{tokens(usage.total.output_tokens)}</td><td>{usd(usage.total.cost_usd)}</td><td>{usage.total.unknown_records || ''}</td></tr></tfoot>
              </table>
            ) : <p className="faint">{usage?.error ?? 'none'}</p>}
          </section>
          <section className="ops-panel">
            <h2>{selected ? `#${snapshot?.attempts.find((a) => a.attempt_id === selected)?.task_id ?? ''}` : 'Messages'}</h2>
            <AttemptLog selected={selected} log={log} snapshot={snapshot} now={now} />
          </section>
        </div>
      </div>
    </>
  )
}

function AttemptLog(props: { selected: string | null; log: OpsEvent[]; snapshot: Snapshot | null; now: number }) {
  const [history, setHistory] = useState<OpsEvent[] | null>(null)
  useEffect(() => {
    setHistory(null)
    if (!props.selected) return
    let stopped = false
    read<{ events: OpsEvent[] }>(`attempts/${props.selected}/events`).then((answer) => { if (!stopped) setHistory(answer.events.slice().reverse()) }).catch(() => { if (!stopped) setHistory([]) })
    return () => { stopped = true }
  }, [props.selected])
  const channel = props.snapshot?.attempts.find((a) => a.attempt_id === props.selected)?.channel
  const rows = props.selected
    ? [...props.log.filter((event) => 'channel' in event && event.channel === channel), ...(history ?? [])].filter((event, index, all) => all.findIndex((other) => other.seq === event.seq) === index).slice(0, 60)
    : props.log.filter((event) => event.kind !== 'tick').slice(0, 40)
  if (rows.length === 0) return <p className="faint">none</p>
  return (
    <ol className="ops-log">
      {rows.map((event) => (
        <li key={event.seq}>
          <i style={{ background: COLOR[kindOf(event)] }} />
          <time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          <span>{describe(event)}</span>
        </li>
      ))}
    </ol>
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
    case 'tick': return `tick ${event.sources.join('+')} ${event.duration_ms} ms`
    case 'command': return `#${event.task} ← ${event.type}${event.outcome === 'failed' ? ' failed' : ''}`
    case 'telemetry': return `#${event.task} → ${event.type}`
    case 'board': return `${event.action} #${event.task}`
    case 'github': return `${event.action === 'draft_pr' ? 'draft PR' : 'push'} #${event.task}`
    case 'launch': return `launch #${event.task} ${event.outcome}`
    case 'attempt': return `#${event.task} ${event.state.replace('_', ' ')}`
    case 'fault': return `${event.component} ${event.code}${event.task ? ` #${event.task}` : ''}`
    case 'usage': return `#${event.task} r${event.round} ${usd(event.cost_usd)} ${tokens(event.input_tokens)}/${tokens(event.output_tokens)}`
  }
}

/** A gear outline with `teeth` teeth between radii `outer` and `inner`. */
function gearPath(cx: number, cy: number, outer: number, inner: number, teeth: number): string {
  const points: string[] = []
  const step = (Math.PI * 2) / (teeth * 4)
  for (let i = 0; i < teeth * 4; i++) {
    const r = i % 4 < 2 ? outer : inner
    const a = i * step
    points.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`)
  }
  return `M${points.join(' L')} Z`
}
