import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { attentionFor } from './attention-store.ts'
import * as board from './board.ts'
import { claimFirst } from './claim-order.ts'
import { useHoldPosition } from './hold-position.ts'
import { here, isTypingTarget, Link, navigate, useLocation } from './nav.tsx'
import { groupingOf, GROUPINGS, type Grouping } from './routes.ts'
import { byWritten, nameOf, stateNow, type State, type TaskRoot } from './store.ts'
import { Header } from './ui.tsx'
import { filterParams, filterWork, readFilter, SAVED_VIEWS } from './work-filter.ts'
import { keyAction } from './work-keys.ts'
import { workScopeUrl, workTitle, type WorkRoute } from './work-scope.ts'
import { homeOf, partyOf, projectWork, workGroupTitle, type WorkGroup, type WorkRow } from './work.ts'

const RULES: Record<WorkGroup, string> = {
  needs: 'A person must answer a request or fix a contract.',
  repair: 'A claim, source, or piece of evidence needs repair.',
  review: 'An open PR has passing checks and no hold.',
  running: 'The board shows an unexpired claim.',
  pull: 'Ready to claim, with no park or blocking overlap.',
  waiting: 'Held, parked, or not ready to claim.',
  done: 'The task is completed, failed, or canceled.',
}

/** Board-state lanes, a lapsed claim counted as ready. */
const LANES = [
  { key: 'ready', title: 'Runnable', states: ['ready'] },
  { key: 'claimed', title: 'In progress', states: ['claimed'] },
  { key: 'waiting', title: 'Waiting on prerequisites', states: ['waiting'] },
  { key: 'held', title: 'Blocked or failed', states: ['blocked', 'failed'] },
  { key: 'completed', title: 'Delivered', states: ['completed'] },
  { key: 'canceled', title: 'Canceled', states: ['canceled'] },
] as const

const GROUPING_TITLES: Record<Grouping, string> = { swarm: 'swarm group', state: 'board state', none: 'none' }

type Section = { key: string; title: string; rule?: string; rows: WorkRow[] }

const rowOf = (node: Node | null) =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-work-row]')
const rowKey = (node: Node | null) => rowOf(node)?.dataset.workRow
const queueRow = (id: string) => `[data-work-row="queue:${CSS.escape(id)}"]`

type WorkView = keyof typeof SAVED_VIEWS
const viewOf = (key: string | null): WorkView => key && Object.hasOwn(SAVED_VIEWS, key) ? key as WorkView : 'open'

/** Keep the relative order of surviving rows, adding newcomers after them. */
function keepOrder(rows: WorkRow[], previous: ReadonlyMap<string, number>): WorkRow[] {
  const known = rows.filter(({ root }) => previous.has(root.id)).sort((a, b) => previous.get(a.root.id)! - previous.get(b.root.id)!)
  return [...known, ...rows.filter(({ root }) => !previous.has(root.id))]
}

function webUrl(raw?: string): string | undefined {
  if (!raw) return
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch { /* Not an absolute link. */ }
}

