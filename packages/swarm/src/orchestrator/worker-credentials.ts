// The environment variables Pi needs for the party's providers, read from the orchestrator's own
// environment (politburo.env). They reach the worker sealed for its public key.
import type { PartyRoute } from './service.ts'

/** Pi's variable for each provider, and where its value comes from here, first set wins. */
const SOURCES: Record<string, { name: string; from: string[] }> = {
  anthropic: { name: 'ANTHROPIC_OAUTH_TOKEN', from: ['ANTHROPIC_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] },
  openrouter: { name: 'OPENROUTER_API_KEY', from: ['OPENROUTER_API_KEY'] },
}

export function workerEnvironment(routes: readonly Pick<PartyRoute, 'provider'>[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {}
  for (const provider of new Set(routes.map((route) => route.provider))) {
    if (provider === 'anthropic' && env.ANTHROPIC_API_KEY) {
      result.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
      continue
    }
    const source = SOURCES[provider] ?? { name: `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`, from: [] }
    const value = [source.name, ...source.from].map((name) => env[name]).find(Boolean)
    if (value) result[source.name] = value
  }
  return result
}
