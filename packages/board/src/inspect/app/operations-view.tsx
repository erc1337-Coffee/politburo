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
  orchestrator: { actor: string; live: number; live_limit: number; outbox: number; sweep_seconds: number; last_tick: { at: number; sources: WakeSource[]; duration_ms: number } | null; ticks_last_minute: number }
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

const WIDTH = 1200
const ROW = 118
const TOP = 70
const SHOWN_WORKERS = 8
const CENTER = { board: { x: 120, y: 150 }, orchestrator: { x: 330, y: 260 }, ledger: { x: 330, y: 470 }, github: { x: 120, y: 410 }, relay: { x: 590, y: 0 } }

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
    case 'launch': return chain([`launch>${event.channel}`], 'command', `launch ${event.outcome}`, 5)
    case 'usage': return chain(['orchestrator>ledger'], 'usage', `${usd(event.cost_usd)} · ${tokens(event.output_tokens)} out`, 5, true)
    case 'tick': return event.sources.includes('board') ? chain(['board>orchestrator'], 'external', 'board event', 3) : []
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
  const height = Math.max(600, TOP + workers.length * ROW + 40)
  const relayY = Math.max(260, Math.min(height - 200, TOP + (workers.length * ROW) / 2))
  const relay = { x: CENTER.relay.x, y: relayY }
  const workerAt = (index: number) => ({ x: 760, y: TOP + index * ROW })

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
        for (const packet of packets.current) {
          const path = root.querySelector<SVGPathElement>(`path[data-edge="${CSS.escape(packet.edge)}"]`)
          const progress = (t - packet.started) / packet.duration
          if (!path || progress >= 1) {
            if (packet.then) next.push({ ...packet.then, started: t })
            if (path) path.classList.remove('hot')
            continue
          }
          path.classList.add('hot')
          path.style.setProperty('--hot', COLOR[packet.kind])
          const length = path.getTotalLength()
          const point = path.getPointAtLength(Math.max(0, progress) * length)
          const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
          dot.setAttribute('cx', String(point.x))
          dot.setAttribute('cy', String(point.y))
          dot.setAttribute('r', String(packet.size))
          dot.setAttribute('class', `packet${packet.ring ? ' ring' : ''}`)
          dot.style.setProperty('--c', COLOR[packet.kind])
          group.append(dot)
          if (progress > 0.15 && progress < 0.85) {
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
            label.setAttribute('x', String(point.x + 8))
            label.setAttribute('y', String(point.y - 8))
            label.setAttribute('class', 'packet-label')
            label.style.setProperty('--c', COLOR[packet.kind])
            label.textContent = packet.label
            group.append(label)
          }
          next.push(packet)
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

  const rate = (edge: string) => recent.current.filter((row) => row.edge === edge).length
  const flow = (edge: string) => ({ ['--flow' as string]: `${Math.max(0.6, 12 / (1 + rate(edge) / 4)).toFixed(2)}s`, ['--width' as string]: `${Math.min(5, 1.4 + rate(edge) / 10).toFixed(2)}px` })

  const curve = (a: { x: number; y: number }, b: { x: number; y: number }, bend = 0) => {
    const mx = (a.x + b.x) / 2
    return `M${a.x},${a.y} C${mx},${a.y + bend} ${mx},${b.y - bend} ${b.x},${b.y}`
  }
  const o = CENTER.orchestrator
  const orchestratorFault = (faults.board ?? 0) + (faults.relay ?? 0) + (faults.github ?? 0) + (faults.ledger ?? 0)
  const lastTick = snapshot?.orchestrator.last_tick
  const statistics = snapshot?.relay.statistics
  const usageOf = (attempt: string) => usage?.by_attempt.find((row) => row.attempt === attempt)?.figures
  const hourlyMax = Math.max(0.000001, ...(usage?.hourly ?? []).map((slot) => Number(slot.cost_usd)))

  const edge = (id: string, d: string, extra = '') => <path key={id} data-edge={id} d={d} className={`link ${extra}`} style={flow(id)} markerEnd="url(#ops-arrow)" />

  return (
    <>
      <Header title="operations" meta="board · orchestrator · relay · cloud workers · usage" live={live ? 'live' : 'reconnecting'} lead={props.lead} />
      <div className="view-body operations-view">
        {stateError && <p className="ops-note">The orchestrator status is not available: {stateError}.</p>}
        <svg ref={svg} className="ops-schematic" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Live operations schematic">
          <defs>
            <marker id="ops-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="arrowhead" /></marker>
            <radialGradient id="ops-heart"><stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></radialGradient>
          </defs>
          <rect className="zone" x={10} y={10} width={460} height={height - 20} rx={14} />
          <text className="zone-label" x={24} y={32}>LAN · this machine · no inbound port</text>
          <rect className="zone" x={490} y={10} width={200} height={height - 20} rx={14} />
          <text className="zone-label" x={504} y={32}>internet · relay</text>
          <rect className="zone" x={710} y={10} width={480} height={height - 20} rx={14} />
          <text className="zone-label" x={724} y={32}>Claude cloud sessions</text>

          {edge('board>orchestrator', curve({ x: CENTER.board.x + 70, y: CENTER.board.y + 14 }, { x: o.x - 64, y: o.y - 30 }, 10))}
          {edge('orchestrator>board', curve({ x: o.x - 60, y: o.y - 46 }, { x: CENTER.board.x + 76, y: CENTER.board.y - 6 }, -10))}
          {edge('orchestrator>relay', curve({ x: o.x + 64, y: o.y - 16 }, { x: relay.x - 50, y: relay.y - 24 }, -10))}
          {edge('relay>orchestrator', curve({ x: relay.x - 50, y: relay.y + 24 }, { x: o.x + 64, y: o.y + 16 }, 10))}
          {edge('orchestrator>github', curve({ x: o.x - 40, y: o.y + 52 }, { x: CENTER.github.x + 60, y: CENTER.github.y - 20 }, 20))}
          {edge('orchestrator>ledger', `M${o.x},${o.y + 66} L${CENTER.ledger.x},${CENTER.ledger.y - 62}`)}

          {workers.map((attempt, index) => {
            const at = workerAt(index)
            const dead = !LIVE.has(attempt.state)
            return (
              <g key={`links-${attempt.attempt_id}`} className={dead ? 'settled' : ''}>
                {edge(`relay>${attempt.channel}`, curve({ x: relay.x + 50, y: relay.y - 10 + index * 4 }, { x: at.x, y: at.y + 34 }, 0))}
                {edge(`${attempt.channel}>relay`, curve({ x: at.x, y: at.y + 62 }, { x: relay.x + 50, y: relay.y + 10 + index * 4 }, 0))}
                {edge(`launch>${attempt.channel}`, curve({ x: o.x + 40, y: o.y + 56 }, { x: at.x, y: at.y + 90 }, 60), 'launch')}
              </g>
            )
          })}

          {/* Board */}
          <g className={`node${snapshot?.board.reachable === false ? ' fault' : ''}`} key={`board-${faults.board ?? 0}`}>
            <rect x={CENTER.board.x - 90} y={CENTER.board.y - 60} width={180} height={110} rx={12} />
            <text className="node-title" x={CENTER.board.x - 76} y={CENTER.board.y - 36}>Board</text>
            <text className="node-line" x={CENTER.board.x - 76} y={CENTER.board.y - 16}>{snapshot?.board.reachable === false ? `unreachable (${snapshot.board.error})` : snapshot?.board.paused ? 'paused' : 'running'}</text>
            <text className="node-line faint" x={CENTER.board.x - 76} y={CENTER.board.y + 4}>claimed {snapshot?.attempts.filter((a) => LIVE.has(a.state)).length ?? 0}</text>
            <text className="node-line faint" x={CENTER.board.x - 76} y={CENTER.board.y + 24}>actor {snapshot?.orchestrator.actor || '—'}</text>
          </g>

          {/* GitHub */}
          <g className={`node${faults.github ? ' fault' : ''}`} key={`github-${faults.github ?? 0}`}>
            <rect x={CENTER.github.x - 90} y={CENTER.github.y - 40} width={180} height={76} rx={12} />
            <text className="node-title" x={CENTER.github.x - 76} y={CENTER.github.y - 16}>GitHub</text>
            <text className="node-line faint" x={CENTER.github.x - 76} y={CENTER.github.y + 4}>draft PRs {snapshot?.attempts.filter((a) => a.pr_url).length ?? 0}</text>
            <text className="node-line faint" x={CENTER.github.x - 76} y={CENTER.github.y + 22}>push and PR only by the orchestrator</text>
          </g>

          {/* Orchestrator: the heart */}
          <g className={`node heart${orchestratorFault ? ' fault' : ''}${(snapshot?.orchestrator.live ?? 0) === 0 ? ' idle' : ''}`}>
            <circle className="glow" cx={o.x} cy={o.y} r={92} fill="url(#ops-heart)" />
            <g key={beat.n} className="beat" style={{ ['--beat' as string]: beat.color }}>
              <circle cx={o.x} cy={o.y} r={66} />
            </g>
            <text className="node-title" x={o.x} y={o.y - 26} textAnchor="middle">Orchestrator</text>
            <text className="node-line" x={o.x} y={o.y - 6} textAnchor="middle">live {snapshot?.orchestrator.live ?? 0} / {snapshot?.orchestrator.live_limit ?? 0}</text>
            <text className="node-line faint" x={o.x} y={o.y + 12} textAnchor="middle">outbox {snapshot?.orchestrator.outbox ?? 0} · {snapshot?.orchestrator.ticks_last_minute ?? 0} ticks/min</text>
            <text className="node-line faint" x={o.x} y={o.y + 30} textAnchor="middle">{lastTick ? `${lastTick.sources.join('+')} ${ago(now, lastTick.at)} · ${lastTick.duration_ms} ms` : 'no tick yet'}</text>
          </g>

          {/* Ledger: usage gauge */}
          <g className={`node ledger${faults.ledger ? ' fault' : ''}`}>
            <rect x={CENTER.ledger.x - 120} y={CENTER.ledger.y - 62} width={240} height={128} rx={12} />
            <text className="node-title" x={CENTER.ledger.x - 106} y={CENTER.ledger.y - 40}>Usage ledger</text>
            {usage?.available ? (
              <>
                <text className="node-line" x={CENTER.ledger.x - 106} y={CENTER.ledger.y - 20}>today {usd(usage.today.cost_usd)} · {tokens(usage.today.input_tokens)} in · {tokens(usage.today.output_tokens)} out</text>
                <text className="node-line faint" x={CENTER.ledger.x - 106} y={CENTER.ledger.y - 2}>last hour {usd(usage.last_hour.cost_usd)} · {usage.last_hour.records} records{usage.today.unknown_records ? ` · ${usage.today.unknown_records} unknown` : ''}</text>
                {usage.hourly.map((slot, index) => {
                  const h = Math.max(1, (Number(slot.cost_usd) / hourlyMax) * 36)
                  return <rect key={slot.hour} className="spark" x={CENTER.ledger.x - 106 + index * 9} y={CENTER.ledger.y + 52 - h} width={7} height={h}><title>{new Date(slot.hour).getHours()}:00 · {usd(slot.cost_usd)}</title></rect>
                })}
              </>
            ) : (
              <text className="node-line faint" x={CENTER.ledger.x - 106} y={CENTER.ledger.y - 20}>{usage?.error ?? 'reading…'}</text>
            )}
          </g>

          {/* Relay: the hub */}
          <g className={`node relay${snapshot?.relay.reachable === false ? ' fault' : ''}`} key={`relay-${faults.relay ?? 0}`}>
            <circle cx={relay.x} cy={relay.y} r={52} />
            <circle className="ring" cx={relay.x} cy={relay.y} r={60} style={{ ['--spin' as string]: `${Math.max(1.5, 20 / (1 + (statistics ? Object.values(statistics.channels).reduce((sum, c) => sum + c.commands.streams + c.telemetry.streams, 0) : 0))).toFixed(1)}s` }} />
            <text className="node-title" x={relay.x} y={relay.y - 8} textAnchor="middle">Relay</text>
            <text className="node-line faint" x={relay.x} y={relay.y + 10} textAnchor="middle">{snapshot?.relay.reachable === false ? snapshot.relay.error : snapshot?.relay.latency_ms != null ? `${snapshot.relay.latency_ms} ms` : '—'}</text>
            <text className="node-line faint" x={relay.x} y={relay.y + 26} textAnchor="middle">{snapshot?.relay.host ?? ''}</text>
          </g>
          {statistics && (
            <text className="node-line faint" x={relay.x} y={relay.y + 86} textAnchor="middle">
              refused {Object.entries(statistics.refused).map(([status, count]) => `${status}×${count}`).join(' ') || 'none'}
            </text>
          )}

          {/* Workers: one engine per attempt */}
          {workers.map((attempt, index) => {
            const at = workerAt(index)
            const lane = statistics?.channels[attempt.channel]
            const waiting = attempt.state === 'waiting_answer'
            const running = attempt.heartbeat?.pi_alive && attempt.state === 'running'
            const fast = now - (spin[attempt.channel] ?? 0) < 2_500
            const figures = usageOf(attempt.attempt_id)
            const dead = !LIVE.has(attempt.state)
            const lost = attempt.state === 'awaiting_contact' && attempt.watchdog_due !== null && attempt.watchdog_due - now < 120_000
            return (
              <g key={`${attempt.attempt_id}-${faults[attempt.channel] ?? 0}`}
                className={`node worker${waiting ? ' waiting' : ''}${dead ? ' settled' : ''}${faults[attempt.channel] || lost ? ' fault' : ''}${selected === attempt.attempt_id ? ' selected' : ''}`}
                onClick={() => setSelected(selected === attempt.attempt_id ? null : attempt.attempt_id)} role="button" tabIndex={0}
                onKeyDown={(event) => { if (event.key === 'Enter') setSelected(selected === attempt.attempt_id ? null : attempt.attempt_id) }}>
                <rect x={at.x} y={at.y} width={420} height={ROW - 16} rx={12} />
                <text className="node-title" x={at.x + 14} y={at.y + 22}>#{attempt.task_id} · attempt {attempt.attempt_no} · round {attempt.round}</text>
                <text className="node-line faint" x={at.x + 14} y={at.y + 40}>{attempt.repository} · {attempt.branch}</text>
                <text className={`node-line state-${attempt.state}`} x={at.x + 128} y={at.y + 62}>{dead ? `${attempt.state} · ${attempt.outcome ?? ''}` : attempt.state.replace('_', ' ')} · contact {ago(now, attempt.last_contact_at)}</text>
                <text className="node-line faint" x={at.x + 128} y={at.y + 80}>
                  {figures ? `${usd(figures.cost_usd)} · ${tokens(figures.output_tokens)} out` : `${usd(attempt.cost_usd)}`} · cmd {lane?.commands.messages ?? attempt.messages.commands} · tel {lane?.telemetry.messages ?? attempt.messages.telemetry}
                  {Object.keys(attempt.progress).length > 0 && ` · ${Object.entries(attempt.progress).map(([kind, n]) => `${kind} ${n}`).join(' ')}`}
                </text>
                {/* engine: cylinder, piston, Pi gear */}
                <rect className="cylinder" x={at.x + 14} y={at.y + 50} width={36} height={42} rx={4} />
                <rect key={pistons[attempt.channel] ?? 0} className="piston" x={at.x + 18} y={at.y + 54} width={28} height={14} rx={2} />
                <g className={`gear${running ? ' turning' : ''}${fast ? ' fast' : ''}${waiting ? ' stopped' : ''}`} style={{ transformOrigin: `${at.x + 84}px ${at.y + 71}px` }}>
                  <path d={gearPath(at.x + 84, at.y + 71, 17, 12, 8)} />
                  <circle cx={at.x + 84} cy={at.y + 71} r={4} className="hub" />
                </g>
                <text className="node-line faint" x={at.x + 84} y={at.y + 100} textAnchor="middle">{attempt.heartbeat ? (attempt.heartbeat.pi_alive ? 'Pi' : 'Pi idle') : 'no Pi'}</text>
              </g>
            )
          })}
          {(snapshot?.attempts.length ?? 0) === 0 && <text className="node-line faint" x={780} y={TOP + 40}>No worker sessions. A ready task in a channel with a repository starts one.</text>}
          {(snapshot?.attempts.length ?? 0) > SHOWN_WORKERS && <text className="node-line faint" x={780} y={height - 24}>{snapshot!.attempts.length - SHOWN_WORKERS} more attempts not shown</text>}

          <g ref={layer} className="packets" />
        </svg>

        <div className="ops-panels">
          <section className="ops-panel">
            <h2>Usage by model</h2>
            {usage?.available && usage.by_model.length > 0 ? (
              <table className="ops-table">
                <thead><tr><th>model</th><th>records</th><th>in</th><th>out</th><th>cost (estimate)</th><th>unknown</th></tr></thead>
                <tbody>{usage.by_model.map((row) => (
                  <tr key={row.model}><td>{row.model}</td><td>{row.figures.records}</td><td>{tokens(row.figures.input_tokens)}</td><td>{tokens(row.figures.output_tokens)}</td><td>{usd(row.figures.cost_usd)}</td><td>{row.figures.unknown_records || ''}</td></tr>
                ))}</tbody>
                <tfoot><tr><td>total</td><td>{usage.total.records}</td><td>{tokens(usage.total.input_tokens)}</td><td>{tokens(usage.total.output_tokens)}</td><td>{usd(usage.total.cost_usd)}</td><td>{usage.total.unknown_records || ''}</td></tr></tfoot>
              </table>
            ) : <p className="faint">{usage?.error ?? 'No usage records yet.'}</p>}
            <p className="faint small">Costs are the priced estimates the workers report. A record with an unknown count is shown as unknown, never as zero. The Claude subscription window is not reported.</p>
          </section>
          <section className="ops-panel">
            <h2>{selected ? `Attempt ${snapshot?.attempts.find((a) => a.attempt_id === selected)?.task_id ?? ''} messages` : 'Messages'}</h2>
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
  if (rows.length === 0) return <p className="faint">No messages yet.</p>
  return (
    <ol className="ops-log">
      {rows.map((event) => (
        <li key={event.seq}>
          <i style={{ background: COLOR[kindOf(event)] }} />
          <time>{new Date(event.at).toLocaleTimeString()}</time>
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
    case 'tick': return `tick (${event.sources.join(', ')}) ${event.duration_ms} ms`
    case 'command': return `#${event.task} ← ${event.type} (${event.bytes} B)${event.outcome === 'failed' ? ' failed' : ''}`
    case 'telemetry': return `#${event.task} → ${event.type} (${event.bytes} B, relay #${event.relay_seq})`
    case 'board': return `board ${event.action} #${event.task}`
    case 'github': return `GitHub ${event.action === 'draft_pr' ? 'draft PR' : 'push'} ${event.repository} #${event.task}`
    case 'launch': return `launch #${event.task}: ${event.outcome}`
    case 'attempt': return `#${event.task} is ${event.state.replace('_', ' ')}`
    case 'fault': return `fault in ${event.component}: ${event.code}${event.task ? ` (#${event.task})` : ''}`
    case 'usage': return `#${event.task} round ${event.round}: ${usd(event.cost_usd)}, ${tokens(event.input_tokens)} in, ${tokens(event.output_tokens)} out, ${event.models} models`
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
