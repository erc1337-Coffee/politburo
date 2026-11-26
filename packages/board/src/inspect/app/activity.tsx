import { ChevronRight } from 'lucide-react'
import type { BlockView } from '../../api/routes.ts'

// A worker round as Claude or Cursor shows a turn: one muted, foldable "Worked" group with the
// worker's thinking, narration and actions, then its answer as the message text. The block's data
// comes from the orchestrator, which edits the reply while the round runs.

type Item = { at: number; kind: string; text: string }
type Activity = {
  round: number
  state: string
  items: Item[]
  changes?: { files: number; insertions: number; deletions: number }
  checks?: Array<{ name: string; passed: boolean }>
}

const span = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function Step({ item, output }: { item: Item; output: Item | undefined }) {
  switch (item.kind) {
    case 'thinking':
      return (
        <details className="activity-thought">
          <summary>Thought <ChevronRight size={11} /></summary>
          <p>{item.text}</p>
        </details>
      )
    case 'say':
      return <p className="activity-say">{item.text}</p>
    case 'tool':
      return output ? (
        <details className="activity-tool">
          <summary>{item.text} <ChevronRight size={11} /></summary>
          <pre>{output.text}</pre>
        </details>
      ) : (
        <div className="activity-tool">{item.text}</div>
      )
    default:
      return <div className={`activity-note ${item.kind}`}>{item.text}</div>
  }
}

export function isActivity(block: BlockView): boolean {
  return block.schema === 'worker_activity' && block.version === 1 && Array.isArray((block.data as { items?: unknown }).items)
}

export function ActivityBlock({ block }: { block: BlockView }) {
  const data = block.data as unknown as Activity
  const running = data.state === 'running'
  const rows: Array<{ item: Item; output: Item | undefined }> = []
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i]!
    if (item.kind === 'output') continue
    const next = data.items[i + 1]
    rows.push({ item, output: item.kind === 'tool' && next?.kind === 'output' ? next : undefined })
  }
  const first = data.items[0]?.at
  const last = data.items.at(-1)?.at
  const title = running ? 'Working…' : first !== undefined && last !== undefined && last > first ? `Worked for ${span(last - first)}` : 'Worked'
  return (
    <div className="activity">
      {rows.length > 0 ? (
        <details className="activity-group" open={running}>
          <summary className={running ? 'running' : ''}>{title} <ChevronRight size={12} /></summary>
          <div className="activity-steps">
            {rows.map((row, i) => <Step key={i} item={row.item} output={row.output} />)}
          </div>
        </details>
      ) : running ? (
        <div className="activity-group"><span className="running">Working…</span></div>
      ) : null}
      {!running && data.state !== 'completed' && <div className="activity-note">round {data.round} ended: {data.state.replace('_', ' ')}</div>}
      {data.changes && (
        <div className="activity-note">
          {data.changes.files} file{data.changes.files === 1 ? '' : 's'} · <span className="added">+{data.changes.insertions}</span> <span className="removed-lines">−{data.changes.deletions}</span>
          {data.checks?.map((check) => <span key={check.name} className={check.passed ? 'added' : 'removed-lines'}> · {check.name}</span>)}
        </div>
      )}
    </div>
  )
}
