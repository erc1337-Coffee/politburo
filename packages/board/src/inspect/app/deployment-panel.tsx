// The deployment tab of the channel settings: none, local listeners, or Railway; and the
// deployment status line of the channel view. Requests go through the board server to the
// orchestrator, which reaches the listener supervisor and Railway.
import { useEffect, useState } from 'react'
import type { ChannelListener, ChannelLocalDeployment, ChannelSettings } from '../../contract/channel-settings.ts'
import * as board from './board.ts'
import { orchestratorCall, RailwayPanel } from './railway-panel.tsx'

type Endpoint = { address: string; interface: string; port: number; open: boolean; connect_ms: number | null; since: string; checked_at: string }
type Container = { exists: boolean; state: string | null; running: boolean; started_at: string | null; exit_code: number | null; restart_count: number }
type ListenerStatus = {
  id: string; name: string; subpath: string; port: number; container_port: number; interfaces: string[]
  container: Container | null; endpoints: Endpoint[]; last_build: { commit: string; branch: string; at: string } | null; error?: string
}
type RailwayStatus = { id: string; name: string; domains?: string[]; latest?: { status: string } | null; active?: string[]; error?: string }
type Summary = { listeners: ListenerStatus[] | null; railway: RailwayStatus[] | null }

const call = <T,>(path: string, init: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}) => orchestratorCall<T>('deployment', path, init)
const said = (error: unknown) => (error instanceof Error ? error.message : String(error))
const channelPath = (channel: string) => `channels/${encodeURIComponent(channel)}`

