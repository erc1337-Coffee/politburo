// The Railway tab of the channel settings: the channel's Railway services, their variables and
// their build and deploy settings. Every request goes through the board server to the
// orchestrator, which holds the Railway token. Railway is off until a project is chosen here.
import { useEffect, useState } from 'react'
import type { ChannelRailway, ChannelSettings } from '../../contract/channel-settings.ts'
import * as board from './board.ts'
import { base } from './nav.tsx'

type Deployment = { id: string; status: string; createdAt: string; stopped: boolean; url: string | null; canRedeploy: boolean; canRollback: boolean; commit: string | null }
type ServiceStatus = { id: string; name: string; domains?: string[]; latest?: Deployment | null; active?: string[]; error?: string }
type Project = { id: string; name: string; production: { id: string; name: string } | null; services: Array<{ id: string; name: string }> }
type LogLine = { timestamp: string; severity: string | null; message: string }
type Settings = Record<string, unknown> & { source?: { repo: string | null; image: string | null; branch: string | null } }

const ACTIONS = ['start', 'stop', 'restart', 'redeploy', 'rollback'] as const
const SECTIONS = ['services', 'variables', 'settings'] as const
type Section = (typeof SECTIONS)[number]

/** The build and deploy settings the tab edits, with how each is typed. */
const FIELDS: Array<{ key: string; label: string; kind: 'text' | 'number' | 'list' | 'boolean' }> = [
  { key: 'rootDirectory', label: 'root directory', kind: 'text' },
  { key: 'builder', label: 'builder (RAILPACK, NIXPACKS, HEROKU, PAKETO)', kind: 'text' },
  { key: 'dockerfilePath', label: 'Dockerfile path', kind: 'text' },
  { key: 'railwayConfigFile', label: 'railway config file', kind: 'text' },
  { key: 'buildCommand', label: 'build command', kind: 'text' },
  { key: 'startCommand', label: 'start command', kind: 'text' },
  { key: 'preDeployCommand', label: 'pre-deploy commands, one per line', kind: 'list' },
  { key: 'healthcheckPath', label: 'health check path', kind: 'text' },
  { key: 'healthcheckTimeout', label: 'health check timeout, seconds', kind: 'number' },
  { key: 'restartPolicyType', label: 'restart policy (ALWAYS, ON_FAILURE, NEVER)', kind: 'text' },
  { key: 'restartPolicyMaxRetries', label: 'restart retries', kind: 'number' },
  { key: 'numReplicas', label: 'replicas', kind: 'number' },
  { key: 'region', label: 'region', kind: 'text' },
  { key: 'sleepApplication', label: 'sleep when idle', kind: 'boolean' },
  { key: 'cronSchedule', label: 'cron schedule', kind: 'text' },
  { key: 'watchPatterns', label: 'watch patterns, one per line', kind: 'list' },
]

const token = () => document.querySelector<HTMLMetaElement>('meta[name="inspect-token"]')?.content ?? ''

