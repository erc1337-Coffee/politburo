import { ChevronRight, CircleX, FilePen, FilePlus, FileText, FolderOpen, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react'
import type { BlockView } from '../../api/routes.ts'
import { Text } from './message.tsx'

// A worker round as Cursor shows a turn: each thought a muted line that unfolds, each action one
// muted line whose output unfolds, and what the worker says between them as message text. The
// block's data comes from the orchestrator, which edits the reply while the round runs; the round's
// answer is the reply's own text, under the block.

type Item = { at: number; kind: string; text: string }
type Activity = {
  round: number
  state: string
  items: Item[]
  changes?: { files: number; insertions: number; deletions: number }
  checks?: Array<{ name: string; passed: boolean }>
}

type Step =
  | { kind: 'thought'; key: string; text: string; seconds: number | undefined }
  | { kind: 'action'; key: string; tool: string; target: string; output?: string; error?: string }
  | { kind: 'say'; key: string; text: string }
  | { kind: 'note'; key: string; level: string; text: string }

const span = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * The round's items as steps. An action takes the output or the error that follows it. A thought
 * arrives when its model message ends, so it took the time since the item before it. Keys follow
 * the item, not its place: the orchestrator drops the oldest items of a long round, and an open
 * step stays the step it was.
 */
export function stepsOf(items: readonly Item[]): Step[] {
  const steps: Step[] = []
  const seen = new Map<string, number>()
  let before: number | undefined
  for (const item of items) {
    const last = steps.at(-1)
    if (last?.kind === 'action' && last.output === undefined && last.error === undefined && (item.kind === 'output' || item.kind === 'error')) {
      if (item.kind === 'output') last.output = item.text
      else last.error = item.text
      before = item.at
      continue
    }
    const id = `${item.at}:${item.kind}`
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    const key = `${id}:${n}`
    if (item.kind === 'thinking') steps.push({ kind: 'thought', key, text: item.text, seconds: before === undefined ? undefined : item.at - before })
    else if (item.kind === 'tool') {
      const space = item.text.indexOf(' ')
      steps.push({ kind: 'action', key, tool: space < 0 ? item.text : item.text.slice(0, space), target: space < 0 ? '' : item.text.slice(space + 1) })
    } else if (item.kind === 'say') steps.push({ kind: 'say', key, text: item.text })
    else steps.push({ kind: 'note', key, level: item.kind, text: item.text })
    before = item.at
  }
  return steps
}

const ACTIONS: Record<string, { verb: string; icon: LucideIcon }> = {
  bash: { verb: 'Ran', icon: Terminal },
  read: { verb: 'Read', icon: FileText },
  edit: { verb: 'Edited', icon: FilePen },
  write: { verb: 'Wrote', icon: FilePlus },
  grep: { verb: 'Searched', icon: Search },
  find: { verb: 'Searched', icon: Search },
  ls: { verb: 'Listed', icon: FolderOpen },
}

function Action({ step }: { step: Extract<Step, { kind: 'action' }> }) {
  const known = ACTIONS[step.tool]
  const Icon = step.error !== undefined ? CircleX : (known?.icon ?? Wrench)
  const line = (
    <>
      <Icon size={13} strokeWidth={1.75} className="turn-icon" />
      <span className="turn-verb">{known?.verb ?? step.tool}</span>
      {step.target && <code className="turn-target">{step.target}</code>}
    </>
  )
  const detail = step.error ?? step.output
  if (detail === undefined) return <div className="turn-action">{line}</div>
  return (
    <details className={`turn-action${step.error !== undefined ? ' failed' : ''}`}>
      <summary>
        {line}
        <ChevronRight size={12} className="turn-chevron" />
      </summary>
      <pre>{detail}</pre>
    </details>
  )
}

function StepView({ step }: { step: Step }) {
  switch (step.kind) {
    case 'thought':
      return (
        <details className="turn-thought">
          <summary>
            {step.seconds !== undefined && step.seconds >= 1000 ? `Thought for ${span(step.seconds)}` : 'Thought'}
            <ChevronRight size={12} className="turn-chevron" />
          </summary>
          <p>{step.text}</p>
        </details>
      )
    case 'action':
      return <Action step={step} />
    case 'say':
      return <Text text={step.text} />
    case 'note':
      return <div className={`turn-note ${step.level}`}>{step.text}</div>
  }
}

export { isActivity } from './store.ts'

type Decision = { label: string; decided_by: string; reason: string; kev?: { label: string; confidence: number }; correction?: string; followups?: Array<{ id: string; title: string }> }

export function isDecision(block: BlockView): boolean {
  return block.schema === 'final_decision' && block.version === 1 && typeof (block.data as { label?: unknown }).label === 'string'
}

/** Who reached a decision: the rules, Kev, or Claude on top of Kev's first opinion. */
function decidedBy(data: Decision): string {
  if (data.decided_by === 'kev' && data.kev) return `Kev ${data.kev.confidence.toFixed(2)}`
  if (data.decided_by === 'claude') return data.kev ? `Kev ${data.kev.label} ${data.kev.confidence.toFixed(2)} → Claude` : 'Claude'
  return 'rules'
}

/** The orchestrator's final decision after a round: one accent line that unfolds into the reason. */
export function DecisionBlock({ block }: { block: BlockView }) {
  const data = block.data as unknown as Decision
  return (
    <div className="turn decision">
      <details className="turn-decision">
        <summary>
          <span className={`decision-mark ${data.label.toLowerCase()}`}>{data.label}</span>
          <span className="turn-target">{decidedBy(data)}</span>
          <ChevronRight size={12} className="turn-chevron" />
        </summary>
        <div className="decision-detail">
          <p>{data.reason}</p>
          {data.correction && <pre>{data.correction}</pre>}
          {data.followups?.map((task) => <div key={task.id}>#{task.id} {task.title}</div>)}
        </div>
      </details>
    </div>
  )
}

export function ActivityBlock({ block }: { block: BlockView }) {
  const data = block.data as unknown as Activity
  const running = data.state === 'running'
  const steps = stepsOf(data.items)
  const first = data.items[0]?.at
  const last = data.items.at(-1)?.at
  const worked = !running && first !== undefined && last !== undefined && last > first ? `Worked for ${span(last - first)}` : null
  return (
    <div className="turn">
      {steps.map((step) => <StepView key={step.key} step={step} />)}
      {running ? (
        <div className="turn-dots" role="status" aria-label="working"><i /><i /><i /></div>
      ) : (
        <div className="turn-foot">
          {data.state !== 'completed' && <span className="turn-ended">round {data.round} ended: {data.state.replaceAll('_', ' ')}</span>}
          {worked && <span>{worked}</span>}
          {data.changes && (
            <span>
              {data.changes.files} file{data.changes.files === 1 ? '' : 's'} <span className="added">+{data.changes.insertions}</span>{' '}
              <span className="removed-lines">−{data.changes.deletions}</span>
            </span>
          )}
          {data.checks?.map((check) => (
            <span key={check.name} className={check.passed ? 'added' : 'removed-lines'} title={check.passed ? 'passed' : 'failed'}>
              {check.passed ? '✓' : '✗'} {check.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
