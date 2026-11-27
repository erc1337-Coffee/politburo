// Git work of the worker: a task worktree outside the uploaded checkout, commits on the
// task branch and a bundle of base..branch. The worker never pushes and holds no credential.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export interface DiffStat { files: number; insertions: number; deletions: number }

const IDENTITY = ['-c', 'user.name=politburo-worker', '-c', 'user.email=politburo-worker@localhost', '-c', 'commit.gpgsign=false']

export function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...IDENTITY, ...args], {
      cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]}: ${String(stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300) || error.message}`))
      else resolve(String(stdout).trim())
    })
  })
}

/**
 * Creates (or reuses) the worktree of the task branch at `directory`, starting at `baseCommit`.
 * In a session that worked on the task before, the earlier attempt's worktree of the branch is
 * removed first: its work is committed and the base contains it. Push is disabled on every remote
 * of the checkout.
 */
export async function prepareWorktree(checkout: string, directory: string, branch: string, baseCommit: string): Promise<void> {
  await git(checkout, ['cat-file', '-e', `${baseCommit}^{commit}`]).catch(() => {
    throw new Error(`the uploaded checkout does not contain the base commit ${baseCommit}`)
  })
  if (!existsSync(directory)) {
    for (const other of worktreesOf(await git(checkout, ['worktree', 'list', '--porcelain']), branch)) {
      await git(checkout, ['worktree', 'remove', '--force', other])
    }
    await git(checkout, ['worktree', 'add', '--quiet', '-B', branch, directory, baseCommit])
  }
  for (const remote of (await git(checkout, ['remote'])).split('\n').filter(Boolean)) {
    await git(checkout, ['config', `remote.${remote}.pushurl`, 'push-disabled-by-politburo-worker'])
  }
}

/** The paths of the worktrees that have `branch` checked out, from `git worktree list --porcelain`. */
export function worktreesOf(listing: string, branch: string): string[] {
  return listing.split('\n\n').flatMap((entry) => {
    const lines = entry.split('\n')
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
    return path && lines.includes(`branch refs/heads/${branch}`) ? [path] : []
  })
}

export async function head(directory: string): Promise<string> {
  return git(directory, ['rev-parse', 'HEAD'])
}

/** Commits every change in the worktree; false when there is nothing to commit. */
export async function commitAll(directory: string, message: string): Promise<boolean> {
  await git(directory, ['add', '--all'])
  if ((await git(directory, ['status', '--porcelain'])) === '') return false
  await git(directory, ['commit', '--quiet', '--no-verify', '-m', message])
  return true
}

export async function diffStat(directory: string, baseCommit: string): Promise<DiffStat> {
  const text = await git(directory, ['diff', '--shortstat', baseCommit, 'HEAD'])
  const number = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0)
  return { files: number(/(\d+) files? changed/), insertions: number(/(\d+) insertions?/), deletions: number(/(\d+) deletions?/) }
}

/** Short fingerprint of the working tree, to detect file changes during a round. */
export async function treeFingerprint(directory: string): Promise<string> {
  const status = await git(directory, ['status', '--porcelain']).catch(() => '')
  const diff = await git(directory, ['diff']).catch(() => '')
  return createHash('sha256').update(status).update(diff).digest('hex')
}

/** Writes the bundle of `branch` without the history of `baseCommit`; null when the branch has no new commit. */
export async function createBundle(directory: string, branch: string, baseCommit: string, file: string): Promise<{ bytes: Buffer; sha256: string } | null> {
  if ((await head(directory)) === baseCommit) return null
  await git(directory, ['bundle', 'create', '--quiet', file, branch, `^${baseCommit}`])
  const bytes = readFileSync(file)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}