/** How long ago `iso` was, in the largest whole unit. */
export function elapsed(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h`
  return `${Math.floor(seconds / 86_400)} d`
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
/** A listener's id: the channel's prefix, then its name; unique on the host. */
export const listenerId = (channel: string, name: string) => `${slug(channel).slice(0, 30)}-${slug(name).slice(0, 30) || 'listener'}`

type Kind = 'none' | 'local' | 'railway'
const kindOf = (settings: ChannelSettings): Kind => (settings.local ? 'local' : settings.railway ? 'railway' : 'none')

export function DeploymentPanel(props: { channel: string; settings: ChannelSettings }) {
  const current = kindOf(props.settings)
  const [kind, setKind] = useState<Kind>(current)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setKind(kindOf(props.settings)), [props.settings])
  const save = async (next: ChannelSettings) => {
    setError(null)
    const refused = await board.saveChannel(props.channel, next, false)
    if (refused) setError(refused)
    return refused
  }
  const choose = async (next: Kind) => {
    if (next === current) return setKind(next)
    if (current === 'local' && (props.settings.local?.listeners.length ?? 0) > 0) return setError('remove the listeners first')
    if (current === 'railway' && next !== 'railway') return setError('turn off Railway first, in its services')
    if (next === 'none') return void save({ ...props.settings, local: null, railway: null })
    setKind(next)
  }
  return (
    <div className="deployment">
      <div className="deployment-kinds" role="radiogroup" aria-label="deployment">
        {(['none', 'local', 'railway'] as const).map((name) => (
          <label key={name} className={`deployment-kind${kind === name ? ' on' : ''}`}>
            <input type="radio" name="deployment-kind" checked={kind === name} onChange={() => void choose(name)} /> {name}
          </label>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {kind === 'railway' && <RailwayPanel channel={props.channel} settings={props.settings} />}
      {kind === 'local' && (props.settings.local
        ? <LocalPanel channel={props.channel} settings={props.settings} local={props.settings.local} save={save} />
        : <TurnOnLocal settings={props.settings} save={save} />)}
    </div>
  )
}

function TurnOnLocal({ settings, save }: { settings: ChannelSettings; save: (next: ChannelSettings) => Promise<string | null> }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const turnOn = async () => {
    setBusy(true)
    try {
      const { dockerfile } = await call<{ dockerfile: string }>('template')
      await save({ ...settings, railway: null, local: { dockerfile, listeners: [] } })
    } catch (failed) {
      setError(said(failed))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="field">
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="send" disabled={busy} onClick={() => void turnOn()}>{busy ? 'turning on…' : 'turn on'}</button>
    </div>
  )
}

function LocalPanel(props: { channel: string; settings: ChannelSettings; local: ChannelLocalDeployment; save: (next: ChannelSettings) => Promise<string | null> }) {
  const { channel, settings, local } = props
  const [statuses, setStatuses] = useState<ListenerStatus[] | null>(null)
  const [addresses, setAddresses] = useState<Record<string, string> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [logs, setLogs] = useState<{ id: string; lines: string[] | null } | null>(null)
  const [editing, setEditing] = useState<ChannelListener | 'new' | null>(null)
  const [showDockerfile, setShowDockerfile] = useState(false)
  const load = () => call<Summary>(channelPath(channel)).then((answer) => { setStatuses(answer.listeners ?? []); setError(null) }, (failed) => setError(said(failed)))
  useEffect(() => {
    call<{ addresses: Record<string, string> }>('addresses').then((answer) => setAddresses(answer.addresses), (failed) => setError(said(failed)))
  }, [])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 10_000)
    return () => clearInterval(timer)
  }, [channel, local.listeners.map((listener) => `${listener.id}:${listener.port}`).join()])
  useEffect(() => {
    if (!logs) return
    const read = () => call<{ lines: string[] }>(`${channelPath(channel)}/listeners/${logs.id}/logs?tail=200`)
      .then((answer) => setLogs((now) => (now?.id === logs.id ? { ...now, lines: answer.lines } : now)), (failed) => setError(said(failed)))
    void read()
    const timer = setInterval(() => void read(), 10_000)
    return () => clearInterval(timer)
  }, [logs?.id])
  const act = async (id: string, action: 'start' | 'stop' | 'reload') => {
    setBusy(`${id}:${action}`)
    setError(null)
    try {
      await call(`${channelPath(channel)}/listeners/${id}/${action}`, { method: 'POST', body: {} })
    } catch (failed) {
      setError(said(failed))
    } finally {
      setBusy(null)
      void load()
    }
  }
  const remove = async (listener: ChannelListener) => {
    setBusy(`${listener.id}:remove`)
    await call(`${channelPath(channel)}/listeners/${listener.id}/stop`, { method: 'POST', body: {} }).catch(() => null)
    await props.save({ ...settings, local: { ...local, listeners: local.listeners.filter((entry) => entry.id !== listener.id) } })
    setBusy(null)
  }
  const saveListener = async (listener: ChannelListener, before: ChannelListener | null) => {
    const listeners = before ? local.listeners.map((entry) => (entry.id === before.id ? listener : entry)) : [...local.listeners, listener]
    const refused = await props.save({ ...settings, local: { ...local, listeners } })
    if (!refused) setEditing(null)
    return refused
  }
  const byId = new Map((statuses ?? []).map((status) => [status.id, status]))
  return (
    <div className="deployment-local">
      {error && <p className="error" role="alert">{error}</p>}
      {local.listeners.length === 0 && <span className="hint">no listeners yet</span>}
      <ul className="railway-list">
        {local.listeners.map((listener) => {
          const status = byId.get(listener.id)
          const container = status?.container
          return (
            <li key={listener.id} className="railway-service">
              <div className="railway-service-head">
                <b>{listener.name}</b>
                <span className="hint">{listener.subpath || '.'} · port {listener.port}{listener.containerPort !== listener.port ? ` → ${listener.containerPort}` : ''}</span>
                <span className={`railway-status ${container?.running ? 'success' : container?.exists ? 'stopped' : 'none'}`}>
                  {container ? (container.exists ? container.state ?? 'unknown' : 'not built') : status?.error ? 'unknown' : '…'}
                </span>
                {status?.last_build && <span className="hint">{status.last_build.branch} {status.last_build.commit.slice(0, 7)}</span>}
              </div>
              <EndpointList endpoints={status?.endpoints ?? []} />
              {status?.error && <span className="hint">{status.error}</span>}
              <div className="railway-actions">
                {(['start', 'stop', 'reload'] as const).map((action) => (
                  <button key={action} type="button" className="act" disabled={busy !== null} title={action === 'reload' ? 'rebuild and restart' : undefined}
                    onClick={() => void act(listener.id, action)}>{busy === `${listener.id}:${action}` ? `${action}…` : action}</button>
                ))}
                <button type="button" className="act" aria-pressed={logs?.id === listener.id} onClick={() => setLogs((now) => (now?.id === listener.id ? null : { id: listener.id, lines: null }))}>logs</button>
                <button type="button" className="act" disabled={busy !== null} onClick={() => setEditing(listener)}>edit</button>
                <button type="button" className="act" disabled={busy !== null} title="stops it"
                  onClick={() => void remove(listener)}>remove</button>
              </div>
              {logs?.id === listener.id && <pre className="railway-log">{logs.lines === null ? 'loading…' : logs.lines.length === 0 ? 'no lines' : logs.lines.join('\n')}</pre>}
              {editing !== 'new' && editing?.id === listener.id && (
                <ListenerForm channel={channel} addresses={addresses} listener={listener} others={local.listeners.filter((entry) => entry.id !== listener.id)}
                  save={(next) => saveListener(next, listener)} cancel={() => setEditing(null)} />
              )}
            </li>
          )
        })}
      </ul>
      {editing === 'new'
        ? <ListenerForm channel={channel} addresses={addresses} listener={null} others={local.listeners} save={(next) => saveListener(next, null)} cancel={() => setEditing(null)} />
        : <div className="railway-footer"><button type="button" className="act" onClick={() => setEditing('new')}>add listener</button>
          <button type="button" className="act" aria-pressed={showDockerfile} onClick={() => setShowDockerfile((now) => !now)}>Dockerfile</button></div>}
      {showDockerfile && (
        <>
          <pre className="railway-log dockerfile-view" title="read only">{local.dockerfile}</pre>
        </>
      )}
    </div>
  )
}

function ListenerForm(props: {
  channel: string; addresses: Record<string, string> | null; listener: ChannelListener | null; others: ChannelListener[]
  save: (listener: ChannelListener) => Promise<string | null>; cancel: () => void
}) {
  const [name, setName] = useState(props.listener?.name ?? '')
  const [subpath, setSubpath] = useState(props.listener?.subpath ?? '')
  const [port, setPort] = useState(String(props.listener?.port ?? ''))
  const [containerPort, setContainerPort] = useState(String(props.listener?.containerPort ?? ''))
  const [interfaces, setInterfaces] = useState<Set<string>>(new Set(props.listener?.interfaces ?? ['lan']))
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const listener: ChannelListener = {
      id: props.listener?.id ?? listenerId(props.channel, name),
      name: name.trim(), subpath: subpath.trim().replace(/^\/+|\/+$/g, ''),
      port: Number(port), containerPort: Number(containerPort || port), interfaces: [...interfaces],
    }
    if (!listener.name) return setError('name required')
    if (!Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65_535) return setError('port from 1 to 65535')
    if (!Number.isInteger(listener.containerPort) || listener.containerPort < 1 || listener.containerPort > 65_535) return setError('container port from 1 to 65535')
    if (listener.interfaces.length === 0) return setError('choose at least one interface')
    if (props.others.some((other) => other.id === listener.id)) return setError('another listener has this name')
    if (props.others.some((other) => other.port === listener.port)) return setError('another listener has this port')
    const refused = await props.save(listener)
    if (refused) setError(refused)
  }
  return (
    <div className="railway-settings field listener-form">
      <label className="railway-setting"><span className="field-name">name</span>
        <input type="text" value={name} disabled={props.listener !== null} onChange={(event) => setName(event.target.value)} spellCheck={false} /></label>
      <label className="railway-setting"><span className="field-name">subpath</span>
        <input type="text" value={subpath} placeholder="/" onChange={(event) => setSubpath(event.target.value)} spellCheck={false} /></label>
      <label className="railway-setting"><span className="field-name">port</span>
        <input type="text" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} /></label>
      <label className="railway-setting"><span className="field-name">container port</span>
        <input type="text" inputMode="numeric" value={containerPort} placeholder="= port" onChange={(event) => setContainerPort(event.target.value)} /></label>
      <fieldset className="railway-setting"><span className="field-name">interfaces</span>
        <span className="railway-row">
          {props.addresses === null ? <span className="hint">loading…</span> : Object.entries(props.addresses).map(([interfaceName, address]) => (
            <label key={interfaceName}><input type="checkbox" checked={interfaces.has(interfaceName)}
              onChange={() => setInterfaces((now) => { const next = new Set(now); next.has(interfaceName) ? next.delete(interfaceName) : next.add(interfaceName); return next })} /> {interfaceName} {address}</label>
          ))}
        </span>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="railway-row">
        <button type="button" className="send" onClick={() => void submit()}>{props.listener ? 'save' : 'add'}</button>
        <button type="button" className="act" onClick={props.cancel}>cancel</button>
      </div>
    </div>
  )
}

function EndpointList({ endpoints }: { endpoints: Endpoint[] }) {
  if (endpoints.length === 0) return null
  return (
    <div className="railway-row endpoint-list">
      {endpoints.map((endpoint) => (
        <span key={`${endpoint.address}:${endpoint.port}`} className={`endpoint ${endpoint.open ? 'open' : 'closed'}`}
          title={`${endpoint.interface}; checked ${elapsed(endpoint.checked_at)} ago`}>
          <i aria-hidden="true" />{endpoint.address}:{endpoint.port} {endpoint.open ? `open ${endpoint.connect_ms} ms` : 'closed'} · {elapsed(endpoint.since)}
        </span>
      ))}
    </div>
  )
}

/** The channel view's line of what the channel runs: listener endpoints with their health, Railway services with their state. */
export function DeploymentStatusLine({ channel, settings }: { channel: string; settings: ChannelSettings | undefined }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const active = Boolean(settings?.local?.listeners.length || settings?.railway?.services.length)
  useEffect(() => {
    setSummary(null)
    if (!active) return
    const load = () => void call<Summary>(channelPath(channel)).then(setSummary, () => setSummary(null))
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [channel, active])
  if (!active || !summary) return null
  const listeners = summary.listeners ?? []
  const services = summary.railway ?? []
  if (listeners.length === 0 && services.length === 0) return null
  return (
    <div className="deployment-line" aria-label="deployment status">
      {listeners.map((listener) => (
        <span key={listener.id} className="deployment-item">
          <b>{listener.name}</b>
          {listener.endpoints.length === 0
            ? <span className="endpoint closed"><i aria-hidden="true" />{listener.container?.running ? 'running' : 'not running'}</span>
            : listener.endpoints.map((endpoint) => (
              <a key={`${endpoint.address}:${endpoint.port}`} className={`endpoint ${endpoint.open ? 'open' : 'closed'}`} href={`http://${endpoint.address}:${endpoint.port}/`} target="_blank" rel="noreferrer"
                title={`${endpoint.interface}; ${endpoint.open ? `connects in ${endpoint.connect_ms} ms` : 'refuses connections'} for ${elapsed(endpoint.since)}`}>
                <i aria-hidden="true" />{endpoint.address}:{endpoint.port} · {elapsed(endpoint.since)}
              </a>
            ))}
        </span>
      ))}
      {services.map((service) => {
        const ok = !service.error && service.latest?.status === 'SUCCESS' && (service.active?.length ?? 0) > 0
        const domain = service.domains?.[0]
        return (
          <span key={service.id} className="deployment-item">
            <b>{service.name}</b>
            <span className={`endpoint ${ok ? 'open' : 'closed'}`}><i aria-hidden="true" />{service.error ? 'unknown' : (service.active?.length ?? 0) === 0 ? 'stopped' : service.latest?.status ?? 'never deployed'}</span>
            {domain && <a href={`https://${domain}`} target="_blank" rel="noreferrer">{domain}</a>}
          </span>
        )
      })}
    </div>
  )
}
