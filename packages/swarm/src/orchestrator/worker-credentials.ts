// The environment variables Pi needs for the party's providers, read from the orchestrator's own
// environment (politburo.env). They reach the worker sealed for its public key.
import type { PartyRoute } from './service.ts'

/** The variable that holds each provider's credential; others use `<PROVIDER>_API_KEY`. */
const VARIABLES: Record<string, string> = { 'claude-cli': 'CLAUDE_CODE_OAUTH_TOKEN' }

/**
 * The routes as the worker's Pi runs them. Without an Anthropic API key, `anthropic` routes use the
 * `claude-cli` provider, which sends each request through `claude --print` on the subscription:
 * Anthropic bills Pi's own `anthropic` provider with a subscription token as extra usage.
 */
export function workerRoutes<T extends Pick<PartyRoute, 'provider'>>(routes: readonly T[], env: NodeJS.ProcessEnv = process.env): T[] {
  return routes.map((route) => (route.provider === 'anthropic' && !env.ANTHROPIC_API_KEY ? { ...route, provider: 'claude-cli' } : route))
}

/** Pi's provider variables for the routes, read from `env`; `workerRoutes` decides the providers. */
export function workerEnvironment(routes: readonly Pick<PartyRoute, 'provider'>[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {}
  for (const provider of new Set(workerRoutes(routes, env).map((route) => route.provider))) {
    const name = VARIABLES[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    if (env[name]) result[name] = env[name]
  }
  return result
}
