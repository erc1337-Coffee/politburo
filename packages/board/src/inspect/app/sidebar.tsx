import { Activity, Eye, EyeOff, Inbox, LayoutGrid, PanelLeftClose, Plus, Settings } from 'lucide-react'
import { compileAccess } from '../../server/access.ts'
import { ChannelDialog } from './channel-dialog.tsx'
import { useEffect, useMemo, useState } from 'react'
import type { ChannelView } from '../../api/routes.ts'
import { attentionTasks, hasUnshownRefusal } from './attention-store.ts'
import * as board from './board.ts'
import { toast } from './chrome.ts'
import { HomeEmblem } from './home-emblem.tsx'
import { Avatar } from './message.tsx'
import { Link, useLocation, type Route } from './nav.tsx'
import type { State } from './store.ts'
import { ContextMenuArea, MenuItem } from './ui.tsx'
import { nameFor, pictureFor } from './identity.ts'
import { boardWords, shownName } from './words.ts'
import { workScopeUrl } from './work-scope.ts'

// --- sidebar -------------------------------------------------------------------------

function useSeen(state: State, current: Route): Record<string, number> {
  const storage = `board.seen:${state.discovery?.url ?? location.host}`
  const [seen, setSeen] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storage) ?? 'null') ?? {}
    } catch {
      return {}
    }
  })
  const save = (next: Record<string, number>) => {
    setSeen(next)
    try {
      localStorage.setItem(storage, JSON.stringify(next))
    } catch {}
  }
  // The first visit marks everything read; after that, dots mean news.
  useEffect(() => {
    const channels = Object.values(state.channels)
    if (Object.keys(seen).length === 0 && channels.length > 0)
      save(Object.fromEntries(channels.map((channel) => [channel.path, channel.lastIndex ?? 0])))
  }, [state.channels])
  useEffect(() => {
    if (current.view !== 'channel') return
    const channel = state.channels[current.channel]
    if (channel?.lastIndex !== undefined && (seen[channel.path] ?? 0) < channel.lastIndex) save({ ...seen, [channel.path]: channel.lastIndex })
  }, [current, state.channels])
  return seen
}

/** A value kept in this browser, per board. */
function useStored<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? initial
    } catch {
      return initial
    }
  })
  const save = (next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {}
  }
  return [value, save]
}

