import { Dialog } from '@base-ui/react/dialog'
import { ArrowDown, ArrowUp, Lock, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChannelRoute, ChannelSettings, ModelRoute, RepositoryView } from '../../contract/channel-settings.ts'
import { ChannelPath } from '../../contract/schemas.ts'
import * as board from './board.ts'
import { navigate } from './nav.tsx'

type Row = ChannelRoute & { route: ModelRoute | null }

/** Channel's routes first, then the board's others, off. A new channel takes all, on. */
function rowsOf(catalog: ModelRoute[], settings: ChannelSettings | undefined): Row[] {
  const byKey = new Map(catalog.map((route) => [route.key, route]))
  if (!settings) return catalog.map((route) => ({ key: route.key, enabled: true, route }))
  const listed = settings.routes.map((entry) => ({ ...entry, route: byKey.get(entry.key) ?? null }))
  const seen = new Set(settings.routes.map((entry) => entry.key))
  return [...listed, ...catalog.filter((route) => !seen.has(route.key)).map((route) => ({ key: route.key, enabled: false, route }))]
}

const isGitUrl = (text: string) => /^https:\/\/[^\s/]+\/\S+$/.test(text.trim())

const pathOf = (text: string) =>
  text.trim().replace(/^#/, '').toLowerCase().split('/')
    .map((segment) => segment.replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean).join('/')

const repositoryName = (nameOrUrl: string) => nameOrUrl.replace(/\/+$/, '').split('/').at(-1)!.replace(/\.git$/, '')

const shownRepository = (url: string) => /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? url

export function ChannelDialog(props: { channel?: string; trigger: ReactNode; triggerTitle: string; triggerClass?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={props.triggerClass ?? 'tool'} aria-label={props.triggerTitle} title={props.triggerTitle}>
        {props.trigger}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog channel-dialog">
          {open && <ChannelForm {...(props.channel ? { channel: props.channel } : {})} done={() => setOpen(false)} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ChannelForm(props: { channel?: string; done: () => void }) {
  const creating = props.channel === undefined
  const settings = props.channel ? board.getState().channels[props.channel]?.settings : undefined
  const kept = settings?.repository ?? null
  const [text, setText] = useState(kept ? shownRepository(kept) : '')
  const [picked, setPicked] = useState<RepositoryView | null>(null)
  const [found, setFound] = useState<RepositoryView[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[] | null>(null)
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

  const move = (from: number, to: number) => setRows((current) => {
    if (!current || to < 0 || to >= current.length) return current
    const next = [...current]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row!)
    return next
  })
  const toggle = (at: number) => setRows((current) => current && current.map((row, i) => (i === at ? { ...row, enabled: !row.enabled } : row)))

  const save = async () => {
    if (creating && !ChannelPath.safeParse(path).success) return setError('name required')
    if (notRepository) return setError('not a repository')
    setSaving(true)
    setError(null)
    const next: ChannelSettings = { repository, routes: (rows ?? []).map(({ key, enabled }) => ({ key, enabled })) }
    const refused = await board.saveChannel(path, next, creating)
    setSaving(false)
    if (refused) return setError(refused)
    props.done()
    if (creating) navigate(`/c/${path}`)
  }

  const outcome = creating
    ? path ? `#${path} · ${repository ? shownRepository(repository) : 'local'}` : null
    : repository ? shownRepository(repository) : notRepository ? null : 'local'

  return (
    <form className="ask channel-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="dialog-head">
        <Dialog.Title className="popover-title">{creating ? 'new channel' : `#${props.channel}`}</Dialog.Title>
        <Dialog.Close className="tool" aria-label="close" title="close (esc)"><X size={15} strokeWidth={1.75} /></Dialog.Close>
      </div>

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
        {outcome && <span className="hint">{outcome}</span>}
        {searchError && <span className="hint">{searchError}</span>}
      </div>

      <fieldset className="field">
        <legend className="field-name">models</legend>
        {rows === null ? <span className="hint">loading…</span>
          : rows.length === 0 ? <span className="hint">{routesError ?? 'no models'}</span>
          : (
            <ol className="routes">
              {rows.map((row, i) => (
                <li key={row.key} className={row.enabled ? '' : 'off'}>
                  <label className="choice-row" title={row.key}>
                    <input type="checkbox" checked={row.enabled} onChange={() => toggle(i)} />
                    <span>{row.route?.label ?? row.key}</span>
                    {!row.route && <span className="hint"> (removed)</span>}
                  </label>
                  <button type="button" className="tool" aria-label={`move ${row.route?.label ?? row.key} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><ArrowUp size={13} /></button>
                  <button type="button" className="tool" aria-label={`move ${row.route?.label ?? row.key} down`} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}><ArrowDown size={13} /></button>
                </li>
              ))}
            </ol>
          )}
      </fieldset>

      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="send" disabled={saving || rows === null}>{saving ? 'saving…' : creating ? 'create' : 'save'}</button>
    </form>
  )
}
