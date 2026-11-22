import { priorityRank } from '../../contract/schemas.ts'
import { needsAttentionAnswer } from './attention-store.ts'
import { byWritten, isTask, stateNow, type State, type TaskRoot, type Viewer } from './store.ts'

const assigned = (root: TaskRoot, viewer: Viewer) => root.task.for === viewer.actor

/**
 * Order readable tasks as an unfiltered claim-next would, without a `from` override:
 * only the viewer's own unparked, ready work where they can label, then priority,
 * assignment to their actor, and age. A paused board still shows its queue.
 */
export function claimOrder(roots: readonly TaskRoot[], viewer: Viewer, now: number): TaskRoot[] {
  return roots.filter((root) => {
    const { task, channel } = root
    return !root.deleted && task.owner === viewer.principal && (task.for === null || assigned(root, viewer)) &&
      !task.parked && stateNow(task, now) === 'ready' && viewer.may('label', channel)
  }).sort((a, b) => priorityRank(b.task.priority) - priorityRank(a.task.priority) ||
    Number(assigned(b, viewer)) - Number(assigned(a, viewer)) || byWritten(a, b))
}

type Stalled = TaskRoot & { task: TaskRoot['task'] & { claim: NonNullable<TaskRoot['task']['claim']> } }

export function needsAction(state: State, viewer: Viewer, now: number) {
  const decisions: TaskRoot[] = []
  const stalled: Stalled[] = []
  const remaining: TaskRoot[] = []
  for (const root of Object.values(state.messages)) {
    if (!isTask(root) || root.deleted || !viewer.may('read', root.channel)) continue
    if (needsAttentionAnswer(state, root)) decisions.push(root)
    else if (isOverdue(root, now)) stalled.push(root)
    else remaining.push(root)
  }
  return {
    decisions: decisions.sort(byWritten), // The task's creation is the age the attention view has, too.
    stalled: stalled.sort((a, b) => Date.parse(a.task.claim.until) - Date.parse(b.task.claim.until) || byWritten(a, b)),
    ready: claimOrder(remaining, viewer, now),
  }
}

function isOverdue(root: TaskRoot, now: number): root is Stalled {
  return root.task.state === 'claimed' && root.task.claim !== null && stateNow(root.task, now) === 'ready'
}
