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

/** `repository` null is local work. `routes` are tried in order. `railway` absent or null: the channel uses no Railway. */
export const ChannelSettings = z
  .strictObject({
    repository: ChannelRepository.nullable(),
    routes: z.array(ChannelRoute).max(CHANNEL_ROUTES_MAX),
    railway: ChannelRailway.nullable().optional(),
  })
  .refine((settings) => new Set(settings.routes.map((route) => route.key)).size === settings.routes.length, 'a route is listed twice')

export type ChannelRoute = z.output<typeof ChannelRoute>
export type ChannelRailway = z.output<typeof ChannelRailway>
export type ChannelSettings = z.output<typeof ChannelSettings>

export const channelSettingsEvents = {
  'channel.configured': z.object({ channel: ChannelPath, settings: ChannelSettings, by: Author }),
}

export const ConfigureChannelBody = z.strictObject({ path: ChannelPath, settings: ChannelSettings })
export const RepositoriesQuery = z.strictObject({ query: z.string().max(100).optional() })

export type RepositoryView = { name: string; url: string; private: boolean; description: string | null }

export type ModelRoute = { key: string; label: string; provider: string; model: string }
