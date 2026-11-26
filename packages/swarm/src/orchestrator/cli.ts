// swarm orchestrator serve | status | check
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { board as openBoard } from '@vercel/board'
import { loadConfig, parseConfigText } from '../config/load.ts'
import { loadOrchestratorConfig, type OrchestratorConfig } from './config.ts'
import { claudeRunner, FinalDecider, KevClient } from './final-decision.ts'
import { GitRepositories } from './git.ts'
import { UsageLedger } from './usage-ledger.ts'
import { idleSnapshot, OperationsMonitor } from './operations.ts'
import { startOperationsServer, type OperationsServer } from './operations-server.ts'
import { GitHubClient } from './github.ts'
import { openJournal } from './launch.ts'
import { cloudProvider } from './launcher.ts'
import { RelayClient } from './relay-client.ts'
import { Orchestrator, type PartyRoute } from './service.ts'
import { acquireLock, StateStore } from './state.ts'

const usage = 'usage: swarm orchestrator <serve|status|check> --config FILE [--json]\n       swarm orchestrator idle --reason TEXT [--port N]'

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
  const monitor = config.operations.port > 0 ? new OperationsMonitor({ relayUrl: config.relay.url }) : null
  const usageLedger = new UsageLedger({ file: config.ledger.file, party: config.ledger.party, requestedRoute: config.worker.piModel })
  try {
    usageLedger.initialize()
  } catch (error) {
    console.error(`orchestrator: the spend ledger cannot be opened: ${(error as Error).message}`)
  }
  const orchestrator = new Orchestrator({
    config,
    monitor,
    board: openBoard().as(config.boardProfile),
    relay: new RelayClient({ url: config.relay.url, signingKey: readFileSync(config.relay.signingKeyFile, 'utf8'), orchestratorTtlSeconds: config.tokens.orchestratorTtlSeconds }),
    github: new GitHubClient({ apiUrl: config.github.apiUrl, token }),
    git: new GitRepositories({ directory: join(config.stateDirectory, 'repositories'), localDirectory: join(config.stateDirectory, 'channel_repositories'), urlBase: 'https://github.com', token }),
    state,
    journal: openJournal(join(config.stateDirectory, 'journal')),
    routes: () => partyRoutes(config),
    provider: (prompt, directory) => cloudProvider(config.worker.launcher, prompt, directory),
    usage: usageLedger,
    decider: new FinalDecider({
      kev: config.decision.kevUrl ? new KevClient({ url: config.decision.kevUrl, timeoutMs: config.decision.kevTimeoutSeconds * 1000 }) : null,
      claude: config.decision.claudeModel
        ? claudeRunner({ model: config.decision.claudeModel, directory: join(config.stateDirectory, 'decision'), timeoutMs: config.decision.claudeTimeoutSeconds * 1000 })
        : null,
      kevConfidence: config.decision.kevConfidence,
      followupDepth: config.decision.followupDepth,
      log: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
    }),
  })
  let operations: OperationsServer | null = null
  if (monitor) {
    try {
      operations = await startOperationsServer({ monitor, port: config.operations.port, snapshot: () => orchestrator.operations()! })
      console.error(`orchestrator: operations status at ${operations.url}`)
    } catch (error) {
      console.error(`orchestrator: the operations status server did not start: ${(error as Error).message}`)
    }
  }
  try {
    await orchestrator.start()
  } catch (error) {
    await operations?.close()
    state.close()
    unlock()
    throw error
  }
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
  await operations?.close()
  await orchestrator.stop()
  state.close()
  unlock()
  return 0
}

/** Serves only the status, saying why the orchestrator does not run, until it is stopped. */
async function idle(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { reason: { type: 'string' }, port: { type: 'string' } } })
  const port = Number(values.port ?? 4780)
  if (!values.reason || !Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(usage)
    return 2
  }
  const reason = values.reason
  const monitor = new OperationsMonitor({ relayUrl: process.env.RELAY_URL ?? '' })
  const server = await startOperationsServer({ monitor, port, snapshot: () => idleSnapshot(reason, process.env.RELAY_URL ?? '') })
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
  await server.close()
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
  if (action === 'idle') return idle(rest)
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
    console.log(JSON.stringify({ ok: true, routes: partyRoutes(config).map((route) => route.label) }))
    return 0
  }
  if (action === 'status') return status(config, values.json === true)
  return serve(config)
}
