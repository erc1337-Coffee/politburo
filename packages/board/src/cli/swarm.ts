import type { LocalOptions } from '../server/local.ts'
import { Failed } from './main.ts'

export function swarmOptions(
  options: { swarm?: true; teamTokens?: string; agentOps?: true },
  principal: string,
): LocalOptions {
  if (!options.swarm) return options.agentOps ? { agentOps: true } : {}
  if (options.teamTokens !== undefined) throw new Failed({
    class: 'usage',
    reason: 'invalid_arguments',
    message: "--swarm can't be used with --team-tokens.",
  })
  return { agentOps: true, attentionResponders: { '*': [principal] }, politburo: 1 }
}
