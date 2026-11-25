// swarm orchestrator serve | status | check
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { board as openBoard } from '@vercel/board'
import { loadConfig, parseConfigText } from '../config/load.ts'
import { loadOrchestratorConfig, type OrchestratorConfig } from './config.ts'
import { GitRepositories } from './git.ts'
import { GitHubClient } from './github.ts'
import { openJournal } from './launch.ts'
import { cloudProvider } from './launcher.ts'
import { RelayClient } from './relay-client.ts'
import { Orchestrator, type PartyRoute } from './service.ts'
import { acquireLock, StateStore } from './state.ts'

const usage = 'usage: swarm orchestrator <serve|status|check> --config FILE [--json]'

function partyRoutes(config: OrchestratorConfig): PartyRoute[] {
  const party = config.partyFile ? parseConfigText(readFileSync(config.partyFile, 'utf8')) : undefined
  return loadConfig({ party, repo: undefined }).tiers.models.sprite.routes as PartyRoute[]
}

async function serve(config: OrchestratorConfig): Promise<number> {
  mkdirSync(join(config.stateDirectory, 'journal'), { recursive: true, mode: 0o700 })
  const unlock = acquireLock(join(config.stateDirectory, 'orchestrator.lock'))
  const token = process.env.GITHUB_TOKEN?.trim()
  if (!token) {
    unlock()
    console.error('error: GITHUB_TOKEN is not set')
    return 1
  }
  const state = new StateStore(join(config.stateDirectory, 'state.sqlite'))
  const orchestrator = new Orchestrator({
    config,
    board: openBoard().as(config.boardProfile),
    relay: new RelayClient({ url: config.relay.url, signingKey: readFileSync(config.relay.signingKeyFile, 'utf8'), orchestratorTtlSeconds: config.tokens.orchestratorTtlSeconds }),
    github: new GitHubClient({ apiUrl: config.github.apiUrl, token }),
    git: new GitRepositories({ directory: join(config.stateDirectory, 'repositories'), urlBase: 'https://github.com', token }),
    state,
    journal: openJournal(join(config.stateDirectory, 'journal')),
    routes: () => partyRoutes(config),
    provider: (prompt, directory) => cloudProvider(config.worker.launcher, prompt, directory),
  })
  await orchestrator.start()
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
  await orchestrator.stop()
  state.close()
  unlock()
  return 0
}

function status(config: OrchestratorConfig, json: boolean): number {
  const state = new StateStore(join(config.stateDirectory, 'state.sqlite'))
  try {
    const live = state.live()
    if (json) {
      console.log(JSON.stringify({ live: live.map(({ claimToken: _, ...rest }) => rest), recent: state.all(20).map(({ claimToken: _, ...rest }) => rest) }))
      return 0
    }
    if (live.length === 0) console.log('no live attempts')
    for (const attempt of live) {
      const contact = attempt.lastContactAt ? `${Math.round((Date.now() - attempt.lastContactAt) / 1000)}s ago` : 'never'
      console.log(`#${attempt.taskId} attempt ${attempt.attemptNo} round ${attempt.round}  ${attempt.state}  contact ${contact}  ${attempt.repository} ${attempt.branch}`)
    }
    return 0
  } finally {
    state.close()
  }
}

export async function orchestratorCommand(argv: string[]): Promise<number> {
  const [action, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { config: { type: 'string' }, json: { type: 'boolean' } } })
  if (!action || !['serve', 'status', 'check'].includes(action) || !values.config) {
    console.error(usage)
    return 2
  }
  let config: OrchestratorConfig
  try {
    config = loadOrchestratorConfig(values.config)
    if (action !== 'status') partyRoutes(config)
  } catch (error) {
    console.error(`error: ${(error as Error).message}`)
    return 1
  }
  if (action === 'check') {
    console.log(JSON.stringify({ ok: true, repositories: config.repositories.allow, routes: partyRoutes(config).map((route) => route.label) }))
    return 0
  }
  if (action === 'status') return status(config, values.json === true)
  return serve(config)
}
