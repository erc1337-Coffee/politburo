#!/usr/bin/env node
// politburo-worker run | status
//
//   run    --relay-url URL --channel NAME [--contact-timeout-seconds 900]
//          Reads the bootstrap token from standard input, then works the task until it ends.
//   status --channel NAME [--wait SECONDS]
//          Prints new status lines. Exit 10 while the worker runs, otherwise the worker's exit code.
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { CHANNEL } from './names.ts'
import { preparePi } from './setup.ts'
import { WorkerFiles } from './state.ts'
import { EXIT, Worker } from './worker.ts'

const usage = `usage:
  politburo-worker run --relay-url URL --channel NAME [--contact-timeout-seconds 900]   (token on standard input)
  politburo-worker status --channel NAME [--wait SECONDS]`

function fail(message: string): never {
  process.stderr.write(`politburo-worker: ${message}\n${usage}\n`)
  process.exit(EXIT.usage)
}

function readStandardInput(): string {
  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(4096)
  for (;;) {
    let read = 0
    try { read = readSync(0, buffer, 0, buffer.length, null) } catch { break }
    if (read === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, read)))
  }
  return Buffer.concat(chunks).toString('utf8').trim().split(/\s+/)[0] ?? ''
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { 'relay-url': { type: 'string' }, channel: { type: 'string' }, 'contact-timeout-seconds': { type: 'string' } } })
  const relayUrl = values['relay-url']
  const channel = values.channel
  if (!relayUrl || !/^https?:\/\//.test(relayUrl)) fail('--relay-url must be an http(s) URL')
  if (!channel || !CHANNEL.test(channel)) fail('--channel is missing or invalid')
  const token = readStandardInput()
  if (!token.includes('.')) fail('no token on standard input')
  const files = new WorkerFiles(channel)
  writeFileSync(files.path('pid'), String(process.pid))
  const log = (line: string) => process.stderr.write(`politburo-worker: ${line}\n`)
  const worker = new Worker({
    relayUrl, channel, files, checkout: process.cwd(),
    contactTimeoutSeconds: Number(values['contact-timeout-seconds'] ?? 900),
    prepare: preparePi, log,
  }, token)
  try {
    return await worker.run()
  } catch (error) {
    files.status(`internal error: ${(error as Error).message}`)
    files.writeJson('exit.json', { code: EXIT.internal, at: Date.now() })
    return EXIT.internal
  }
}

async function status(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { channel: { type: 'string' }, wait: { type: 'string' } } })
  if (!values.channel || !CHANNEL.test(values.channel)) fail('--channel is missing or invalid')
  const files = new WorkerFiles(values.channel)
  const offsetFile = files.path('status.offset')
  let offset = existsSync(offsetFile) ? Number(readFileSync(offsetFile, 'utf8')) || 0 : 0
  const deadline = Date.now() + Number(values.wait ?? 0) * 1000
  const print = () => {
    if (!existsSync(files.path('status.log'))) return
    const descriptor = openSync(files.path('status.log'), 'r')
    const buffer = Buffer.alloc(1 << 16)
    let read: number
    while ((read = readSync(descriptor, buffer, 0, buffer.length, offset)) > 0) {
      process.stdout.write(buffer.subarray(0, read))
      offset += read
    }
    closeSync(descriptor)
    writeFileSync(offsetFile, String(offset))
  }
  for (;;) {
    print()
    const exit = files.readJson<{ code: number }>('exit.json')
    if (exit) return exit.code
    const pid = Number(existsSync(files.path('pid')) ? readFileSync(files.path('pid'), 'utf8') : 0)
    if (!pid || !alive(pid)) {
      process.stdout.write('politburo-worker is not running and left no exit code\n')
      return EXIT.internal
    }
    if (Date.now() >= deadline) return 10
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

const [command, ...rest] = process.argv.slice(2)
const code = command === 'run' ? await run(rest) : command === 'status' ? await status(rest) : fail('unknown command')
process.exit(code)
