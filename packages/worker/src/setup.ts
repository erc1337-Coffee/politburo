// Prepares the session for Pi: installs the pinned Pi release when it is missing, the model
// catalog, the provider credentials from the environment, and lists the Pi extensions to load.
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PI_PACKAGE = '@earendil-works/pi-coding-agent@1.4.0'
export const CURSOR_PROVIDER_PACKAGE = 'npm:@ifi/pi-provider-cursor@0.5.1'

/** The `packages` directory: the repository layout and the uploaded worker layout are the same. */
const packagesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SPRITE_DIRECTORY = join(packagesDirectory, 'swarm', 'sprite')
export const QUESTION_EXTENSION = join(packagesDirectory, 'worker', 'pi-extension', 'ask_orchestrator.ts')
export const ROUTER_EXTENSION = join(SPRITE_DIRECTORY, 'codex-cursor-fallback.ts')

function run(command: string, args: string[], timeoutMs = 10 * 60_000): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolvePromise({ code, output: `${stdout}\n${stderr}`.trim() })
    })
  })
}

async function onPath(command: string): Promise<string | null> {
  const { code, output } = await run('bash', ['-lc', `command -v ${command}`], 10_000)
  return code === 0 && output ? output.split('\n')[0]!.trim() : null
}

export interface PiSetup { piCommand: string; extensions: string[] }

/**
 * Makes `pi` available and returns how to run it. The Cursor provider package is installed only
 * when the session holds a Cursor credential (`PI_CURSOR`).
 */
export async function preparePi(log: (line: string) => void): Promise<PiSetup> {
  let piCommand = await onPath('pi')
  if (!piCommand) {
    log(`installing ${PI_PACKAGE}`)
    const global = await run('npm', ['install', '--global', '--ignore-scripts', PI_PACKAGE])
    piCommand = global.code === 0 ? await onPath('pi') : null
    if (!piCommand) {
      const prefix = join(homedir(), '.politburo_worker', 'npm')
      const local = await run('npm', ['install', '--global', '--ignore-scripts', '--prefix', prefix, PI_PACKAGE])
      if (local.code !== 0) throw new Error(`cannot install ${PI_PACKAGE}: ${local.output.slice(-400)}`)
      piCommand = join(prefix, 'bin', 'pi')
    }
  }
  const agent = join(homedir(), '.pi', 'agent')
  mkdirSync(agent, { recursive: true })
  const catalog = join(agent, 'models-store.json')
  if (!existsSync(catalog) && existsSync(join(SPRITE_DIRECTORY, 'models-store.json'))) copyFileSync(join(SPRITE_DIRECTORY, 'models-store.json'), catalog)
  const authSeed = join(SPRITE_DIRECTORY, 'pi-auth-ensure')
  if (existsSync(authSeed)) await run('sh', [authSeed], 30_000)
  if (process.env.PI_CURSOR) {
    const installed = await run(piCommand, ['install', CURSOR_PROVIDER_PACKAGE])
    if (installed.code !== 0) log(`the Cursor provider did not install: ${installed.output.slice(-200)}`)
  }
  return { piCommand, extensions: [ROUTER_EXTENSION, QUESTION_EXTENSION].filter((file) => existsSync(file)) }
}