export function Work({ state, now, lead, route }: { state: State; now: number; lead: ReactNode; route: WorkRoute }) {
  useEffect(board.openNeeds, [])
  const { params, thread } = useLocation()
  const records = board.swarmRecords()
  const cellView = route.view === 'cell'
  const grouping = cellView ? 'swarm' : groupingOf(params)
  const partyId = params.get('party')
  const party = partyOf(records, partyId)
  const unknownParty = partyId !== null && records !== null && !party
  const peekId = params.get('peek')
  const urlFilter = readFilter(params)
  const [text, setText] = useState(urlFilter.text)
  // Only URL navigation can resync this draft, not a new board snapshot.
  useEffect(() => setText(urlFilter.text), [urlFilter.text])
  const filter = { ...urlFilter, text }
  // The party is the scope, chosen above the filters.
  const chips = [...filterParams({ ...filter, text: '', party: undefined })]
  const view = viewOf(params.get('view'))
  const viewGroups: readonly WorkGroup[] = grouping === 'swarm' ? SAVED_VIEWS[view].groups : []
  const inView = (group: WorkGroup) => viewGroups.includes(group) && (!filter.group || filter.group === group)
  const filtering = (grouping === 'swarm' && view !== 'open') || partyId !== null || text.trim() !== '' || chips.length > 0
  const showEmpty = params.get('show') === 'empty'
  const comfortable = params.get('density') === 'comfortable'
  const field = useRef<HTMLInputElement>(null)
  const pending = useRef<string | null>(null)
  const [help, setHelp] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [selection, setSelection] = useState<string | null>(null)
  const focusAfterExpand = useRef<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement>(null)
  const focusPeek = useRef<string | null>(null)
  const pane = useRef<HTMLElement>(null)
  const openPeek = (id: string, from: HTMLElement) => {
    opener.current = from
    focusPeek.current = id
    navigate(here({ params: { peek: id } }))
  }
  useLayoutEffect(() => {
    if (focusPeek.current === peekId && peekId !== null) heading.current?.focus({ preventScroll: true })
    focusPeek.current = null
  }, [peekId])
  const viewer = useMemo(() => state.openTaskMe && board.viewerOf(state.openTaskMe), [state.openTaskMe])
  const projected = useMemo(() => projectWork(state, records, viewer, now), [state, records, viewer, now])
  const claimant = cellView ? route.cell : undefined
  const latest = useMemo(() => {
    if (!unknownParty && claimant === undefined) return projected
    const groups = projected.groups.map((group) => ({
      ...group,
      rows: unknownParty ? [] : filterWork(group.rows, { text: '', claimant }),
    }))
    return { groups, rows: groups.flatMap(({ rows }) => rows) }
  }, [projected, unknownParty, claimant])
  const errors = new Set(viewer && latest === projected ? Object.values(state.openTaskAttentionRefusals) : [])
  const readStatus = state.tasksRefused ?? (state.tasksCounted ? null : 'loading…')
  const statusClass = state.tasksRefused === null ? undefined : 'error'
  for (const { root } of latest.rows) {
    const { readError } = attentionFor(state, root, viewer)
    if (readError !== null) errors.add(readError)
  }

  // Freeze the surviving rows' order within each group while reading; membership,
  // grouping and text keep updating. Restore focus when a link moves groups.
  const [frozen, setFrozen] = useState(false)
  const order = useRef(new Map<string, number>())
  const list = useRef<HTMLDivElement>(null)
  const layout = useRef<HTMLDivElement>(null)
  const focused = useRef<HTMLElement>(null)
  const hovered = useRef(false)
  const hoveredKey = useRef<string | undefined>(undefined)
  const selectionInList = () => {
    const selection = document.getSelection()
    return selection && !selection.isCollapsed
      ? [selection.anchorNode, selection.focusNode].filter((node) => list.current?.contains(node))
      : []
  }
  const selected = selectionInList()
  const peekHasFocus = Boolean(pane.current?.contains(document.activeElement))
  // Hold the row being read even with peek open; only fall back to the keyboard
  // selection when reading the list alone. Skip the row when peek itself has focus.
  const rowAnchor = peekHasFocus ? undefined : (rowKey(focused.current) ?? hoveredKey.current ?? selected.map(rowKey).find(Boolean) ??
    (frozen && peekId === null ? selection : null))
  useHoldPosition(list, rowAnchor, 'data-work-row')
  useHoldPosition(layout, peekHasFocus ? 'peek' : undefined, 'data-work-row')
  const release = (target: EventTarget | null) => {
    if (hovered.current || target === field.current ||
        (target instanceof Node && (list.current?.contains(target) || pane.current?.contains(target)))) return
    if (!selectionInList().length) setFrozen(false)
  }
  useEffect(() => {
    const changed = () => {
      if (selectionInList().length) setFrozen(true)
      else release(document.activeElement)
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [])
  const closePeek = () => {
    if (pane.current?.contains(document.activeElement)) {
      const from = opener.current
      ;(from?.isConnected ? from : list.current)?.focus({ preventScroll: true })
    }
    opener.current = null
    navigate(here({ params: { peek: null } }))
  }
  const rowsById = new Map(latest.rows.map((row) => [row.root.id, row]))
  const hold = (rows: WorkRow[]) => frozen ? keepOrder(rows, order.current) : rows
  // The swarm grouping leaves finished tasks out; the other groupings read and show them.
  const scope = grouping === 'swarm'
    ? latest.groups.filter(({ group }) => group !== 'done').flatMap(({ rows }) => hold(rows))
    : hold(grouping === 'none' ? orderedRows(latest.rows, viewer, state, now) : latest.rows)
  const shown = filterWork(grouping === 'swarm' ? scope.filter(({ group }) => inView(group)) : scope, filter)
  // The queue's empty groups are optional.
  const sections: Section[] = (grouping === 'swarm'
    ? viewGroups.filter(inView).map((group) => ({ key: group, title: workGroupTitle(group), rule: RULES[group], rows: shown.filter((row) => row.group === group) }))
    : grouping === 'state'
      ? LANES.map(({ key, title, states }) => ({ key, title, rows: shown.filter(({ root }) => (states as readonly string[]).includes(stateNow(root.task, now))) }))
      : [{ key: 'all', title: 'All tasks', rule: 'Claimable first, then by priority and age.', rows: shown }])
    .filter(({ rows }) => showEmpty || rows.length > 0)
  const sectionOf = new Map(sections.flatMap(({ key, rows }) => rows.map(({ root }) => [root.id, key] as const)))
  const ids = sections.filter(({ key }) => !collapsed.has(key)).flatMap(({ rows }) => rows.map(({ root }) => root.id))
  const selectedId = selection?.slice(selection.indexOf(':') + 1)
  const selectedRow = shown.find(({ root }) => root.id === selectedId)
  const home = homeOf(shown, null, now)
  // Health describes the whole scope, regardless of view, filters, or collapse.
  const { health } = useMemo(() => {
    const scopedRecords = unknownParty ? null : partyId !== null && party && records
      ? { ...records, parties: { [partyId]: party } } : records
    const scoped = partyId === null ? latest.rows : filterWork(latest.rows, { text: '', party: partyId })
    return homeOf(scoped, scopedRecords, now)
  }, [latest, records, now, party, partyId, unknownParty])
  const capacity = health.perParty.find((entry) => entry.party.id === partyId)
  const empty = unknownParty ? 'no party with that id'
    : cellView && latest.rows.length === 0 ? 'nothing claimed by this cell' : null
  const peeked = peekId === null ? undefined : rowsById.get(peekId)
  const focusQueueRow = (id: string) => list.current?.querySelector<HTMLElement>(queueRow(id))?.focus()
  const queueHeading = (key: string) => list.current?.querySelector<HTMLElement>(`#work-queue-${key}`)
  const onKey = (event: KeyboardEvent, target: Element | null) => {
    const inList = list.current?.contains(target)
    const onBody = target === document.body && thread === null
    // Peek keeps its dismissal keys, but doesn't take over the list's keyboard map.
    const dismissPeek = pane.current?.contains(target) && (event.key === 'Escape' || event.key === ' ')
    const typing = isTypingTarget(target)
    const prefix = pending.current
    if ((!inList && !onBody && !dismissPeek) || typing || event.defaultPrevented || event.isComposing || list.current?.closest('[inert]') ||
        target?.closest('[role="menu"], [role="dialog"], [role="listbox"], [inert]')) {
      pending.current = null
      return
    }
    const action = keyAction(event, prefix, typing)
    pending.current = action?.type === 'prefix' ? action.key : null
    if (!action) {
      // Like useTypeToFocus, let the browser deliver the printable key to the newly focused field.
      if (thread === null && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) field.current?.focus()
      return
    }
    // Keep native control activation, and let Escape close a foreground thread.
    if ((action.type === 'thread' && target?.closest('a, button, [role="button"]')) ||
        (action.type === 'peek' && target?.closest('button, [role="button"]')) ||
        (action.type === 'escape' && thread !== null && peekId === null && selection === null)) return
    event.preventDefault()
    switch (action.type) {
      case 'move': {
        const at = selectedId === undefined ? -1 : ids.indexOf(selectedId)
        const next = ids[(at < 0 && action.by < 0 ? ids.length : at) + action.by]
        if (next !== undefined) focusQueueRow(next)
        break
      }
      case 'jump': {
        const section = sections.find(({ key }) => key === action.to)
        const first = section?.rows[0]
        const heading = queueHeading(action.to)
        if (first && !collapsed.has(section.key)) focusQueueRow(first.root.id)
        else if (heading) {
          setSelection(first ? `queue:${first.root.id}` : null)
          heading.focus()
        }
        break
      }
      case 'thread': if (selectedRow) navigate(here({ thread: selectedRow.root.id })); break
      case 'peek':
        if (!event.repeat && selectedRow) {
          if (peekId === selectedRow.root.id) closePeek()
          else openPeek(selectedRow.root.id, document.activeElement as HTMLElement)
        }
        break
      case 'escape':
        if (peekId !== null) closePeek()
        else { setSelection(null); if (rowOf(document.activeElement)) list.current?.focus({ preventScroll: true }) }
        break
      case 'filter': field.current?.focus(); break
      case 'collapse': {
        const key = selectedRow && sectionOf.get(selectedRow.root.id)
        if (selectedRow && key !== undefined) {
          if (action.closed && !collapsed.has(key)) queueHeading(key)?.focus()
          if (!action.closed && collapsed.has(key)) focusAfterExpand.current = selectedRow.root.id
          setCollapsed((prev) => {
            const next = new Set(prev)
            if (action.closed) next.add(key)
            else next.delete(key)
            return next
          })
        }
        break
      }
      case 'link': {
        const url = webUrl(selectedRow?.urls?.[action.link])
        if (url && !event.repeat) window.open(url, '_blank', 'noopener,noreferrer')
        break
      }
      case 'help': if (!event.repeat) setHelp((open) => !open); break
    }
  }
  const onDocumentKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : document.activeElement
    if (target === document.body) onKey(event, target)
    else if (!list.current?.contains(target)) pending.current = null
  })
  useEffect(() => {
    const listen = (event: KeyboardEvent) => onDocumentKey(event)
    document.addEventListener('keydown', listen)
    return () => document.removeEventListener('keydown', listen)
  }, [])
  useLayoutEffect(() => {
    const before = [...order.current.keys()]
    order.current = new Map(scope.map(({ root }, index) => [root.id, index]))
    if (focusAfterExpand.current !== null) {
      focusQueueRow(focusAfterExpand.current)
      focusAfterExpand.current = null
    }
    const el = list.current
    const target = focused.current
    const id = rowOf(target)?.dataset.taskId
    if (!el || !target || id === undefined || document.activeElement !== document.body) return
    const index = before.indexOf(id)
    const next = [id, ...before.slice(index + 1), ...before.slice(0, Math.max(0, index)).reverse(), ...ids]
      .find((candidate) => ids.includes(candidate))
    const selector = target.matches('button') ? ' button' : target.matches('a.text-link') ? ' a.text-link' : target.matches('a') ? ' a' : ''
    const replacement = next === undefined ? null : el.querySelector<HTMLElement>(`${queueRow(next)}${selector}`)
      ?? el.querySelector<HTMLElement>(queueRow(next))
    ;(replacement ?? el).focus({ preventScroll: true })
  })
  const showRow = (row: WorkRow) => (
    <Row key={row.root.id} {...{ row, state }} cellDetail={cellView}
      claimantLink={row.claimant ? workScopeUrl(`/cell/${encodeURIComponent(row.claimant)}`, params, partyId) : undefined}
      current={selection === `queue:${row.root.id}`}
      expanded={peekId === row.root.id} openPeek={(id, from) => {
        setSelection(`queue:${id}`)
        if (peekId === id) closePeek()
        else openPeek(id, from)
      }} />
  )
  const { counts } = home
  const parties = Object.entries(records?.parties ?? {})

  return (
    <>
      <Header title={workTitle(route)} meta={cellView ? nameOf(state, route.cell) : undefined} live={state.live} lead={lead}>
        {!cellView && party && <span className="meta"><PartyName party={party} />
          {readStatus === null && capacity && <> · {capacity.active} / {capacity.party.openClaimLimit ?? 'limit unknown'} active</>}
        </span>}
      </Header>
      <div className={`page home-view needs-view work-view${peekId === null ? '' : ' with-peek'}${comfortable ? ' comfortable' : ''}`}>
        {cellView && <p><Link className="text-link" to={workScopeUrl('/work', params, partyId)}>back to Work</Link></p>}
        {!cellView && parties.length > 0 && <nav className="work-controls" aria-label="Party scope">
          <span>party:</span>
          <Link className="text-link" current={partyId === null} to={here({ params: { party: null, peek: null } })}>all</Link>
          {parties.map(([id, entry]) => (
            <Link key={id} className="text-link" current={partyId === id} to={here({ params: { party: id, peek: null } })}>{entry.name}</Link>
          ))}
        </nav>}
        {!cellView && <nav className="work-controls" aria-label="Group work by">
          <span>group by:</span>
          {GROUPINGS.map((key) => (
            <Link key={key} className="text-link" current={grouping === key} to={here({ params: { by: key === 'swarm' ? null : key, group: null, peek: null } })}>{GROUPING_TITLES[key]}</Link>
          ))}
        </nav>}
        {grouping === 'swarm' && <nav className="work-controls" aria-label="Saved work views">
          {Object.entries(SAVED_VIEWS).map(([key, { title }]) => (
            <Link key={key} className="text-link" current={key === view} to={here({ params: { view: key === 'open' ? null : key } })}>{title}</Link>
          ))}
        </nav>}
        <div className="work-controls">
          <label className="suggest">
            <input ref={field} type="search" aria-label="Filter work" placeholder="Filter work" value={text} spellCheck={false}
              onFocus={() => { pending.current = null; setFrozen(true) }} onBlur={(event) => release(event.relatedTarget)}
              onChange={(event) => {
                const next = event.currentTarget.value
                setText(next)
                navigate(here({ params: { q: next } }), true)
              }} />
          </label>
          <DisplayCheck checked={showEmpty} label="show empty groups" onChange={() => navigate(here({ params: { show: showEmpty ? null : 'empty' } }))} />
          <DisplayCheck checked={comfortable} label="comfortable" onChange={() => navigate(here({ params: { density: comfortable ? null : 'comfortable' } }))} />
          <button type="button" className="segment small" aria-expanded={help} aria-controls={help ? 'work-keys' : undefined} onClick={() => setHelp(!help)}>keys</button>
        </div>
        {chips.length > 0 && <div className="work-controls" aria-label="Active work filters">
          {chips.map(([key, value]) => (
            <Link key={key} className="text-link" title={`remove ${key} filter`} to={here({ params: { [key]: null } })}>{key}: {value} (remove)</Link>
          ))}
        </div>}
        {help && <KeyHelp row={selectedRow} />}
        {readStatus === null && !cellView && !unknownParty && (
          <>
            {filtering && <p role="status">{shown.length} of {scope.length} rows</p>}
            <p className="work-counts">
              {grouping === 'swarm' && inView('running') && <><a href="#work-queue-running">{counts.running} running</a> · </>}
              <a href="#work-health">{health.total.expiring} expiring in 30 min</a>
            </p>
          </>
        )}
        <p role="status" className="faint">{records ? 'swarm records: seeded fixtures (not live data)' : 'swarm records: none (add ?swarm=fixtures to preview seeded fixtures)'}</p>
        {/* Handle list shortcuts before the document-level type-to-focus listener. */}
        <div ref={layout} className="work-layout" onKeyDown={(event) => onKey(event.nativeEvent, event.target instanceof Element ? event.target : null)}>
          <div ref={list} tabIndex={-1} aria-label="Work board tasks" className="work-list"
            onFocus={(event) => {
              focused.current = event.target
              const key = rowKey(event.target)
              if (key) setSelection(key)
              if (event.target !== event.currentTarget) setFrozen(true)
            }}
            onBlur={(event) => {
              focused.current = null
              release(event.relatedTarget)
            }}
            onMouseEnter={() => { hovered.current = true; setFrozen(true) }}
            onMouseOver={(event) => { hoveredKey.current = rowKey(event.target as Node) }}
            onMouseLeave={() => {
              hovered.current = false
              hoveredKey.current = undefined
              release(document.activeElement)
            }}>
            <div className="home-queue work-queue">
              <h2 id="work-queue-queue" tabIndex={-1}>Queue</h2>
              {unknownParty ? <p role="status">{empty}</p>
                : readStatus !== null ? <p role="status" className={statusClass}>{readStatus}</p>
                : empty ? <p role="status">{empty}</p> : (
                <>
                  {sections.map(({ key, title, rule, rows }) => (
                    <section key={key}>
                      <h3 id={`work-queue-${key}`} tabIndex={-1}>{title} ({rows.length}) {(rule || collapsed.has(key)) && <small>{collapsed.has(key) ? 'collapsed' : rule}</small>}</h3>
                      {!collapsed.has(key) && rows.length > 0 && <ul role="list">{rows.map(showRow)}</ul>}
                    </section>
                  ))}
                  {shown.length === 0 && filtering && <p role="status">no rows match</p>}
                  {shown.length === 0 && !filtering && errors.size === 0 && <p role="status">nothing on the board</p>}
                  {[...errors].map((error) => <p key={error} role="status" className="error">{error}</p>)}
                </>
              )}
            </div>
            {readStatus === null && !cellView && !unknownParty && (
              <section id="work-health" className="home-queue" aria-labelledby="work-health-title">
                <h2 id="work-health-title">Health and spend</h2>
                {health.perParty.length ? <Health health={health} /> : <p role="status">no health data</p>}
              </section>
            )}
          </div>
          {peekId !== null && (
            <aside ref={pane} id="work-peek" className="work-peek" data-work-row="peek" aria-label="Work peek" onBlur={(event) => release(event.relatedTarget)}>
              {readStatus !== null ? <p role="status" className={statusClass}>{readStatus}</p>
                : peeked ? <Peek row={peeked} state={state} heading={heading} close={closePeek} />
                : <p role="status">no longer on the board</p>}
            </aside>
          )}
        </div>
      </div>
    </>
  )
}

