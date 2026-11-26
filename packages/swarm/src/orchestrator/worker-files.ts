// The worker client files that each worker session receives in `.politburo/`, with the same
// layout as `packages/`, so the client's relative imports resolve in the session.
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKER_DIRECTORY = '.politburo'

/** The `packages` directory of this source tree. */
export const PACKAGES_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export function workerFiles(packagesDirectory = PACKAGES_DIRECTORY): Array<{ path: string; source: string }> {
  const relative = [
    'relay/src/messages.ts',
    'relay/src/sealed.ts',
    ...readdirSync(join(packagesDirectory, 'worker', 'src')).filter((name) => name.endsWith('.ts')).map((name) => `worker/src/${name}`),
    'worker/pi-extension/ask_orchestrator.ts',
    'worker/WORKER_RELAY_PROTOCOL.md',
    'swarm/sprite/codex-cursor-fallback.ts',
    'swarm/sprite/models-store.json',
    'swarm/sprite/pi-auth-ensure',
  ]
  return relative.map((path) => ({ path: `${WORKER_DIRECTORY}/packages/${path}`, source: join(packagesDirectory, path) }))
}
