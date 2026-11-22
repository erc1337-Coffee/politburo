import { useEffect, useMemo, type ReactNode } from 'react'
import * as board from './board.ts'
import { Ago, here, Link, useTypeToFocus } from './nav.tsx'
import { needsAction } from './needs.ts'
import type { State, TaskRoot, Viewer } from './store.ts'
import { Header } from './ui.tsx'
import { firstLine } from './words.ts'

export function NeedsAction({ state, viewer, now, lead }: { state: State; viewer: Viewer; now: number; lead: ReactNode }) {
  useTypeToFocus('main')
  // Boot loads the open task roots. The request status isn't in the root;
  // reuse Attention's read lifecycle for decisions, without any answer controls.
  useEffect(board.openAttention, [])
  const { decisions, stalled, ready } = useMemo(() => needsAction(state, viewer, now), [state.messages, state.attention, viewer, now])
  const empty = decisions.length === 0 && stalled.length === 0 && ready.length === 0
  return (
    <>
      <Header title="Needs action" live={state.live} lead={lead} />
      <div className="page home-view needs-view">
        {empty && (state.tasksRefused !== null
          ? <p role="status" className="error">{state.tasksRefused}</p>
          : <p role="status">{state.tasksCounted ? 'nothing needs anyone' : 'loading…'}</p>)}
        <Group title="Open decisions" rows={decisions} detail={(root) => <Ago iso={root.createdAt} now={now} prefix="open " />} />
        <Group title="Stalled or overdue claims" rows={stalled} detail={(root) => <><Ago iso={root.task.claim.until} now={now} prefix="lease ended " /> ago</>} />
        <Group title="Ready work" rows={ready} detail={(root) => root.task.priority ?? 'normal'} />
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