async function call<T>(path: string, init: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${location.origin}${base}/api/railway/${path}`, {
    method: init.method ?? 'GET',
    headers: { 'x-inspect-token': token(), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const body = await response.json().catch(() => null) as (T & { error?: string | { message?: string } }) | null
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : body?.error?.message ?? `status ${response.status}`)
  return body as T
}

const channelPath = (channel: string) => `channels/${encodeURIComponent(channel)}`
const said = (error: unknown) => (error instanceof Error ? error.message : String(error))
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function RailwayPanel(props: { channel: string; settings: ChannelSettings }) {
  const railway = props.settings.railway ?? null
  const [section, setSection] = useState<Section>('services')
  const save = (next: ChannelRailway | null) => board.saveChannel(props.channel, { ...props.settings, railway: next }, false)
  if (!railway) return <Attach save={save} />
  return (
    <div className="railway">
      <nav className="tabs plain railway-sections">
        {SECTIONS.map((name) => (
          <button key={name} type="button" className="tab" aria-current={name === section ? 'page' : undefined} onClick={() => setSection(name)}>{name}</button>
        ))}
        <span className="tab-actions"><span className="hint">{railway.projectName} · production</span></span>
      </nav>
      {section === 'services' && <Services channel={props.channel} railway={railway} save={save} />}
      {section === 'variables' && <Variables channel={props.channel} railway={railway} />}
      {section === 'settings' && <ServiceSettings channel={props.channel} railway={railway} />}
    </div>
  )
}

/** Railway off: choose a project and the services to attach. */
function Attach({ save }: { save: (next: ChannelRailway | null) => Promise<string | null> }) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [project, setProject] = useState<string>('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  useEffect(() => { call<{ projects: Project[] }>('projects').then((answer) => setProjects(answer.projects), (failed) => setError(said(failed))) }, [])
  const picked = projects?.find((entry) => entry.id === project) ?? null
  const turnOn = async () => {
    if (!picked?.production) return
    const refused = await save({
      projectId: picked.id, projectName: picked.name, environmentId: picked.production.id,
      services: picked.services.filter((service) => chosen.has(service.id)),
    })
    if (refused) setError(refused)
  }
  return (
    <div className="railway field">
      <p className="hint">Railway is off for this channel. Choose a project: its production environment is used.</p>
      {projects === null ? <span className="hint">{error ?? 'loading…'}</span> : (
        <>
          <select value={project} onChange={(event) => { setProject(event.target.value); setChosen(new Set()) }}>
            <option value="">project</option>
            {projects.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.production}>{entry.name}{entry.production ? '' : ' (no production environment)'}</option>)}
          </select>
          {picked && (
            <ul className="railway-choices">
              {picked.services.map((service) => (
                <li key={service.id}><label><input type="checkbox" checked={chosen.has(service.id)}
                  onChange={() => setChosen((current) => { const next = new Set(current); next.has(service.id) ? next.delete(service.id) : next.add(service.id); return next })} /> {service.name}</label></li>
              ))}
              {picked.services.length === 0 && <li className="hint">no services yet: create them after turning Railway on</li>}
            </ul>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <button type="button" className="send" disabled={!picked?.production} onClick={() => void turnOn()}>turn on Railway</button>
        </>
      )}
    </div>
  )
}

function Services({ channel, railway, save }: { channel: string; railway: ChannelRailway; save: (next: ChannelRailway | null) => Promise<string | null> }) {
  const [statuses, setStatuses] = useState<ServiceStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [logs, setLogs] = useState<{ service: string; kind: 'deploy' | 'build'; lines: LogLine[] | null } | null>(null)
  const [editing, setEditing] = useState(false)
  const load = () => call<{ services: ServiceStatus[] }>(`${channelPath(channel)}/services`).then((answer) => { setStatuses(answer.services); setError(null) }, (failed) => setError(said(failed)))
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [channel, railway.services.map((service) => service.id).join()])
  useEffect(() => {
    if (!logs) return
    const read = () => call<{ lines: LogLine[] }>(`${channelPath(channel)}/services/${logs.service}/logs?kind=${logs.kind}&limit=100`)
      .then((answer) => setLogs((current) => current && current.service === logs.service && current.kind === logs.kind ? { ...current, lines: answer.lines } : current), (failed) => setError(said(failed)))
    void read()
    const timer = setInterval(() => void read(), 15_000)
    return () => clearInterval(timer)
  }, [logs?.service, logs?.kind])
  const act = async (service: string, action: (typeof ACTIONS)[number]) => {
    setBusy(`${service}:${action}`)
    try {
      await call(`${channelPath(channel)}/services/${service}/${action}`, { method: 'POST', body: {} })
      await load()
    } catch (failed) {
      setError(said(failed))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="railway-services">
      {error && <p className="error" role="alert">{error}</p>}
      {statuses === null ? <span className="hint">loading…</span> : statuses.length === 0 ? <span className="hint">no services attached</span> : (
        <ul className="railway-list">
          {statuses.map((service) => (
            <li key={service.id} className="railway-service">
              <div className="railway-service-head">
                <b>{service.name}</b>
                {service.error ? <span className="hint">{service.error}</span> : (
                  <>
                    <span className={`railway-status ${(service.latest?.status ?? 'none').toLowerCase()}${service.active?.length === 0 ? ' stopped' : ''}`}>
                      {service.latest ? (service.active?.length === 0 && service.latest.status === 'SUCCESS' ? 'STOPPED' : service.latest.status) : 'never deployed'}
                    </span>
                    {service.latest && <span className="hint">{when(service.latest.createdAt)}{service.latest.commit ? ` · ${service.latest.commit.slice(0, 7)}` : ''}</span>}
                    {service.domains?.map((domain) => <a key={domain} href={`https://${domain}`} target="_blank" rel="noreferrer">{domain}</a>)}
                  </>
                )}
              </div>
              <div className="railway-actions">
                {ACTIONS.map((action) => (
                  <button key={action} type="button" className="act" disabled={busy !== null} onClick={() => void act(service.id, action)}>
                    {busy === `${service.id}:${action}` ? `${action}…` : action}
                  </button>
                ))}
                {(['deploy', 'build'] as const).map((kind) => (
                  <button key={kind} type="button" className="act" aria-pressed={logs?.service === service.id && logs.kind === kind}
                    onClick={() => setLogs((current) => current?.service === service.id && current.kind === kind ? null : { service: service.id, kind, lines: null })}>{kind} log</button>
                ))}
              </div>
              {logs?.service === service.id && (
                <pre className="railway-log">{logs.lines === null ? 'loading…' : logs.lines.length === 0 ? 'no lines' : logs.lines.map((line) => `${line.timestamp.slice(11, 19)}  ${line.message}`).join('\n')}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="railway-footer">
        <button type="button" className="act" onClick={() => setEditing((now) => !now)} aria-pressed={editing}>attach or create</button>
        <button type="button" className="act" onClick={() => void save(null)} title="detaches the channel from Railway; nothing on Railway changes">turn off Railway</button>
      </div>
      {editing && <AttachServices channel={channel} railway={railway} save={save} />}
    </div>
  )
}

