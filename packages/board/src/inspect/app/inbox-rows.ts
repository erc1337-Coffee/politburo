import { DEFAULT_TASK_PRIORITY, priorityRank, type TaskPriority } from '../../contract/schemas.ts'
import { needsAttentionAnswer } from './attention-store.ts'
import { byWritten, isTask, type State, type TaskRoot } from './store.ts'
import { ago, firstLine, until } from './words.ts'

/** What needs a person, beside the questions: an open task waiting on an answer, or one whose claim lapsed. */
export const SECTIONS = [
  { group: 'needs', title: 'Needs you' },
  { group: 'repair', title: 'Repair or reconcile' },
] as const
export type InboxGroup = (typeof SECTIONS)[number]['group']

export type InboxRow = {
  root: TaskRoot
  group: InboxGroup
  reason: string
  workId: string
  title: string
  priority: TaskPriority
  party: string | null
  claimant: string | null
  claimText: string | null
}

/** Whether a task's claim is over: past its lease, whatever the board last wrote. */
const lapsed = (root: TaskRoot, now: number) =>
  root.task.state === 'claimed' && root.task.claim !== null && Date.parse(root.task.claim.until) <= now

/** Which section an open task belongs to, and why, or null for one that needs no person. */
function sectionOf(state: State, root: TaskRoot, now: number): [InboxGroup, string] | null {
  const { task } = root
  if (task.state === 'completed' || task.state === 'failed' || task.state === 'canceled') return null
  if (needsAttentionAnswer(state, root)) return ['needs', 'attention answer needed']
  if (lapsed(root, now)) return ['repair', `claim lapsed ${ago(task.claim!.until, now)} ago`]
  return null
}

/** A task's `work.id` label, when it is one: `wp-12`. */
function workIdOf(root: TaskRoot): string | undefined {
  const id = root.labels['work.id']?.toLowerCase()
  return id && /^[a-z][a-z0-9]*-\d+$/.test(id) ? id : undefined
}

function claimText(claim: TaskRoot['task']['claim'], now: number): string | null {
  if (!claim) return null
  if (Date.parse(claim.until) <= now) return `expired ${ago(claim.until, now)} ago`
  const remaining = until(claim.until, now)
  return `expires ${remaining === 'now' ? 'in 0s' : remaining}`
}

/** The open tasks that need a person, by section, highest priority first, then oldest. */
export function inboxRows(state: State, now: number): Map<InboxGroup, InboxRow[]> {
  const sections = new Map<InboxGroup, InboxRow[]>(SECTIONS.map(({ group }) => [group, []]))
  for (const root of Object.values(state.openTaskRoots)) {
    if (!isTask(root) || root.deleted) continue
    const section = sectionOf(state, root, now)
    if (!section) continue
    const [group, reason] = section
    sections.get(group)!.push({
      root, group, reason,
      workId: workIdOf(root) ?? `#${root.id}`,
      title: firstLine(root.text),
      priority: root.task.priority ?? DEFAULT_TASK_PRIORITY,
      party: root.labels.party || null,
      claimant: root.task.claim?.actor ?? null,
      claimText: claimText(root.task.claim, now),
    })
  }
  for (const rows of sections.values()) rows.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || byWritten(a.root, b.root))
  return sections
}
