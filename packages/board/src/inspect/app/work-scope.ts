import type { Route } from './routes.ts'
import { isTask, type State } from './store.ts'

export type WorkRoute = Extract<Route, { view: 'work' | 'cell' }>

export function isWorkRoute(route: Route): route is WorkRoute {
  return route.view === 'work' || route.view === 'cell'
}

export const workTitle = (route: WorkRoute) => route.view === 'cell' ? 'Cell' : 'Work'

/** Like the Cell's peek, check scope membership before display filters. */
export function cellHasThread(state: Pick<State, 'openTaskRoots' | 'messages'>, actor: string, id: string): boolean {
  const root = Object.hasOwn(state.openTaskRoots, id) ? state.openTaskRoots[id] : undefined
  if (!(isTask(root) && !root.deleted && root.task.claim?.actor === actor)) return false
  const known = Object.hasOwn(state.messages, id) ? state.messages[id] : undefined
  const newest = known !== undefined && known.version > root.version ? known : root
  return isTask(newest) && newest.task.claim?.actor === actor
}

/** Carry the party scope and the preview across views, not the previous view's filters or open row. */
export function workScopeUrl(path: string, from: URLSearchParams, party?: string | null) {
  const params = new URLSearchParams()
  if (party != null) params.set('party', party)
  if (from.get('swarm') === 'fixtures') params.set('swarm', 'fixtures')
  return params.size ? `${path}?${params}` : path
}