/** Without grouping: what claim-next takes first, in its order, then the rest by priority and age. */
function orderedRows(rows: readonly WorkRow[], viewer: ReturnType<typeof board.viewerOf> | null, state: State, now: number): WorkRow[] {
  if (!viewer) return [...rows].sort((a, b) => byWritten(a.root, b.root))
  const byId = new Map(rows.map((row) => [row.root.id, row]))
  const eligible = state.status?.paused ? { ...viewer, may: () => false } : viewer
  return claimFirst(rows.map(({ root }) => root as TaskRoot), eligible, now).map(({ id }) => byId.get(id)!)
}

function DisplayCheck({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button type="button" role="checkbox" aria-checked={checked} className={`segment small${checked ? ' on' : ''}`} onClick={onChange}>{label}</button>
}

function KeyHelp({ row }: { row: WorkRow | undefined }) {
  const links = ([['o', 'source'], ['p', 'pr'], ['e', 'evidence']] as const)
    .map(([key, link]) => `${key} ${link === 'pr' ? 'PR' : link}${webUrl(row?.urls?.[link]) ? '' : ' (no link)'}`)
  return (
    <div id="work-keys" role="region" aria-label="Work keyboard shortcuts">
      <p>j / ArrowDown: next row; k / ArrowUp: previous row. Enter: open thread. Space: toggle peek. Escape: close peek or clear selection.</p>
      <p>/: focus filter. g then q: Queue; grouped by swarm group, g then n: Needs you; r: Ready to review; u: Running; w: Ready to pull.</p>
      <p>[: collapse group; ]: expand group. Open in a new tab: {links.join('; ')}. ?: toggle keys.</p>
      <p>Write keys (c, x, r, d) and Cmd/Ctrl+K are not bound. Writes go through the dispatcher (WP-402/406).</p>
    </div>
  )
}

function Health({ health: { perParty, total } }: { health: ReturnType<typeof homeOf>['health'] }) {
  const cells = (metrics: typeof total) => (
    <>
      <td>{metrics.active} / {metrics.openClaimLimit ?? 'limit unknown'}</td>
      <td>{metrics.expiring}</td>
      <td>{metrics.stale}</td>
      <td>{metrics.reviewWip}</td>
      <td>{metrics.knownTokens} known · {metrics.unknownTokens} unknown</td>
      <td>{metrics.unknownCoverage}</td>
      <td>{metrics.overlaps}</td>
    </>
  )
  return (
    <table className="work-health">
      <thead><tr>
        {['Party', 'Active / limit', 'Expiring', 'Stale', 'Review WIP', 'Tokens', 'Unknown', 'Overlaps'].map((label) => (
          <th scope="col" key={label}>{label}</th>
        ))}
      </tr></thead>
      <tbody>
        {perParty.map(({ party, ...metrics }) => (
          <tr key={party.id === null ? 'external' : `party:${party.id}`}>
            <th scope="row"><PartyName party={party} /></th>
            {cells({ ...metrics, openClaimLimit: party.openClaimLimit })}
          </tr>
        ))}
      </tbody>
      <tfoot><tr><th scope="row">Repo total</th>{cells(total)}</tr></tfoot>
    </table>
  )
}

const TRACKER = { gh: 'GH#', lin: 'LIN ', bd: 'bd ', native: '#' }

function TrackerBadges({ trackers }: Pick<WorkRow, 'trackers'>) {
  return trackers.map(({ kind, id }) => <span className="label" key={`${kind}:${id}`}>{TRACKER[kind]}{id}</span>)
}

function PartyName({ party }: { party: Pick<NonNullable<WorkRow['party']>, 'name' | 'colour'> | null }) {
  return <span style={party?.colour ? { borderLeft: `3px solid ${party.colour}`, paddingLeft: 4 } : undefined}>{party?.name ?? 'external'}</span>
}

function Peek({ row, state, heading, close }: {
  row: WorkRow; state: State; heading: React.RefObject<HTMLHeadingElement | null>; close: () => void
}) {
  const until = row.root.task.claim?.until
  return (
    <>
      <h2 ref={heading} tabIndex={-1}>{row.title || `Task #${row.root.id}`}</h2>
      <button type="button" onClick={close}>close</button>
      <p>{row.workId} · {workGroupTitle(row.group)} · {row.reason}</p>
      <p><PartyName party={row.party} /> · {row.claimant ? nameOf(state, row.claimant) : 'unclaimed'}</p>
      {until && <p>claim until (board time) <time dateTime={until} title={until}>{until}</time></p>}
      <p>{row.prText}{row.prHead && <> · head <code title={row.prHead}>{row.prHead.slice(0, 7)}</code></>}</p>
      <p>spend {row.spendText}{row.spendText === 'unknown' && row.spend && row.spend.coverage !== 'unknown' && ` · ${row.spend.coverage}`}</p>
      {row.trackers.length > 0 && <p><TrackerBadges trackers={row.trackers} /></p>}
      {row.overlapText && <p>{row.overlapText}</p>}
      <Link to={here({ thread: row.root.id })}>open thread</Link>
    </>
  )
}

/** One task row. Without `openPeek` it has no peek button, as in the Inbox. */
export function Row({ row, state, current, expanded, openPeek, claimantLink, cellDetail }: {
  row: WorkRow; state: State; current?: boolean; expanded?: boolean
  openPeek?: (id: string, from: HTMLElement) => void; claimantLink?: string; cellDetail?: boolean
}) {
  const { root, party } = row
  return (
    <li data-task-id={root.id} data-work-row={`queue:${root.id}`} tabIndex={0} aria-current={current || undefined}>
      <small>{row.priority}</small>
      <small>{row.workId}</small>
      <Link to={here({ thread: root.id })}>{row.title || `Task #${root.id}`}</Link>
      <small><PartyName party={party} /></small>
      <small>{row.claimant && claimantLink ? <Link className="text-link" to={claimantLink}>{nameOf(state, row.claimant)}</Link>
        : row.claimant ? nameOf(state, row.claimant) : 'unclaimed'}</small>
      <small>{row.reason}</small>
      {cellDetail && <small>attempt {row.attempt ?? 'unknown'}</small>}
      {row.claimText && <small title={root.task.claim?.until}>{row.claimText}
        {cellDetail && root.task.claim && <> · board time <time dateTime={root.task.claim.until}>{root.task.claim.until}</time></>}
      </small>}
      <small>{row.branch && cellDetail ? `branch ${row.branch}` : row.prText}</small>
      <small>{row.spendText === 'unknown' ? 'spend unknown' : row.spendText}
        {cellDetail && row.spendText === 'unknown' && ` · ${row.spend?.coverage ?? 'unknown'} coverage`}
      </small>
      {cellDetail && <small>last handoff reason: {row.handoffReason ?? 'unknown'}</small>}
      <TrackerBadges trackers={row.trackers} />
      {row.overlapText && <small>{row.overlapText}</small>}
      {openPeek && <button type="button" aria-expanded={expanded} aria-controls={expanded ? 'work-peek' : undefined} onClick={(event) => openPeek(root.id, event.currentTarget)}>peek</button>}
    </li>
  )
}
