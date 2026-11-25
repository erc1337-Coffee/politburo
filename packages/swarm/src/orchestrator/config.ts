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
  channels: { include: string[] }
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
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  stateDirectory: '/orchestrator',
  boardProfile: 'orchestrator',
  partyFile: null,
  sweepSeconds: 30,
  relay: { url: '', signingKeyFile: '/orchestrator/keys/relay_signing_key.pem' },
  board: { leaseSeconds: 900 },
  channels: { include: [] },
  repositories: { allow: [], deny: ['remiliacorporation/politburo', 'vercel/board'] },
  admission: { liveAttempts: 2, perChannel: 1, perRepository: 1 },
  limits: { roundsPerAttempt: 3, attemptsPerTask: 2, attemptWallMinutes: 120, taskBudgetUsd: 10 },
  tokens: { workerTtlSeconds: 3600, orchestratorTtlSeconds: 900 },
  watchdog: { heartbeatSeconds: 60, contactTimeoutSeconds: 900, missedHeartbeats: 5, stopGraceSeconds: 300, questionWaitSeconds: 3600 },
  worker: {
    launcher: ['claude', '--cloud'],
    protocolPath: 'WORKER_RELAY_PROTOCOL.md',
    piModel: 'fallback/codex-cursor',
    maxSeconds: 2400,
    idleSeconds: 180,
    progressMode: 'summary',
    checks: [],
  },
  github: { apiUrl: 'https://api.github.com' },
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
  try { relay = new URL(config.relay.url) } catch { fail('relay.url: URL expected') }
  if (relay!.protocol !== 'https:' && relay!.hostname !== '127.0.0.1' && relay!.hostname !== 'localhost') fail('relay.url: https expected')
  for (const name of [...config.repositories.allow, ...config.repositories.deny]) if (!REPOSITORY.test(name)) fail(`repositories: ${name} is not owner/name`)
  for (const path of config.channels.include) if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\/?$/.test(path)) fail(`channels.include: invalid channel ${path}`)
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
  if (config.worker.progressMode !== 'summary' && config.worker.progressMode !== 'events') fail('worker.progress_mode: summary or events')
  for (const check of config.worker.checks) {
    if (typeof check.name !== 'string' || typeof check.command !== 'string' || !Number.isInteger(check.timeoutSeconds)) fail('worker.checks: name, command and timeout_seconds expected')
  }
  return config
}

export function parseConfig(text: string): OrchestratorConfig {
  const raw = text.trim() === '' ? {} : camelKeys(parseYaml(text))
  return validateConfig(merge(DEFAULT_CONFIG, raw, 'orchestrator') as OrchestratorConfig)
}

export function loadOrchestratorConfig(file: string): OrchestratorConfig {
  return parseConfig(readFileSync(file, 'utf8'))
}

/** Whether `channel` is one the orchestrator takes tasks from. */
export function channelIncluded(config: OrchestratorConfig, channel: string): boolean {
  return config.channels.include.some((entry) => entry.endsWith('/') ? channel.startsWith(entry) || channel === entry.slice(0, -1) : channel === entry)
}

/** Whether the orchestrator may push to and open PRs in `repository` (`owner/name`). The deny list wins. */
export function repositoryAllowed(config: OrchestratorConfig, repository: string): boolean {
  const name = repository.toLowerCase()
  if (config.repositories.deny.some((entry) => entry.toLowerCase() === name)) return false
  return config.repositories.allow.some((entry) => entry.toLowerCase() === name)
}
