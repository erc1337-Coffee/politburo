import { orchestratorCommand } from '../orchestrator/cli.ts'

export const name = 'orchestrator'
export const summary = 'orchestrator <serve|status|check> --config FILE'
export const usageOrder = 57
export const usage = ['swarm orchestrator <serve|status|check> --config FILE [--json]']

export function run(argv: string[]): Promise<number> {
  return orchestratorCommand(argv)
}
