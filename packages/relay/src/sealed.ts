// Environment variables sealed for one worker: X25519 key agreement, HKDF-SHA256 and AES-256-GCM.
// The worker keeps its private key in memory and sends only the public key, so the relay
// stores ciphertext that only that worker process can open.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'

export interface SealedData { ephemeral_public_key: string; nonce: string; ciphertext: string }

const info = (channel: string) => Buffer.from(`politburo worker environment v1 ${channel}`)

function publicKeyFrom(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' })
}

function key(privateKey: KeyObject, publicKey: KeyObject, channel: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey })
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info(channel), 32))
}

/** A key pair for one worker process; `publicKey` is the raw key, base64url. */
export function workerKeyPair(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x! }
}

export function seal(workerPublicKey: string, environment: Record<string, string>, channel: string): SealedData {
  const ephemeral = generateKeyPairSync('x25519')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(ephemeral.privateKey, publicKeyFrom(workerPublicKey), channel), nonce)
  cipher.setAAD(info(channel))
  const body = Buffer.concat([cipher.update(JSON.stringify(environment), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { ephemeral_public_key: ephemeral.publicKey.export({ format: 'jwk' }).x!, nonce: nonce.toString('base64url'), ciphertext: body.toString('base64url') }
}

/** Opens sealed data; throws when it was sealed for another key or channel, or changed on the way. */
export function open(privateKey: KeyObject, data: SealedData, channel: string): Record<string, string> {
  const body = Buffer.from(data.ciphertext, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key(privateKey, publicKeyFrom(data.ephemeral_public_key), channel), Buffer.from(data.nonce, 'base64url'))
  decipher.setAAD(info(channel))
  decipher.setAuthTag(body.subarray(body.length - 16))
  const text = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8')
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) {
    throw new Error('sealed environment: object of strings expected')
  }
  return parsed as Record<string, string>
}
