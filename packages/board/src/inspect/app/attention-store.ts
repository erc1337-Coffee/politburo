import type { AttentionView, BoardEventView, MessageView, TaskView } from '../../api/routes.ts'
import { byWritten, isTask, type State, type TaskRoot, type Viewer } from './store.ts'

type AttentionRoot = TaskRoot & { task: TaskView & { attentionId: string } }

/** Every blocked task with an attention ID counts, even if the request is stale or canceled. */
export const holdsAttention = (root: MessageView | undefined): root is AttentionRoot =>
  isTask(root) && !root.deleted && root.task.state === 'blocked' && root.task.attentionId !== undefined

export function attentionTasks(state: State): AttentionRoot[] {
  return Object.values(state.messages).filter(holdsAttention).sort(byWritten)
}

type Snapshot = Pick<AttentionView, 'id' | 'commit'>
type AttentionRead = Pick<MessageView, 'version' | 'revision'> & { serial: number; id: string }
export type AttentionFailure = { words: string; unsupported: boolean }
export type AttentionResult = { is: 'here'; value: AttentionView | null } | ({ is: 'failed' } & AttentionFailure)

type AttentionItem = {
  latest?: AttentionRead
  view?: AttentionRead & { result: AttentionResult }
  answering?: { request: AttentionView; label: string }
  lock?: Snapshot & { through: number }
  notice?: Snapshot & { words: string; shown: boolean }
  /** A feed-confirmed answer stays in place for this visit, not in the open count. */
  answered?: AttentionView
}

export type AttentionState = {
  attention: Record<string, AttentionItem>
  attentionUnsupported: boolean
  tasksRefused: string | null
}

const sameSnapshot = (snapshot: Snapshot, request: AttentionView | null) =>
  request !== null && snapshot.id === request.id && snapshot.commit === request.commit

const putAttention = (state: State, id: string, item: AttentionItem): State =>
  ({ ...state, attention: { ...state.attention, [id]: item } })

export function beginAttentionRead(state: State, root: AttentionRoot) {
  const item = state.attention[root.id]
  const latest = { serial: (item?.latest?.serial ?? 0) + 1, version: root.version, revision: root.revision, id: root.task.attentionId }
  return { state: putAttention(state, root.id, { ...item, latest }), read: latest }
}

export function finishAttentionRead(state: State, id: string, read: AttentionRead, result: AttentionResult): State {
  const item = state.attention[id]
  const root = state.messages[id]
  if (!item || read.serial !== item.latest?.serial || !holdsAttention(root) || root.task.attentionId !== read.id) return state
  if (item.view && (read.version < item.view.version || read.revision < item.view.revision)) return state
  let { notice, lock } = item
  if (result.is === 'here') {
    if (notice && !sameSnapshot(notice, result.value)) notice = undefined
    if (lock && (!sameSnapshot(lock, result.value) || read.serial > lock.through)) lock = undefined
  }
  const next = putAttention(state, id, { ...item, notice, lock, view: { ...read, result } })
  return result.is === 'failed' && result.unsupported ? { ...next, attentionUnsupported: true } : next
}

export function beginAnswer(state: State, root: TaskRoot, request: AttentionView, label: string): State {
  return putAttention(state, root.id, { ...state.attention[root.id], answering: { request, label } })
}

export function failAnswer(state: State, id: string, request: AttentionView, failure: AttentionFailure): State {
  const item = state.attention[id]
  const root = state.messages[id]
  if (item?.answering?.request !== request) return state
  const next = { ...item, answering: undefined }
  const read = item.view?.result
  if (holdsAttention(root) && root.task.attentionId === request.id &&
      (read?.is !== 'here' || sameSnapshot(request, read.value))) {
    const { id, commit } = request
    next.lock = { id, commit, through: item.latest?.serial ?? 0 }
    next.notice = { id, commit, words: failure.words, shown: false }
  }
  return { ...putAttention(state, id, next), attentionUnsupported: state.attentionUnsupported || failure.unsupported }
}

