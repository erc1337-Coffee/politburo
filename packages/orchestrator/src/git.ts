// Applies worker git bundles to bare mirrors and pushes the task branch, or merges them into the
// local repository of a channel that links no repository.
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class GitError extends Error {}

export interface GitOptions {
  /** Directory for the bare mirrors, one per repository. */
  directory: string
  /** Base of clone URLs: `https://github.com` in production, a local path in tests. */
  urlBase: string
  /** Token for HTTPS remotes. It goes to git through the environment, never through arguments. */
  token: string | null
  /** Directory for the local repositories of channels that link no repository, one per channel. */
  localDirectory?: string
}

/** The repository name of a channel's local repository. */
export const localRepository = (channel: string) => `local:${channel}`
export const isLocalRepository = (repository: string) => repository.startsWith('local:')
/** The branch of a local repository that each task starts from and merges into. */
export const LOCAL_BRANCH = 'main'
const IDENTITY = ['-c', 'user.name=politburo-orchestrator', '-c', 'user.email=politburo-orchestrator@localhost', '-c', 'commit.gpgsign=false']

const SHA = /^[0-9a-f]{40}$/

export class GitRepositories {
  readonly #options: GitOptions

  constructor(options: GitOptions) {
    this.#options = options
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    if (options.localDirectory) mkdirSync(options.localDirectory, { recursive: true, mode: 0o700 })
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

  /** The local repository of a channel; a new one starts with one empty commit on `main`. */
  async #local(repository: string): Promise<string> {
    if (!this.#options.localDirectory) throw new GitError('local repositories are not configured')
    const path = join(this.#options.localDirectory, `${repository.slice('local:'.length).replace(/[^A-Za-z0-9._-]/g, '_')}.git`)
    if (existsSync(join(path, 'HEAD'))) return path
    await this.#git(['init', '--quiet', '--bare', `--initial-branch=${LOCAL_BRANCH}`, path])
    const tree = await this.#git(['hash-object', '-t', 'tree', '-w', '/dev/null'], path)
    const root = await this.#git([...IDENTITY, 'commit-tree', tree, '-m', 'Channel repository'], path)
    await this.#git(['update-ref', `refs/heads/${LOCAL_BRANCH}`, root, ''], path)
    return path
  }

  /** The commit `main` of a channel's local repository points at; creates the repository when it is new. */
  async localHead(repository: string): Promise<string> {
    return this.#git(['rev-parse', `refs/heads/${LOCAL_BRANCH}`], await this.#local(repository))
  }

  /** The bare repository a launch starts from: the channel's local one, or the GitHub mirror. */
  #source(repository: string): Promise<string> {
    return isLocalRepository(repository) ? this.#local(repository) : this.#mirror(repository)
  }

  /**
   * Where a follow-up attempt of a local channel task starts: the task branch when `main` does not
   * contain it (the work was kept, not merged), otherwise `main`.
   */
  async localFollowupBase(repository: string, branch: string): Promise<string> {
    const path = await this.#local(repository)
    const main = await this.#git(['rev-parse', `refs/heads/${LOCAL_BRANCH}`], path)
    const head = await this.#git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], path).catch(() => '')
    if (!head) return main
    const merged = await this.#git(['merge-base', '--is-ancestor', head, main], path).then(() => true, () => false)
    return merged ? main : head
  }

  /** Fetches a verified worker bundle into `repository` as `staging`, and checks that it holds `head` on top of `base`. */
  async #receive(path: string, staging: string, input: { bundleFile: string; branch: string; head: string; base: string }): Promise<void> {
    if (!SHA.test(input.head) || !SHA.test(input.base)) throw new GitError('head and base must be full commit ids')
    await this.#git(['bundle', 'verify', '--quiet', input.bundleFile], path)
    await this.#git(['fetch', '--quiet', '--no-tags', input.bundleFile, `+refs/heads/${input.branch}:${staging}`], path)
    const fetched = await this.#git(['rev-parse', staging], path)
    if (fetched !== input.head) throw new GitError(`the bundle holds ${fetched}, the worker reported ${input.head}`)
    await this.#git(['merge-base', '--is-ancestor', input.base, input.head], path).catch(() => {
      throw new GitError(`${input.head} does not descend from the base ${input.base}`)
    })
  }

  /**
   * Merges a worker bundle into `main` of a channel's local repository and keeps the task branch.
   * `main` moves forward when the task started from it; when other work landed first, a merge commit
   * joins them, and a conflict leaves `main` as it is. Returns the new `main`.
   */
  async mergeBundle(repository: string, input: { bundleFile: string; branch: string; head: string; base: string; message: string }): Promise<string> {
    const path = await this.#local(repository)
    await this.#receive(path, `refs/heads/${input.branch}`, input)
    const main = await this.#git(['rev-parse', `refs/heads/${LOCAL_BRANCH}`], path)
    const forward = await this.#git(['merge-base', '--is-ancestor', main, input.head], path).then(() => true, () => false)
    let next = input.head
    if (!forward) {
      const tree = await this.#git(['merge-tree', '--write-tree', main, input.head], path).catch(() => {
        throw new GitError(`the work conflicts with ${LOCAL_BRANCH}; it stays on branch ${input.branch}`)
      })
      next = await this.#git([...IDENTITY, 'commit-tree', tree.split('\n')[0]!, '-p', main, '-p', input.head, '-m', input.message], path)
    }
    await this.#git(['update-ref', `refs/heads/${LOCAL_BRANCH}`, next, main], path)
    return next
  }

  /** Keeps a worker bundle as its task branch in a channel's local repository, without touching `main`. */
  async keepBundle(repository: string, input: { bundleFile: string; branch: string; head: string; base: string }): Promise<void> {
    await this.#receive(await this.#local(repository), `refs/heads/${input.branch}`, input)
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
   * The deployable code of a repository: `main`, else `master`, as a tar of the tree at `subpath`.
   * A GitHub repository is fetched up to date first.
   */
  async deploymentArchive(repository: string, subpath: string): Promise<{ branch: string; commit: string; tar: Buffer }> {
    const path = await this.#source(repository)
    let branch = ''
    let commit = ''
    for (const candidate of ['main', 'master']) {
      commit = await this.#git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}^{commit}`], path).catch(() => '')
      if (commit) { branch = candidate; break }
    }
    if (!commit) throw new GitError(`${repository} has no main or master branch`)
    const directory = subpath.replace(/^\/+|\/+$/g, '')
    if (directory.split('/').includes('..')) throw new GitError('the subpath leaves the repository')
    const tree = directory ? `${commit}:${directory}` : commit
    const tar = await new Promise<Buffer>((resolve, reject) => {
      execFile('git', ['archive', '--format=tar', tree], { cwd: path, env: this.#env(), timeout: 5 * 60_000, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
        if (error) reject(new GitError(`git archive failed: ${String(stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`))
        else resolve(stdout)
      })
    })
    return { branch, commit, tar }
  }

  /**
   * Applies a worker bundle and pushes it as `branch`. The bundle must hold `branch` at `head`,
   * and `base` must be an ancestor of `head`. The push never forces.
   */
  async publishBundle(repository: string, input: { bundleFile: string; branch: string; head: string; base: string }): Promise<void> {
    const mirror = await this.#mirror(repository)
    await this.#receive(mirror, `refs/orchestrator/${input.branch}`, input)
    await this.#git(['push', '--quiet', 'origin', `${input.head}:refs/heads/${input.branch}`], mirror)
  }

  /**
   * Creates the directory a worker session starts from: a clone of the repository at `baseCommit`
   * without a remote, plus `files` committed on a local launch branch. The session receives it as
   * an upload, so it needs no GitHub access.
   */
  async prepareLaunchDirectory(repository: string, baseCommit: string, directory: string, files: Array<{ path: string; source: string }>): Promise<void> {
    if (!SHA.test(baseCommit)) throw new GitError('the base must be a full commit id')
    const mirror = await this.#source(repository)
    rmSync(directory, { recursive: true, force: true })
    await this.#git(['clone', '--quiet', '--no-checkout', mirror, directory])
    await this.#git(['checkout', '--quiet', '-B', 'politburo-launch', baseCommit], directory)
    await this.#git(['remote', 'remove', 'origin'], directory)
    for (const file of files) {
      mkdirSync(dirname(join(directory, file.path)), { recursive: true })
      copyFileSync(file.source, join(directory, file.path))
    }
    await this.#git(['add', '--force', '--', ...files.map((file) => file.path)], directory)
    await this.#git([...IDENTITY,
      'commit', '--quiet', '--no-verify', '-m', 'Politburo worker client'], directory)
  }
}
