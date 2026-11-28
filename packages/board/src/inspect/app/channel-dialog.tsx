import { Dialog } from '@base-ui/react/dialog'
import { GripVertical, Lock, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChannelRoute, ChannelSettings, ModelRoute, RepositoryView } from '../../contract/channel-settings.ts'
import { ChannelPath } from '../../contract/schemas.ts'
import * as board from './board.ts'
import { modelSource } from './model-logos.ts'
import { navigate } from './nav.tsx'
import { DeploymentPanel } from './deployment-panel.tsx'

type Row = ChannelRoute & { route: ModelRoute | null }

/** Channel's routes first, then the board's others, off. A new channel takes all, on. */
function rowsOf(catalog: ModelRoute[], settings: ChannelSettings | undefined): Row[] {
  const byKey = new Map(catalog.map((route) => [route.key, route]))
  if (!settings) return catalog.map((route) => ({ key: route.key, enabled: true, route }))
  const listed = settings.routes.map((entry) => ({ ...entry, route: byKey.get(entry.key) ?? null }))
  const seen = new Set(settings.routes.map((entry) => entry.key))
  return [...listed, ...catalog.filter((route) => !seen.has(route.key)).map((route) => ({ key: route.key, enabled: false, route }))]
}

/** A route's name in its provider's column: the label without a closing note that repeats the provider. */
const modelName = (row: Row) => (row.route?.label ?? row.key).replace(/\s*\((Max|OpenRouter|Claude)\)$/i, '')

const isGitUrl = (text: string) => /^https:\/\/[^\s/]+\/\S+$/.test(text.trim())