/** All accepted roots pass here, including snapshots from thread and task lists. The request ID binds its immutable commit. */
export function reconcileAttention(state: State, views: MessageView[]): State {
  for (const root of views) {
    const item = state.attention[root.id]
    if (!item || state.messages[root.id] !== root) continue
    const current = holdsAttention(root) ? root.task.attentionId : undefined
    const { lock, notice } = item
    if ((lock && lock.id !== current) || (notice && notice.id !== current))
      state = putAttention(state, root.id, { ...item, lock: lock?.id === current ? lock : undefined, notice: notice?.id === current ? notice : undefined })
  }
  return state
}

/** A write response or thread snapshot can predate the feed. Only the feed settles a successful answer. */
export function confirmAttention(state: State, event: BoardEventView): State {
  const incoming = event.message
  if (!incoming) return state
  const root = state.messages[incoming.id]
  const item = state.attention[incoming.id]
  if (!root || !item) return state
  const { answering, view } = item
  if (event.type === 'task.attention_answered' && !holdsAttention(root) && !root.deleted && root.task?.attentionId === event.payload.requestId) {
    const read = view?.result.is === 'here' ? view.result.value : null
    const request = [read, answering?.request].find((request) => request?.id === event.payload.requestId)
    if (request) return putAttention(state, root.id, { ...item, answering: undefined, answered: { ...request, status: 'answered', receipt: event.payload.receipt } })
  }
  if (answering && state.messages[incoming.id] === incoming && (!holdsAttention(root) || root.task.attentionId !== answering.request.id))
    return putAttention(state, root.id, { ...item, answering: undefined })
  return state
}

export function attentionRows(state: State): TaskRoot[] {
  return Object.values(state.messages).filter((root): root is TaskRoot =>
    holdsAttention(root) || (isTask(root) && !root.deleted && root.task.attentionId !== undefined &&
      (state.attention[root.id]?.answered?.id === root.task.attentionId ||
        state.attention[root.id]?.answering?.request.id === root.task.attentionId))).sort(byWritten)
}

export const NO_ATTENTION = 'this board does not keep task attention requests'

export function attentionFor(state: State, root: TaskRoot, viewer: Viewer | null) {
  const item = state.attention[root.id]
  const held = holdsAttention(root)
  const read = item?.view?.id === root.task.attentionId ? item?.view?.result : undefined
  const value = read?.is === 'here' ? read.value : null
  const overlay = item?.answering?.request.id === root.task.attentionId ? item?.answering : undefined
  const attention = held ? (value?.id === root.task.attentionId ? value : null)
    : item?.answered?.id === root.task.attentionId ? item?.answered ?? null : overlay?.request ?? null
  const readError = held && read?.is === 'failed' ? read.words : null
  const answering = overlay?.label ?? null
  const unsupported = state.attentionUnsupported || state.discovery?.task_attention !== true
  const me = state.me
  const reason = unsupported ? NO_ATTENTION
    : attention?.status !== 'pending' ? `the request is ${attention?.status ?? 'not available'}`
    : !me || me.kind !== 'person' || me.profile !== null || me.actor !== me.principal || !viewer?.may('post', root.channel)
      ? 'answering needs a person acting as themselves with post access'
      : null
  const refreshing = item?.latest?.serial !== item?.view?.serial || (attention !== null && attention.revision !== root.revision)
  return { held, attention, readError, missing: read?.is === 'here' && read.value === null, error: item?.notice?.words, answering, reason,
    disabled: !held || answering !== null || refreshing || (item?.lock !== undefined && sameSnapshot(item.lock, attention)) }
}

export const hasUnshownRefusal = (state: State): boolean => Object.values(state.attention).some((item) => item.notice?.shown === false)

/** Acknowledge only notices actually rendered, not writes that arrived in the meantime. */
export function showAttentionRefusals(state: State, rendered: State): State {
  for (const root of attentionRows(rendered)) {
    const item = state.attention[root.id]
    const notice = item?.notice
    if (notice?.shown === false && notice === rendered.attention[root.id]?.notice)
      state = putAttention(state, root.id, { ...item, notice: { ...notice, shown: true } })
  }
  return state
}

export function leaveAttention(state: State): State {
  for (const [id, item] of Object.entries(state.attention)) {
    const notice = !item.lock && item.notice?.shown ? undefined : item.notice
    if (item.answered || notice !== item.notice) state = putAttention(state, id, { ...item, notice, answered: undefined })
  }
  return state
}