export function Sidebar({ state, current, onHome, onCollapse }: { state: State; current: Route; onHome: () => void; onCollapse: () => void }) {
  const seen = useSeen(state, current)
  const at = state.discovery?.url ?? location.host
  const [hidden, setHidden] = useStored<string[]>(`board.hidden:${at}`, [])
  const [showHidden, setShowHidden] = useStored(`board.showHidden:${at}`, false)
  const isHidden = (path: string) => hidden.includes(path)
  const toggleHidden = (path: string) => setHidden(isHidden(path) ? hidden.filter((p) => p !== path) : [...hidden, path])
  const groups = useMemo(() => {
    const out = new Map<string, ChannelView[]>()
    for (const channel of Object.values(state.channels).sort((a, b) => a.path.localeCompare(b.path))) {
      if (!showHidden && hidden.includes(channel.path) && !(current.view === 'channel' && current.channel === channel.path)) continue
      const at = channel.path.lastIndexOf('/')
      const group = at === -1 ? 'channels' : channel.path.slice(0, at)
      out.set(group, [...(out.get(group) ?? []), channel])
    }
    return [...out]
  }, [state.channels, hidden, showHidden, current])
  const questions = useMemo(() => attentionTasks(state).length, [state.messages])
  const where = boardWords(state.discovery)
  const { params } = useLocation()
  // Parties are Work scopes; list them under Work only when there is a choice.
  const parties = Object.entries(board.swarmRecords()?.parties ?? {})
  const scoped = current.view === 'work' ? params.get('party') : null
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast(`copied ${text}`))
  return (
    <>
      <div className="brand">
        <HomeEmblem onNavigate={onHome} />
        <Link to="/" className="wordmark" title={where.at ? `${where.name} · ${where.at}` : where.name} onNavigate={onHome}>
          POLITBURO
        </Link>
        <button type="button" className="tool" title="Hide sidebar" aria-label="Hide sidebar" onClick={onCollapse}>
          <PanelLeftClose size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="view-body">
      <div className="sidebar-scroll">
        <Link to="/" className="item" current={current.view === 'inbox'} title="questions and tasks that need a person">
          <Inbox size={14} aria-hidden="true" />
          <span className="name">Inbox</span>
          {questions > 0 && <span className="count">{questions}</span>}
          {hasUnshownRefusal(state) && <span className="faint">refused</span>}
        </Link>
        <Link to={workScopeUrl('/work', params)} className="item" current={(current.view === 'work' && scoped === null) || current.view === 'cell'}>
          <LayoutGrid size={14} aria-hidden="true" />
          <span className="name">Work</span>
        </Link>
        {parties.length > 1 && parties.map(([id, party]) => (
          <Link key={id} to={workScopeUrl('/work', params, id)} className="item sub-item" current={scoped === id} title={`Work in ${party.name}`}>
            <span className="name">{party.name}</span>
          </Link>
        ))}
        <Link to="/operations" className="item" current={current.view === 'operations'}>
          <Activity size={14} aria-hidden="true" />
          <span className="name">Operations</span>
        </Link>
        <h2>
          <span className="spacer">channels</span>
          <button type="button" className="tool" aria-pressed={showHidden} title={showHidden ? 'hide hidden channels' : 'show hidden channels'} aria-label={showHidden ? 'hide hidden channels' : 'show hidden channels'} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? <Eye size={13} strokeWidth={2} /> : <EyeOff size={13} strokeWidth={2} />}
          </button>
          {compileAccess(state.me!.can).anywhere('post') && <ChannelDialog trigger={<Plus size={13} strokeWidth={2} />} triggerTitle="new channel" />}
        </h2>
        {groups.map(([group, channels]) => (
          <section key={group}>
            {group !== 'channels' && <h2>{group}</h2>}
            {channels.map((channel) => {
              const active = current.view === 'channel' && current.channel === channel.path
              // Only where the board keeps a channel's last position: Vercel's API doesn't.
              const unread = !active && (channel.lastIndex ?? 0) > (seen[channel.path] ?? Number.POSITIVE_INFINITY)
              return (
                <ContextMenuArea
                  key={channel.path}
                  menu={
                    <>
                      <MenuItem onClick={() => copy(channel.path)}>copy name</MenuItem>
                      <MenuItem onClick={() => copy(`vb read ${channel.path}`)}>copy vb read command</MenuItem>
                      <MenuItem onClick={() => toggleHidden(channel.path)}>{isHidden(channel.path) ? 'unhide' : 'hide'}</MenuItem>
                    </>
                  }
                >
                  <Link to={`/c/${channel.path}`} className={`item${unread ? ' unread' : ''}${isHidden(channel.path) ? ' hidden-channel' : ''}`} current={active} title={channel.path}>
                    <span className="name">#{channel.path.slice(channel.path.lastIndexOf('/') + 1)}</span>
                    <span
                      className="eye"
                      role="button"
                      aria-label={isHidden(channel.path) ? 'unhide' : 'hide'}
                      title={isHidden(channel.path) ? 'unhide' : 'hide'}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggleHidden(channel.path) }}
                    >
                      {isHidden(channel.path) ? <EyeOff size={13} strokeWidth={2} /> : <Eye size={13} strokeWidth={2} />}
                    </span>
                    {unread ? <i className="dot" /> : channel.threads !== undefined ? <span className="count">{channel.threads}</span> : null}
                  </Link>
                </ContextMenuArea>
              )
            })}
          </section>
        ))}
      </div>
      <div className="sidebar-foot">
        <Link to="/settings/access" className="item settings" current={current.view === 'settings'}>
          <Settings size={14} strokeWidth={1.75} />
          <span>Settings</span>
        </Link>
        <div className="whoami" title={state.me!.actor}>
          <Avatar name={nameFor(state.identities, state.me!.actor, shownName(state.me!))} src={pictureFor(state.identities, state.me!.actor)} size={24} />
          <span className="as">acting as {nameFor(state.identities, state.me!.actor, shownName(state.me!))}</span>
        </div>
      </div>
      </div>
    </>
  )
}
