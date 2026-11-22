import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as board from './board.ts'
import { Ago, here, Link, useTypeToFocus } from './nav.tsx'
import { needsAction } from './needs.ts'
import type { State, TaskRoot, Viewer } from './store.ts'
import { Header } from './ui.tsx'
import { firstLine } from './words.ts'

export function NeedsAction({ state, viewer, now, lead }: { state: State; viewer: Viewer; now: number; lead: ReactNode }) {
  useTypeToFocus('main')
  useEffect(board.openNeeds, [])
  const latest = useMemo(() => needsAction(state, viewer, now), [state, viewer, now])
  const [frozen, setFrozen] = useState<typeof latest | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const hovered = useRef(false)
  const freeze = () => setFrozen((kept) => kept ?? latest)
  const release = (focused: EventTarget | null) => {
    const el = list.current
    if (!el || hovered.current || (focused instanceof Node && el.contains(focused))) return
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed && (el.contains(selection.anchorNode) || el.contains(selection.focusNode))) return
    setFrozen(null)
  }
  useEffect(() => {
    const changed = () => release(document.activeElement)
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [])
  // Live changes wait until the reader leaves the list. Loss of access does not.
  const shown = <T extends TaskRoot,>(rows: readonly T[]) => frozen ? rows.filter(({ id }) => Object.hasOwn(state.openTaskRoots, id)) : rows
  const { decisions, stalled, ready } = frozen ?? latest
  const visibleDecisions = shown(decisions), visibleStalled = shown(stalled), visibleReady = shown(ready)
  const empty = visibleDecisions.length === 0 && visibleStalled.length === 0 && visibleReady.length === 0
  return (
    <>
      <Header title="Needs action" live={state.live} lead={lead} />
      <div className="page home-view needs-view">
        <div ref={list} onFocus={freeze} onBlur={(event) => release(event.relatedTarget)}
          onMouseEnter={() => { if (!empty) { hovered.current = true; freeze() } }}
          onMouseLeave={() => { hovered.current = false; release(document.activeElement) }}>
          <Group title="Open decisions" rows={visibleDecisions} detail={(root) => <Ago iso={root.createdAt} now={now} prefix="open " />} />
          <Group title="Stalled or overdue claims" rows={visibleStalled} detail={(root) => <><Ago iso={root.task.claim.until} now={now} prefix="lease ended " /> ago</>} />
          <Group title="Ready work" rows={visibleReady} detail={(root) => root.task.priority ?? 'normal'} />
        </div>
        {empty && latest.errors.length === 0 && <p role="status">{state.tasksCounted ? 'nothing needs anyone' : 'loading…'}</p>}
        {latest.errors.map((error) => <p key={error} role="status" className="error">{error}</p>)}
      </div>
    </>
  )
}

function Group<T extends TaskRoot>({ title, rows, detail }: { title: string; rows: readonly T[]; detail: (root: T) => ReactNode }) {
  if (rows.length === 0) return null
  return (
    <section className="home-queue">
      <h2>{title}</h2>
      <ul role="list">
        {rows.map((root) => (
          <li key={root.id}>
            <Link to={here({ thread: root.id })}>{firstLine(root.text) || `Task #${root.id}`}</Link>
            <small>#{root.channel} · {detail(root)}</small>
          </li>
        ))}
      </ul>
    </section>
  )
}