const pathOf = (text: string) =>
  text.trim().replace(/^#/, '').toLowerCase().split('/')
    .map((segment) => segment.replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean).join('/')

const repositoryName = (nameOrUrl: string) => nameOrUrl.replace(/\/+$/, '').split('/').at(-1)!.replace(/\.git$/, '')

const shownRepository = (url: string) => /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? url

/**
 * The channel dialog: with `trigger`, it opens from its own button; without one, `open` and
 * `onOpenChange` drive it, for a place that cannot hold a button, such as a channel's sidebar row.
 */
export function ChannelDialog(props: {
  channel?: string; trigger?: ReactNode; triggerTitle?: string; triggerClass?: string
  open?: boolean; onOpenChange?: (open: boolean) => void
}) {
  const [own, setOwn] = useState(false)
  const open = props.open ?? own
  const setOpen = props.onOpenChange ?? setOwn
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {props.trigger !== undefined && (
        <Dialog.Trigger className={props.triggerClass ?? 'tool'} aria-label={props.triggerTitle} title={props.triggerTitle}>
          {props.trigger}
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className={`dialog channel-dialog${props.channel ? ' channel-settings' : ''}`}>
          {open && (props.channel ? <ChannelTabs channel={props.channel} done={() => setOpen(false)} /> : <ChannelForm done={() => setOpen(false)} />)}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** An existing channel's settings: its repository and models, and its deployment. */
function ChannelTabs(props: { channel: string; done: () => void }) {
  const [tab, setTab] = useState<'general' | 'deployment'>('general')
  const settings = board.useBoard().channels[props.channel]?.settings
  return (
    <>
      <div className="dialog-head">
        <Dialog.Title className="popover-title">#{props.channel}</Dialog.Title>
        <Dialog.Close className="tool" aria-label="close" title="close (esc)"><X size={15} strokeWidth={1.75} /></Dialog.Close>
      </div>
      <nav className="tabs plain channel-tabs">
        {(['general', 'deployment'] as const).map((name) => (
          <button key={name} type="button" className="tab" aria-current={name === tab ? 'page' : undefined} onClick={() => setTab(name)}>{name}</button>
        ))}
      </nav>
      <div className="channel-tab-body">
        {tab === 'general' ? <ChannelForm channel={props.channel} done={props.done} head={false} />
          : settings ? <DeploymentPanel channel={props.channel} settings={settings} />
          : <p className="hint">save the channel first</p>}
      </div>
    </>
  )
}

function ChannelForm(props: { channel?: string; done: () => void; head?: boolean }) {
  const creating = props.channel === undefined
  const settings = props.channel ? board.getState().channels[props.channel]?.settings : undefined
  const kept = settings?.repository ?? null
  const [text, setText] = useState(kept ? shownRepository(kept) : '')
  const [picked, setPicked] = useState<RepositoryView | null>(null)
  const [found, setFound] = useState<RepositoryView[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [dragged, setDragged] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [routesError, setRoutesError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    board.loadModelRoutes().then((catalog) => setRows(rowsOf(catalog, settings)), (failed: unknown) => {
      setRoutesError(failed instanceof Error ? failed.message : String(failed))
      setRows(rowsOf([], settings))
    })
  }, [])

  const asked = useRef(0)
  useEffect(() => {
    const n = ++asked.current
    const query = text.trim()
    if (picked || isGitUrl(query) || (!creating && query === shownRepository(kept ?? ''))) return setFound([])
    const timer = setTimeout(() => {
      board.findRepositories(query).then(
        (repositories) => { if (asked.current === n) { setFound(repositories); setSearchError(null) } },
        (failed: unknown) => { if (asked.current === n) { setFound([]); setSearchError(failed instanceof Error ? failed.message : String(failed)) } },
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [text, picked])

  // A repository only from a pick or a URL; other text names a local channel.
  const typed = text.trim()
  const unchanged = !creating && kept !== null && typed === shownRepository(kept)
  const repository = picked ? picked.url : isGitUrl(typed) ? typed : unchanged ? kept : null
  const path = creating ? pathOf(repository ? repositoryName(picked?.name ?? typed) : typed) : props.channel!
  const notRepository = !creating && typed !== '' && repository === null

  // The list's order is the fallback order of the models that are on; a drop puts the dragged row where it lands.
  const move = (from: number, to: number) => setRows((current) => {
    if (!current || from === to || to < 0 || to >= current.length) return current
    const next = [...current]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row!)
    return next
  })
  const toggle = (key: string) => setRows((current) => current && current.map((row) => (row.key === key ? { ...row, enabled: !row.enabled } : row)))

  const save = async () => {
    if (creating && !ChannelPath.safeParse(path).success) return setError('name required')
    if (notRepository) return setError('not a repository')
    setSaving(true)
    setError(null)
    const current = props.channel ? board.getState().channels[props.channel]?.settings : undefined
    const next: ChannelSettings = { repository, routes: (rows ?? []).map(({ key, enabled }) => ({ key, enabled })), ...(current?.railway ? { railway: current.railway } : {}), ...(current?.local ? { local: current.local } : {}) }
    const refused = await board.saveChannel(path, next, creating)
    setSaving(false)
    if (refused) return setError(refused)
    props.done()
    if (creating) navigate(`/c/${path}`)
  }


  return (
    <form className="ask channel-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      {props.head !== false && (
        <div className="dialog-head">
          <Dialog.Title className="popover-title">{creating ? 'new channel' : `#${props.channel}`}</Dialog.Title>
          <Dialog.Close className="tool" aria-label="close" title="close (esc)"><X size={15} strokeWidth={1.75} /></Dialog.Close>
        </div>
      )}

      <div className="field">
        <input
          type="text"
          value={text}
          autoFocus
          spellCheck={false}
          placeholder={creating ? 'name, repository or git URL' : 'repository or git URL'}
          onChange={(event) => { setText(event.target.value); setPicked(null) }}
        />
        {found.length > 0 && (
          <ul className="repositories" role="listbox" aria-label="repositories">
            {found.map((repository) => (
              <li key={repository.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={picked?.name === repository.name}
                  className={`repository${picked?.name === repository.name ? ' on' : ''}`}
                  title={repository.description ?? repository.name}
                  onClick={() => { setPicked(repository); setText(repository.name) }}
                >
                  {repository.private && <Lock size={11} aria-label="private" />}
                  <span>{repository.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Under the input, only what went wrong: the input already says what the channel is. */}
        {searchError && <span className="hint">{searchError}</span>}
      </div>

      <fieldset className="field">
        <legend className="field-name">models</legend>
        {rows === null ? <span className="hint">loading…</span>
          : rows.length === 0 ? <span className="hint">{routesError ?? 'no models'}</span>
          : (
            <ol className="model-list" aria-label="models, in fallback order">
              {rows.map((row, i) => {
                const source = modelSource(row.route?.provider ?? '')
                const name = modelName(row)
                const provider = source?.name ?? row.route?.provider ?? 'removed'
                // "Claude Claude Opus" reads twice: the provider's name leads already.
                const shown = name.toLowerCase().startsWith(`${provider.toLowerCase()} `) ? name.slice(provider.length + 1) : name
                return (
                  <li key={row.key} draggable title={row.key}
                    className={`model-row${row.enabled ? ' on' : ''}${dragged === i ? ' dragged' : ''}${over === i && dragged !== null && dragged !== i ? (dragged < i ? ' drop-after' : ' drop-before') : ''}`}
                    onDragStart={(event) => { setDragged(i); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.key) }}
                    onDragOver={(event) => { if (dragged !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(i) } }}
                    onDrop={(event) => { event.preventDefault(); if (dragged !== null) move(dragged, i); setDragged(null); setOver(null) }}
                    onDragEnd={() => { setDragged(null); setOver(null) }}>
                    <GripVertical size={13} className="model-grip" aria-hidden="true" />
                    {source ? <img src={source.src} alt={source.name} title={source.name} /> : <span className="model-logo-gap" />}
                    <span className="model-label">
                      <span className="model-provider">{provider}:</span>
                      <span className="model-name">{shown}</span>
                    </span>
                    <button type="button" role="switch" aria-checked={row.enabled} aria-label={`${name} ${row.enabled ? 'on' : 'off'}`}
                      className="switch" onClick={() => toggle(row.key)}><i /></button>
                  </li>
                )
              })}
            </ol>
          )}
      </fieldset>

      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="send" disabled={saving || rows === null}>{saving ? 'saving…' : creating ? 'create' : 'save'}</button>
    </form>
  )
}
