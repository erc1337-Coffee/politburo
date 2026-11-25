// Applies worker git bundles to bare mirrors and pushes the task branch.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export class GitError extends Error {}

export interface GitOptions {
  /** Directory for the bare mirrors, one per repository. */
  directory: string
  /** Base of clone URLs: `https://github.com` in production, a local path in tests. */
  urlBase: string
  /** Token for HTTPS remotes. It goes to git through the environment, never through arguments. */
  token: string | null
}

const SHA = /^[0-9a-f]{40}$/

export class GitRepositories {
  readonly #options: GitOptions

  constructor(options: GitOptions) {
    this.#options = options
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  }

  #env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
    if (this.#options.token && this.#options.urlBase.startsWith('https://')) {
      const basic = Buffer.from(`x-access-token:${this.#options.token}`).toString('base64')
      Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${this.#options.urlBase}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` })
    }
    return env
  }

  #git(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, env: this.#env(), timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new GitError(`git ${args[0]} failed: ${String(stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`))
        else resolve(String(stdout).trim())
      })
    })
  }

  /** The bare mirror of `repository` (`owner/name`), fetched up to date. */
  async #mirror(repository: string): Promise<string> {
    const path = join(this.#options.directory, `${repository.replace('/', '__')}.git`)
    const url = `${this.#options.urlBase}/${repository}.git`
    if (!existsSync(path)) await this.#git(['clone', '--bare', '--quiet', url, path])
    else await this.#git(['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], path)
    return path
  }

  /**
   * Applies a worker bundle and pushes it as `branch`. The bundle must hold `branch` at `head`,
   * and `base` must be an ancestor of `head`. The push never forces.
   */
  async publishBundle(repository: string, input: { bundleFile: string; branch: string; head: string; base: string }): Promise<void> {
    if (!SHA.test(input.head) || !SHA.test(input.base)) throw new GitError('head and base must be full commit ids')
    const mirror = await this.#mirror(repository)
    await this.#git(['bundle', 'verify', '--quiet', input.bundleFile], mirror)
    const staging = `refs/orchestrator/${input.branch}`
    await this.#git(['fetch', '--quiet', '--no-tags', input.bundleFile, `+refs/heads/${input.branch}:${staging}`], mirror)
    const fetched = await this.#git(['rev-parse', staging], mirror)
    if (fetched !== input.head) throw new GitError(`the bundle holds ${fetched}, the worker reported ${input.head}`)
    await this.#git(['merge-base', '--is-ancestor', input.base, input.head], mirror).catch(() => {
      throw new GitError(`${input.head} does not descend from the base ${input.base}`)
    })
    await this.#git(['push', '--quiet', 'origin', `${input.head}:refs/heads/${input.branch}`], mirror)
  }
}