/** Attach more services of the project, detach some, or create one from the channel's repository. */
function AttachServices({ channel, railway, save }: { channel: string; railway: ChannelRailway; save: (next: ChannelRailway | null) => Promise<string | null> }) {
  const [project, setProject] = useState<Project | null>(null)
  const [chosen, setChosen] = useState(new Set(railway.services.map((service) => service.id)))
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    call<{ projects: Project[] }>('projects').then((answer) => setProject(answer.projects.find((entry) => entry.id === railway.projectId) ?? null), (failed) => setError(said(failed)))
  }, [railway.projectId])
  const apply = async () => {
    if (!project) return
    const refused = await save({ ...railway, services: project.services.filter((service) => chosen.has(service.id)) })
    if (refused) setError(refused)
  }
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { service } = await call<{ service: { id: string; name: string } }>(`${channelPath(channel)}/services`, { method: 'POST', body: { name, ...(branch.trim() ? { branch } : {}) } })
      const refused = await save({ ...railway, services: [...railway.services, service] })
      if (refused) setError(refused)
      setName('')
    } catch (failed) {
      setError(said(failed))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="railway-attach field">
      {project === null ? <span className="hint">{error ?? 'loading…'}</span> : (
        <ul className="railway-choices">
          {project.services.map((service) => (
            <li key={service.id}><label><input type="checkbox" checked={chosen.has(service.id)}
              onChange={() => setChosen((current) => { const next = new Set(current); next.has(service.id) ? next.delete(service.id) : next.add(service.id); return next })} /> {service.name}</label></li>
          ))}
        </ul>
      )}
      <button type="button" className="act" disabled={!project} onClick={() => void apply()}>attach the checked services</button>
      <div className="railway-create">
        <input type="text" value={name} placeholder="new service name" onChange={(event) => setName(event.target.value)} spellCheck={false} />
        <input type="text" value={branch} placeholder="branch (default branch when empty)" onChange={(event) => setBranch(event.target.value)} spellCheck={false} />
        <button type="button" className="act" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? 'creating…' : 'create from the channel repository'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

function ServicePicker({ railway, value, onChange }: { railway: ChannelRailway; value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {railway.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
    </select>
  )
}

/** The service's variables, read only while this section is open. A removal becomes a task for a person. */
function Variables({ channel, railway }: { channel: string; railway: ChannelRailway }) {
  const [service, setService] = useState(railway.services[0]?.id ?? '')
  const [rows, setRows] = useState<Array<{ name: string; value: string; was: string | null; remove: boolean }> | null>(null)
  const [shown, setShown] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const load = () => {
    setRows(null)
    call<{ variables: Record<string, string> }>(`${channelPath(channel)}/services/${service}/variables`).then(
      (answer) => setRows(Object.entries(answer.variables).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value, was: value, remove: false }))),
      (failed) => setError(said(failed)),
    )
  }
  useEffect(() => { if (service) load() }, [service])
  if (!service) return <span className="hint">no services attached</span>
  const save = async () => {
    if (!rows) return
    setError(null)
    setNote(null)
    const set = Object.fromEntries(rows.filter((row) => !row.remove && row.name.trim() && row.value !== row.was).map((row) => [row.name.trim(), row.value]))
    const remove = rows.filter((row) => row.remove && row.was !== null).map((row) => row.name)
    try {
      const answer = await call<{ set: string[]; removal_task: string | null }>(`${channelPath(channel)}/services/${service}/variables`, { method: 'PUT', body: { set, remove } })
      setNote([answer.set.length ? `set ${answer.set.join(', ')}` : '', answer.removal_task ? `removal asked in task #${answer.removal_task}` : ''].filter(Boolean).join(' · ') || 'nothing changed')
      load()
    } catch (failed) {
      setError(said(failed))
    }
  }
  return (
    <div className="railway-variables field">
      <div className="railway-row">
        <ServicePicker railway={railway} value={service} onChange={setService} />
        <label className="hint"><input type="checkbox" checked={shown} onChange={() => setShown((now) => !now)} /> show values</label>
      </div>
      {rows === null ? <span className="hint">{error ?? 'loading…'}</span> : (
        <table className="railway-table">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={row.remove ? 'removed' : ''}>
                <td><input type="text" value={row.name} disabled={row.was !== null} spellCheck={false}
                  onChange={(event) => setRows((current) => current && current.map((entry, j) => (j === i ? { ...entry, name: event.target.value } : entry)))} /></td>
                <td><input type={shown ? 'text' : 'password'} value={row.value} spellCheck={false} autoComplete="off"
                  onChange={(event) => setRows((current) => current && current.map((entry, j) => (j === i ? { ...entry, value: event.target.value } : entry)))} /></td>
                <td><button type="button" className="act" aria-pressed={row.remove} title="asks a person to remove it; the orchestrator removes nothing"
                  onClick={() => setRows((current) => current && current.map((entry, j) => (j === i ? { ...entry, remove: !entry.remove } : entry)))}>remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="railway-row">
        <button type="button" className="act" disabled={rows === null} onClick={() => setRows((current) => [...(current ?? []), { name: '', value: '', was: null, remove: false }])}>add variable</button>
        <button type="button" className="send" disabled={rows === null} onClick={() => void save()}>save</button>
      </div>
      {note && <p className="hint">{note}</p>}
      {error && rows !== null && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

/** The service's build and deploy settings; a save sends only what changed. */
function ServiceSettings({ channel, railway }: { channel: string; railway: ChannelRailway }) {
  const [service, setService] = useState(railway.services[0]?.id ?? '')
  const [loaded, setLoaded] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Record<string, string | boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const shown = (settings: Settings) => Object.fromEntries(FIELDS.map((field) => {
    const value = settings[field.key]
    if (field.kind === 'boolean') return [field.key, value === true]
    if (field.kind === 'list') return [field.key, Array.isArray(value) ? value.join('\n') : '']
    return [field.key, value === null || value === undefined ? '' : String(value)]
  }))
  const load = () => {
    setLoaded(null)
    call<{ settings: Settings }>(`${channelPath(channel)}/services/${service}/settings`).then((answer) => { setLoaded(answer.settings); setDraft(shown(answer.settings)) }, (failed) => setError(said(failed)))
  }
  useEffect(() => { if (service) load() }, [service])
  if (!service) return <span className="hint">no services attached</span>
  const save = async () => {
    if (!loaded) return
    const before = shown(loaded)
    const change: Record<string, unknown> = {}
    for (const field of FIELDS) {
      const value = draft[field.key]
      if (value === before[field.key]) continue
      if (field.kind === 'boolean') change[field.key] = value === true
      else if (field.kind === 'list') change[field.key] = String(value).split('\n').map((line) => line.trim()).filter(Boolean)
      else if (field.kind === 'number') change[field.key] = String(value).trim() === '' ? null : Number(value)
      else change[field.key] = String(value).trim() === '' ? null : String(value).trim()
    }
    setError(null)
    try {
      const answer = await call<{ changed: string[] }>(`${channelPath(channel)}/services/${service}/settings`, { method: 'PUT', body: change })
      setNote(answer.changed.length ? `changed ${answer.changed.join(', ')}; Railway uses them from the next deployment` : 'nothing changed')
      load()
    } catch (failed) {
      setError(said(failed))
    }
  }
  return (
    <div className="railway-settings field">
      <ServicePicker railway={railway} value={service} onChange={setService} />
      {loaded === null ? <span className="hint">{error ?? 'loading…'}</span> : (
        <>
          <p className="hint">source: {loaded.source?.repo ?? loaded.source?.image ?? 'none'}{loaded.source?.branch ? ` @ ${loaded.source.branch}` : ''}</p>
          {FIELDS.map((field) => (
            <label key={field.key} className="railway-setting">
              <span className="field-name">{field.label}</span>
              {field.kind === 'boolean'
                ? <input type="checkbox" checked={draft[field.key] === true} onChange={() => setDraft((current) => ({ ...current, [field.key]: current[field.key] !== true }))} />
                : field.kind === 'list'
                  ? <textarea rows={2} value={String(draft[field.key] ?? '')} spellCheck={false} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} />
                  : <input type="text" value={String(draft[field.key] ?? '')} spellCheck={false} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} />}
            </label>
          ))}
          <button type="button" className="send" onClick={() => void save()}>save</button>
          {note && <p className="hint">{note}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}
    </div>
  )
}
