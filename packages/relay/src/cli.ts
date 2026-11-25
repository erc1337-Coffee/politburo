#!/usr/bin/env node
// politburo-relay keygen | token | serve
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { generateSigningKeys, isRole, signToken } from './protocol.ts'
import { createRelay } from './server.ts'
import { MessageStore } from './store.ts'

const SIGNING_KEY_FILE = 'relay_signing_key.pem'
const VERIFICATION_KEY_FILE = 'relay_verification_key.pem'

const usage = `usage:
  politburo-relay keygen --directory <dir>
      Writes ${SIGNING_KEY_FILE} (orchestrator only, mode 600) and ${VERIFICATION_KEY_FILE} (relay).
  politburo-relay token --signing-key <file> --channel <name> --role <orchestrator|worker> --ttl <seconds>
      Prints a token. The orchestrator does this; never on the relay host.
  politburo-relay serve [--verification-key <file>] --database <file> [--host 127.0.0.1] [--port 8790]
      Runs the relay over plain HTTP. Put it behind a TLS-terminating proxy.
      Without --verification-key, reads the PEM from RELAY_VERIFICATION_KEY. Without --port, uses PORT.`

function fail(message: string): never {
  process.stderr.write(`politburo-relay: ${message}\n${usage}\n`)
  process.exit(2)
}

const [command, ...rest] = process.argv.slice(2)

if (command === 'keygen') {
  const { values } = parseArgs({ args: rest, options: { directory: { type: 'string' } } })
  if (!values.directory) fail('--directory is required')
  const signingPath = join(values.directory, SIGNING_KEY_FILE)
  const verificationPath = join(values.directory, VERIFICATION_KEY_FILE)
  if (existsSync(signingPath) || existsSync(verificationPath)) fail('key files already exist; refusing to overwrite')
  mkdirSync(values.directory, { recursive: true, mode: 0o700 })
  const keys = generateSigningKeys()
  writeFileSync(signingPath, keys.privateKeyPem, { mode: 0o600, flag: 'wx' })
  writeFileSync(verificationPath, keys.publicKeyPem, { mode: 0o644, flag: 'wx' })
  process.stdout.write(`${signingPath}\n${verificationPath}\n`)
} else if (command === 'token') {
  const { values } = parseArgs({
    args: rest,
    options: { 'signing-key': { type: 'string' }, channel: { type: 'string' }, role: { type: 'string' }, ttl: { type: 'string' } },
  })
  if (!values['signing-key'] || !values.channel || !values.role || !values.ttl) fail('--signing-key, --channel, --role and --ttl are required')
  if (!isRole(values.role)) fail('--role must be orchestrator or worker')
  const token = signToken(readFileSync(values['signing-key'], 'utf8'), {
    channel: values.channel,
    role: values.role,
    ttlSeconds: Number(values.ttl),
  })
  process.stdout.write(`${token}\n`)
} else if (command === 'serve') {
  const { values } = parseArgs({
    args: rest,
    options: {
      'verification-key': { type: 'string' },
      database: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string' },
    },
  })
  const verificationKey = values['verification-key'] ? readFileSync(values['verification-key'], 'utf8') : process.env.RELAY_VERIFICATION_KEY
  if (!verificationKey) fail('--verification-key or RELAY_VERIFICATION_KEY is required')
  if (!values.database) fail('--database is required')
  const port = Number(values.port ?? process.env.PORT ?? '8790')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('--port or PORT must be a port number')
  const store = new MessageStore(values.database)
  const relay = createRelay({ verificationKey, store })
  relay.server.listen(port, values.host, () => {
    process.stderr.write(`politburo-relay: listening on http://${values.host}:${port}\n`)
  })
  const stop = (): void => {
    void relay.close().then(() => {
      store.close()
      process.exit(0)
    })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} else {
  fail(command ? `unknown command: ${command}` : 'a command is required')
}
