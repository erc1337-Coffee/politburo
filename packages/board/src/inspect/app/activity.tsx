import { ChevronRight } from 'lucide-react'
import type { BlockView } from '../../api/routes.ts'

// A worker round as Claude shows a turn: what the worker thought and did, folded away, then what it
// said. The block's data comes from the orchestrator, which edits the reply while the round runs.

type Item = { at: number; kind: string; text: string }
type Activity = {
  round: number
  state: string
  items: Item[]
  changes?: { files: number; insertions: number; deletions: number }
  checks?: Array<{ name: string; passed: boolean }>
}

/** Consecutive thinking, actions and their output form one step group; a message stands alone. */
function groups(items: Item[]): Array<{ kind: 'steps'; items: Item[] } | { kind: 'say'; item: Item }> {
  const out: Array<{ kind: 'steps'; items: Item[] } | { kind: 'say'; item: Item }> = []
  for (const item of items) {
    if (item.kind === 'say') {
      out.push({ kind: 'say', item })
      continue
    }
    const last = out.at(-1)
    if (last?.kind === 'steps') last.items.push(item)
    else out.push({ kind: 'steps', items: [item] })
  }
  return out
}

function summary(items: Item[]): string {
  const tools = items.filter((item) => item.kind === 'tool').length
  const thoughts = items.filter((item) => item.kind === 'thinking').length
  const errors = items.filter((item) => item.kind === 'error').length
  return [thoughts && 'thought', tools && `${tools} action${tools === 1 ? '' : 's'}`, errors && `${errors} error${errors === 1 ? '' : 's'}`]
    .filter(Boolean).join(' · ') || `${items.length} note${items.length === 1 ? '' : 's'}`
}

function Step({ item, output }: { item: Item; output: Item | undefined }) {
  if (item.kind === 'thinking')
    return (
      <details className="activity-step thinking">
        <summary><ChevronRight size={12} /> thinking</summary>
        <pre>{item.text}</pre>
      </details>
    )
  if (item.kind === 'tool')
    return output ? (
      <details className="activity-step">
        <summary><ChevronRight size={12} /> <code>{item.text}</code></summary>
        <pre>{output.text}</pre>
      </details>
    ) : (
      <div className="activity-step"><code>{item.text}</code></div>
    )
  return <div className={`activity-step ${item.kind}`}>{item.text}</div>
}

function Steps({ items, open }: { items: Item[]; open: boolean }) {
  const rows: Array<{ item: Item; output: Item | undefined }> = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind === 'output') continue
    const next = items[i + 1]
    rows.push({ item, output: item.kind === 'tool' && next?.kind === 'output' ? next : undefined })
  }
  return (
    <details className="activity-steps" open={open}>
      <summary><ChevronRight size={12} /> {summary(items)}</summary>
      <div className="activity-step-list">
        {rows.map((row, i) => <Step key={i} item={row.item} output={row.output} />)}
      </div>
    </details>
  )
}

export function isActivity(block: BlockView): boolean {
  return block.schema === 'worker_activity' && block.version === 1 && Array.isArray((block.data as { items?: unknown }).items)
}

export function ActivityBlock({ block }: { block: BlockView }) {
  const data = block.data as unknown as Activity
  const running = data.state === 'running'
  const parts = groups(data.items)
  return (
    <div className="activity">
      {parts.map((part, i) =>
        part.kind === 'say' ? (
          <p key={i} className="activity-say">{part.item.text}</p>
        ) : (
          <Steps key={i} items={part.items} open={running && i === parts.length - 1} />
        ),
      )}
      {running && <div className="activity-running">working…</div>}
      {!running && data.state !== 'completed' && <div className="activity-end">round {data.round} ended: {data.state.replace('_', ' ')}</div>}
      {data.changes && (
        <div className="activity-end">
          {data.changes.files} file{data.changes.files === 1 ? '' : 's'} · <span className="added">+{data.changes.insertions}</span> <span className="removed-lines">−{data.changes.deletions}</span>
          {data.checks?.map((check) => <span key={check.name} className={check.passed ? 'added' : 'removed-lines'}> · {check.name}</span>)}
        </div>
      )}
    </div>
  )
}
