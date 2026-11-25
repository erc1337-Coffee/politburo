// Relay protocol: channel names, directions, roles and the signed token.
// The orchestrator signs tokens with its private key. The relay holds only the
// public key, so it can check a token but can never make one.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'

export const DIRECTIONS = ['commands', 'telemetry'] as const
export type Direction = (typeof DIRECTIONS)[number]

/** `statistics` reads the relay's counters (`GET /stats`) and nothing else. */
export const ROLES = ['orchestrator', 'worker', 'statistics'] as const
export type Role = (typeof ROLES)[number]

/** The channel claim of a statistics token. A channel token of this name cannot read statistics. */
export const STATISTICS_CHANNEL = 'statistics'

/** A channel is one task attempt. Its name is chosen by the orchestrator. */
export const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

/** Commands go from the orchestrator to the worker; telemetry goes back. */
export const SENDER: Readonly<Record<Direction, Role>> = { commands: 'orchestrator', telemetry: 'worker' }
export const RECEIVER: Readonly<Record<Direction, Role>> = { commands: 'worker', telemetry: 'orchestrator' }

/** Counters of one direction of one channel. */
export interface DirectionStatistics { messages: number; bytes: number; last_seq: number; last_at: number | null; streams: number }
/** `GET /stats`: counters only. The relay keeps no request log and returns no message content. */
export interface RelayStatistics {
  started_at: number
  at: number
  channels: Record<string, Record<Direction, DirectionStatistics>>
  /** Refused requests since start, by HTTP status. */
  refused: Record<string, number>
}

export const TOKEN_VERSION = 1

export interface TokenClaims {
  v: typeof TOKEN_VERSION
  channel: string
  role: Role
  /** Issue time, Unix seconds. */
  iat: number
  /** Expiry, Unix seconds. */
  exp: number
}

/** One stored message as a receiver gets it. */
export interface RelayMessage {
  seq: number
  /** Time the relay stored it, Unix milliseconds. */
  at: number
  body: unknown
}

export interface SigningKeys {
  privateKeyPem: string
  publicKeyPem: string
}

export interface TokenRequest {
  channel: string
  role: Role
  ttlSeconds: number
  /** Unix milliseconds; defaults to now. */
  now?: number
}

/** Clock skew accepted on `iat`, in seconds. */
const ISSUE_SKEW_SECONDS = 60

export function isDirection(value: string): value is Direction {
  return (DIRECTIONS as readonly string[]).includes(value)
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

export function generateSigningKeys(): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

export function loadSigningKey(key: KeyObject | string): KeyObject {
  return typeof key === 'string' ? createPrivateKey(key) : key
}

export function loadVerificationKey(key: KeyObject | string): KeyObject {
  return typeof key === 'string' ? createPublicKey(key) : key
}

/** Signs a token for one channel and one role. Only the orchestrator calls this. */
export function signToken(signingKey: KeyObject | string, request: TokenRequest): string {
  if (!CHANNEL_PATTERN.test(request.channel)) throw new RangeError(`invalid channel name: ${request.channel}`)
  if (!isRole(request.role)) throw new RangeError(`invalid role: ${String(request.role)}`)
  if (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds <= 0) throw new RangeError('ttlSeconds must be a positive integer')
  const iat = Math.floor((request.now ?? Date.now()) / 1000)
  const claims: TokenClaims = { v: TOKEN_VERSION, channel: request.channel, role: request.role, iat, exp: iat + request.ttlSeconds }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = sign(null, Buffer.from(payload), loadSigningKey(signingKey)).toString('base64url')
  return `${payload}.${signature}`
}

/** Returns the claims of a valid, unexpired token, or null for anything else. */
export function verifyToken(verificationKey: KeyObject, token: string, now = Date.now()): TokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts as [string, string]
  let valid = false
  try {
    valid = verify(null, Buffer.from(payload), verificationKey, Buffer.from(signature, 'base64url'))
  } catch {
    return null
  }
  if (!valid) return null
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof claims !== 'object' || claims === null) return null
  const c = claims as Record<string, unknown>
  const seconds = Math.floor(now / 1000)
  if (c.v !== TOKEN_VERSION) return null
  if (typeof c.channel !== 'string' || !CHANNEL_PATTERN.test(c.channel)) return null
  if (!isRole(c.role)) return null
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return null
  if ((c.exp as number) <= seconds || (c.iat as number) > seconds + ISSUE_SKEW_SECONDS) return null
  return { v: TOKEN_VERSION, channel: c.channel, role: c.role, iat: c.iat as number, exp: c.exp as number }
}
