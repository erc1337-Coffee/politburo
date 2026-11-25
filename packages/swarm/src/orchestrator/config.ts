// Orchestrator configuration: one YAML file (snake_case keys), merged over defaults.
// Secrets are never in this file: only paths and environment variable names.
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

export interface CheckConfig { name: string; command: string; timeoutSeconds: number }

export interface OrchestratorConfig {
  /** Directory for the state database, the launch journal and the lock. Mount it only into this service. */
  stateDirectory: string
  /** Board profile the orchestrator claims and writes as. */
  boardProfile: string
  /** Party file for the model routes (`tiers.models.sprite.routes`). */
  partyFile: string | null
  sweepSeconds: number
  relay: { url: string; signingKeyFile: string }
  board: { leaseSeconds: number }
  /** Board channels the orchestrator takes tasks from: exact paths, or `prefix/` for a subtree. */
  repositories: { allow: string[]; deny: string[] }
  admission: { liveAttempts: number; perChannel: number; perRepository: number }
  limits: { roundsPerAttempt: number; attemptsPerTask: number; attemptWallMinutes: number; taskBudgetUsd: number }
  tokens: { workerTtlSeconds: number; orchestratorTtlSeconds: number }
  watchdog: { heartbeatSeconds: number; contactTimeoutSeconds: number; missedHeartbeats: number; stopGraceSeconds: number; questionWaitSeconds: number }
  worker: {
    /** Command and fixed arguments; the prompt is appended as the last argument. Run without a shell. */
    launcher: string[]
    /** Path of the worker protocol file in the worker's repository checkout. */
    protocolPath: string
    piModel: string
    maxSeconds: number
    idleSeconds: number
    progressMode: 'summary' | 'events'
    checks: CheckConfig[]
  }
  github: { apiUrl: string }
  /** The party's spend ledger. The orchestrator appends the usage of every worker round. */
  ledger: { file: string; party: string }
  /** The read-only status server of the operations view, on 127.0.0.1. Port 0 turns it off. */
  operations: { port: number; relayStatisticsSeconds: number }
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  stateDirectory: '/orchestrator',
  boardProfile: 'orchestrator',
  partyFile: null,
  sweepSeconds: 30,
  relay: { url: '', signingKeyFile: '/orchestrator/keys/relay_signing_key.pem' },
  board: { leaseSeconds: 900 },
  repositories: { allow: [], deny: ['remiliacorporation/politburo', 'vercel/board'] },
  admission: { liveAttempts: 2, perChannel: 1, perRepository: 1 },
  limits: { roundsPerAttempt: 3, attemptsPerTask: 2, attemptWallMinutes: 120, taskBudgetUsd: 10 },
  tokens: { workerTtlSeconds: 3600, orchestratorTtlSeconds: 900 },
  watchdog: { heartbeatSeconds: 60, contactTimeoutSeconds: 900, missedHeartbeats: 5, stopGraceSeconds: 300, questionWaitSeconds: 3600 },
  worker: {
    launcher: ['claude', '--cloud'],
    protocolPath: '.politburo/packages/worker/WORKER_RELAY_PROTOCOL.md',
    piModel: 'fallback/codex-cursor',
    maxSeconds: 2400,
    idleSeconds: 180,
    progressMode: 'summary',
    checks: [],
  },
  github: { apiUrl: 'https://api.github.com' },
  ledger: { file: '/ledger/ledger.sqlite', party: 'default' },
  operations: { port: 4780, relayStatisticsSeconds: 5 },
}

export class OrchestratorConfigError extends Error {}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [camel(k), camelKeys(v)]))
}

