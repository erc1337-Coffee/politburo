// The model routes of the party file (`tiers.models.sprite.routes`): the models a worker may use,
// in order. Without a party file, or without routes in it, the default route applies.
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

export type ModelRoute = { label: string; provider: string; model: string }

export const DEFAULT_ROUTES: readonly ModelRoute[] = [{ label: 'Cursor Grok', provider: 'cursor', model: 'cursor-grok-4.6-high' }]

export class ModelRouteError extends Error {}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ModelRouteError(`${field}: non-empty string expected`)
  return value
}

/** Reads the routes from the text of a party file. */
export function parseModelRoutes(source: string): ModelRoute[] {
  let document: unknown
  try {
    document = parse(source)
  } catch (error) {
    throw new ModelRouteError(`the party file is not valid YAML: ${(error as Error).message}`)
  }
  const routes = (document as { tiers?: { models?: { sprite?: { routes?: unknown } } } } | null)?.tiers?.models?.sprite?.routes
  if (routes === undefined) return [...DEFAULT_ROUTES]
  if (!Array.isArray(routes) || routes.length === 0) throw new ModelRouteError('tiers.models.sprite.routes: non-empty list expected')
  return routes.map((route: unknown, index) => {
    const field = `tiers.models.sprite.routes[${index}]`
    if (route === null || typeof route !== 'object' || Array.isArray(route)) throw new ModelRouteError(`${field}: object expected`)
    const { label, provider, model, ...rest } = route as Record<string, unknown>
    const unknown = Object.keys(rest)
    if (unknown.length > 0) throw new ModelRouteError(`${field}.${unknown[0]}: unknown setting`)
    return { label: text(label, `${field}.label`), provider: text(provider, `${field}.provider`), model: text(model, `${field}.model`) }
  })
}

/** Reads the routes of the party file at `path`, or the default routes when there is no file. */
export function readModelRoutes(path: string | null | undefined): ModelRoute[] {
  if (!path) return [...DEFAULT_ROUTES]
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new ModelRouteError(`cannot read ${path}`)
  }
  return parseModelRoutes(source)
}
