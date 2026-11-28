import { z } from 'zod'
import { Author, ChannelPath } from './schemas.ts'

export const CHANNEL_ROUTES_MAX = 32

/** An https Git URL with no credentials: workers pass it to `git clone`. */
export const ChannelRepository = z
  .string()
  .max(500)
  .refine((value) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return false
    }
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '' &&
      url.hostname !== '' && url.pathname.length > 1 && !/[\s\x00-\x1f\x7f]/.test(value)
  }, 'expected an https Git URL without credentials')

/** `<provider>/<model>` */
export const ChannelRouteKey = z.string().min(3).max(200).regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@+-]+$/, 'expected <provider>/<model>')

export const ChannelRoute = z.strictObject({ key: ChannelRouteKey, enabled: z.boolean() })

export const CHANNEL_RAILWAY_SERVICES_MAX = 20

/** A Railway project, environment or service id. */
export const RailwayId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a Railway id')

/** The Railway services of a channel, in one project's production environment. The orchestrator holds the token. */
export const ChannelRailway = z.strictObject({
  projectId: RailwayId,
  projectName: z.string().max(200),
  environmentId: RailwayId,
  services: z.array(z.strictObject({ id: RailwayId, name: z.string().max(200) })).max(CHANNEL_RAILWAY_SERVICES_MAX),
})

export const CHANNEL_LISTENERS_MAX = 20
const Port = z.number().int().min(1).max(65_535)

/**
 * A local listener: one Docker container built from the channel's repository (`main`, else
 * `master`) at `subpath`, published at `port` on the host addresses named in `interfaces`.
 * `id` names its container and image on the host, so it is unique on the board.
 */
export const ChannelListener = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'expected lowercase letters, digits, dashes and underscores'),
  name: z.string().min(1).max(60),
  subpath: z.string().max(300).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._\/-]*$/, 'expected a path inside the repository'),
  port: Port,
  containerPort: Port,
  interfaces: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).min(1).max(8),
})

/** Local deployment: the channel's Dockerfile, copied from the board's template, and its listeners. */
export const ChannelLocalDeployment = z.strictObject({
  dockerfile: z.string().min(1).max(64 * 1024),
  listeners: z.array(ChannelListener).max(CHANNEL_LISTENERS_MAX),
})

/**
 * `repository` null is local work. `routes` are tried in order. Deployment: `railway` or `local`,
 * never both; both absent or null is none.
 */
export const ChannelSettings = z
  .strictObject({
    repository: ChannelRepository.nullable(),
    routes: z.array(ChannelRoute).max(CHANNEL_ROUTES_MAX),
    railway: ChannelRailway.nullable().optional(),
    local: ChannelLocalDeployment.nullable().optional(),
  })
  .refine((settings) => !(settings.railway && settings.local), { message: 'a channel deploys on Railway or locally, not both', path: ['local'] })
  .refine((settings) => new Set((settings.local?.listeners ?? []).map((listener) => listener.id)).size === (settings.local?.listeners.length ?? 0),
    { message: 'listener ids must differ', path: ['local', 'listeners'] })
  .refine((settings) => new Set((settings.local?.listeners ?? []).map((listener) => listener.port)).size === (settings.local?.listeners.length ?? 0),
    { message: 'listener ports must differ', path: ['local', 'listeners'] })
  .refine((settings) => new Set(settings.routes.map((route) => route.key)).size === settings.routes.length, 'a route is listed twice')

export type ChannelRoute = z.output<typeof ChannelRoute>
export type ChannelRailway = z.output<typeof ChannelRailway>
export type ChannelListener = z.output<typeof ChannelListener>
export type ChannelLocalDeployment = z.output<typeof ChannelLocalDeployment>
export type ChannelSettings = z.output<typeof ChannelSettings>

export const channelSettingsEvents = {
  'channel.configured': z.object({ channel: ChannelPath, settings: ChannelSettings, by: Author }),
}

export const ConfigureChannelBody = z.strictObject({ path: ChannelPath, settings: ChannelSettings })
export const RepositoriesQuery = z.strictObject({ query: z.string().max(100).optional() })

export type RepositoryView = { name: string; url: string; private: boolean; description: string | null }

export type ModelRoute = { key: string; label: string; provider: string; model: string }