/** Merges `layer` over `base`; unknown keys are an error, so a typo never passes silently. */
function merge(base: unknown, layer: unknown, path: string): unknown {
  if (layer === undefined) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    if (base !== null && typeof base !== typeof layer) throw new OrchestratorConfigError(`${path}: ${typeof base} expected`)
    if (Array.isArray(base) && !Array.isArray(layer)) throw new OrchestratorConfigError(`${path}: list expected`)
    return layer
  }
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) throw new OrchestratorConfigError(`${path}: section expected`)
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(layer)) {
    if (!(key in out)) throw new OrchestratorConfigError(`${path}.${key}: unknown setting`)
    out[key] = merge(out[key], value, `${path}.${key}`)
  }
  return out
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function validateConfig(config: OrchestratorConfig): OrchestratorConfig {
  const fail = (message: string): never => { throw new OrchestratorConfigError(message) }
  let relay: URL | null = null
  try { relay = new URL(config.relay.url) } catch { fail('RELAY_URL: URL expected') }
  // Plain http only for a relay on this machine; from a container, the host is host.docker.internal.
  if (relay!.protocol !== 'https:' && !['127.0.0.1', 'localhost', 'host.docker.internal'].includes(relay!.hostname)) fail('RELAY_URL: https expected')
  for (const name of [...config.repositories.allow, ...config.repositories.deny]) if (!REPOSITORY.test(name)) fail(`repositories: ${name} is not owner/name`)
  const positive: Array<[string, number]> = [
    ['sweep_seconds', config.sweepSeconds], ['board.lease_seconds', config.board.leaseSeconds],
    ['admission.live_attempts', config.admission.liveAttempts], ['admission.per_channel', config.admission.perChannel],
    ['admission.per_repository', config.admission.perRepository], ['limits.rounds_per_attempt', config.limits.roundsPerAttempt],
    ['limits.attempts_per_task', config.limits.attemptsPerTask], ['limits.attempt_wall_minutes', config.limits.attemptWallMinutes],
    ['tokens.worker_ttl_seconds', config.tokens.workerTtlSeconds], ['tokens.orchestrator_ttl_seconds', config.tokens.orchestratorTtlSeconds],
    ['watchdog.heartbeat_seconds', config.watchdog.heartbeatSeconds], ['watchdog.contact_timeout_seconds', config.watchdog.contactTimeoutSeconds],
    ['watchdog.missed_heartbeats', config.watchdog.missedHeartbeats], ['watchdog.stop_grace_seconds', config.watchdog.stopGraceSeconds],
    ['watchdog.question_wait_seconds', config.watchdog.questionWaitSeconds],
    ['worker.max_seconds', config.worker.maxSeconds], ['worker.idle_seconds', config.worker.idleSeconds],
  ]
  for (const [name, value] of positive) if (!Number.isInteger(value) || value <= 0) fail(`${name}: positive integer expected`)
  if (config.board.leaseSeconds < 30 || config.board.leaseSeconds > 3600) fail('board.lease_seconds: 30 to 3600')
  if (config.tokens.workerTtlSeconds < 120) fail('tokens.worker_ttl_seconds: 120 or more')
  if (!(config.limits.taskBudgetUsd >= 0)) fail('limits.task_budget_usd: number >= 0 expected')
  if (config.worker.launcher.length === 0 || config.worker.launcher.some((part) => typeof part !== 'string' || part === '')) fail('worker.launcher: command expected')
  if (!Number.isInteger(config.operations.port) || config.operations.port < 0 || config.operations.port > 65535) fail('operations.port: 0 to 65535')
  if (!Number.isInteger(config.operations.relayStatisticsSeconds) || config.operations.relayStatisticsSeconds < 2) fail('operations.relay_statistics_seconds: integer of 2 or more')
  if (!config.ledger.file.startsWith('/')) fail('ledger.file: absolute path expected')
  if (!/^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(config.ledger.party)) fail('ledger.party: short code expected')
  if (config.worker.progressMode !== 'summary' && config.worker.progressMode !== 'events') fail('worker.progress_mode: summary or events')
  for (const check of config.worker.checks) {
    if (typeof check.name !== 'string' || typeof check.command !== 'string' || !Number.isInteger(check.timeoutSeconds)) fail('worker.checks: name, command and timeout_seconds expected')
  }
  return config
}

/** The relay address comes from the environment (`RELAY_URL`), never from the file. */
export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const raw = text.trim() === '' ? {} : camelKeys(parseYaml(text)) as { relay?: { url?: unknown } }
  if (raw.relay?.url !== undefined) throw new OrchestratorConfigError('orchestrator.relay.url: unknown setting; set RELAY_URL')
  const config = merge(DEFAULT_CONFIG, raw, 'orchestrator') as OrchestratorConfig
  config.relay = { ...config.relay, url: env.RELAY_URL?.trim() ?? '' }
  return validateConfig(config)
}

export function loadOrchestratorConfig(file: string, env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  return parseConfig(readFileSync(file, 'utf8'), env)
}

/** Whether the orchestrator may push to and open PRs in `repository` (`owner/name`). The deny list wins. */
export function repositoryAllowed(config: OrchestratorConfig, repository: string): boolean {
  const name = repository.toLowerCase()
  if (config.repositories.deny.some((entry) => entry.toLowerCase() === name)) return false
  return config.repositories.allow.some((entry) => entry.toLowerCase() === name)
}
