import { priorityRank } from '../../contract/schemas.ts'
import { attentionFor, needsAttentionAnswer } from './attention-store.ts'
import { byWritten, isTask, type State, type TaskRoot, type Viewer } from './store.ts'

const assigned = (root: TaskRoot, viewer: Viewer) => root.task.for === viewer.actor && root.task.owner === viewer.principal

type Claimed = TaskRoot & { task: TaskRoot['task'] & { claim: NonNullable<TaskRoot['task']['claim']> } }
const hasClaim = (root: TaskRoot): root is Claimed => root.task.state === 'claimed' && root.task.claim !== null
const overdue = (root: Claimed, now: number) => Date.parse(root.task.claim.until) <= now

/** The default claim-next queue across readable channels. `from` is explicit per claim, not a viewer setting. */
export function claimOrder(roots: readonly TaskRoot[], state: State, viewer: Viewer, now: number): TaskRoot[] {
  const pauseEpoch = state.status?.pauseEpoch
  return roots.filter((root) => {
    const { task, channel } = root
    const ready = task.state === 'ready' || (hasClaim(root) && (overdue(root, now) || (pauseEpoch !== undefined && (root.task.claim.pauseEpoch ?? 0) !== pauseEpoch)))
    return !root.deleted && !task.parked && ready && viewer.may('label', channel) &&
      (assigned(root, viewer) || (task.for === null && task.owner === viewer.principal))
  }).sort((a, b) => priorityRank(b.task.priority) - priorityRank(a.task.priority) ||
    Number(assigned(b, viewer)) - Number(assigned(a, viewer)) ||
    // The local engine scans roots in log order, even if its clock goes backward. Without that
    // advertised order (including on Vercel's delegated claim route), createdAt is only an
    // approximation: equal-priority, equally assigned tasks may be claimed in a different order.
    (state.discovery?.claim_order === 'root-id' ? Number(a.id) - Number(b.id) : byWritten(a, b)))
}

export function needsAction(state: State, viewer: Viewer, now: number) {
  const decisions: TaskRoot[] = []
  const stalled: Claimed[] = []
  const candidates: TaskRoot[] = []
  const errors = new Set<string>()
  if (state.tasksRefused !== null) errors.add(state.tasksRefused)
  for (const root of Object.values(state.openTaskRoots)) {
    if (!isTask(root) || root.deleted) continue
    if (needsAttentionAnswer(state, root)) {
      decisions.push(root)
      const { readError } = attentionFor(state, root, viewer)
      if (readError !== null) errors.add(readError)
    } else {
      if (hasClaim(root) && overdue(root, now)) stalled.push(root)
      candidates.push(root)
    }
  }
  const stalledIds = new Set(stalled.map(({ id }) => id))
  return {
    errors: [...errors],
    decisions: decisions.sort(byWritten), // The task's creation is the age the attention view has, too.
    stalled: stalled.sort((a, b) => Date.parse(a.task.claim.until) - Date.parse(b.task.claim.until) || byWritten(a, b)),
    ready: claimOrder(candidates, state, viewer, now).filter(({ id }) => !stalledIds.has(id)),
  }
}
