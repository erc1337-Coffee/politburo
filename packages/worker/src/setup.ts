// Prepares the session for Pi: installs the pinned Pi release and provider packages when the
// session lacks them (the cloud environment's setup script normally installs them), the model
// catalog, the provider credentials from the environment, and lists the Pi extensions to load.
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PI_VERSION = '1.4.0'
export const PI_PACKAGE = `@earendil-works/pi-coding-agent@${PI_VERSION}`
export const CURSOR_PROVIDER_PACKAGE = 'npm:@ifi/pi-provider-cursor@0.5.1'
/** The `claude-cli` provider: Claude models through `claude --print`, so a Claude subscription pays from its plan limits. */
export const CLAUDE_CLI_PROVIDER_PACKAGE = 'npm:@pi-plugins/claude-cli@0.3.0'

/** The `packages` directory: the repository layout and the uploaded worker layout are the same. */
const packagesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PI_SUPPORT_DIRECTORY = join(packagesDirectory, 'worker', 'pi-support')
export const QUESTION_EXTENSION = join(packagesDirectory, 'worker', 'pi-extension', 'ask_orchestrator.ts')
export const ROUTER_EXTENSION = join(PI_SUPPORT_DIRECTORY, 'codex-cursor-fallback.ts')

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

export interface PiSetup { piCommand: string; extensions: string[]; installed: string[] }

/** The package sources in Pi's personal settings, `~/.pi/agent/settings.json`. */
export function configuredPackages(settingsFile = join(homedir(), '.pi', 'agent', 'settings.json')): string[] {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { packages?: unknown }
    if (!Array.isArray(settings.packages)) return []
    return settings.packages.map((entry) => (typeof entry === 'string' ? entry : (entry as { source?: unknown })?.source)).filter((source): source is string => typeof source === 'string')
  } catch {
    return []
  }
}

async function piVersionMatches(piCommand: string): Promise<boolean> {
  const { code, output } = await run(piCommand, ['--version'], 30_000)
  return code === 0 && output.split(/[^0-9.]+/).includes(PI_VERSION)
}

/**
 * Makes `pi` available and returns how to run it, with the packages it had to install. Nothing is
 * installed when the pinned versions are present. The Cursor provider package is installed only
 * when the session holds a Cursor credential (`PI_CURSOR`).
 */
export async function preparePi(log: (line: string) => void): Promise<PiSetup> {
  const installed: string[] = []
  let piCommand = await onPath('pi')
  if (piCommand && !(await piVersionMatches(piCommand))) {
    log(`${piCommand} is not Pi ${PI_VERSION}`)
    piCommand = null
  }
  if (!piCommand) {
    installed.push(PI_PACKAGE)
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
  if (!existsSync(catalog) && existsSync(join(PI_SUPPORT_DIRECTORY, 'models-store.json'))) copyFileSync(join(PI_SUPPORT_DIRECTORY, 'models-store.json'), catalog)
  const authSeed = join(PI_SUPPORT_DIRECTORY, 'pi-auth-ensure')
  if (existsSync(authSeed)) await run('sh', [authSeed], 30_000)
  const configured = configuredPackages()
  const providers = [CLAUDE_CLI_PROVIDER_PACKAGE, ...(process.env.PI_CURSOR ? [CURSOR_PROVIDER_PACKAGE] : [])]
  for (const provider of providers.filter((source) => !configured.includes(source))) {
    installed.push(provider)
    const result = await run(piCommand, ['install', provider])
    if (result.code !== 0) log(`${provider} did not install: ${result.output.slice(-200)}`)
  }
  return { piCommand, extensions: [ROUTER_EXTENSION, QUESTION_EXTENSION].filter((file) => existsSync(file)), installed }
}
