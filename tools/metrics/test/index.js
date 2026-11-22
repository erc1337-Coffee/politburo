import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const forkScript = fileURLToPath(new URL('../fork-thinness.sh', import.meta.url))
const claimScript = fileURLToPath(new URL('../time-to-first-claim.mjs', import.meta.url))
const src = 'packages/board/src/'
const unit = 'lines added in packages/board/src vs merge base with upstream/main'

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'metrics-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  return result
}

function fixture(t) {
  const root = temp(t)
  const upstream = join(root, 'upstream with spaces')
  const fork = join(root, 'fork')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, {
    HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Metrics test', GIT_AUTHOR_EMAIL: 'metrics@example.test',
    GIT_COMMITTER_NAME: 'Metrics test', GIT_COMMITTER_EMAIL: 'metrics@example.test',
    GIT_ALLOW_PROTOCOL: 'file',
  })
  function git(repo, ...args) {
    const result = run('git', ['-C', repo, ...args], env)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  function put(repo, path, text) {
    const file = join(repo, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  function commit(repo, message) {
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', message)
    return git(repo, 'rev-parse', 'HEAD')
  }
  git(root, 'init', '-q', '-b', 'main', upstream)
  put(upstream, src + 'cli/main.ts', 'keep\ndelete\n')
  const base = commit(upstream, 'base')
  git(root, 'clone', '-q', upstream, fork)
  put(upstream, 'README.md', 'first\n')
  commit(upstream, 'upstream one')
  put(upstream, src + 'server/tasks.ts', 'upstream-only line\n')
  const tip = commit(upstream, 'upstream two')
  put(fork, src + 'cli/main.ts', 'keep\nadded one\nadded two\n')
  put(fork, src + 'conformance/index.ts', 'hot\n')
  put(fork, src + 'other\tfile.ts', '1\n2\n3\n4\n')
  put(fork, 'packages/board/test/ignored.ts', 'not in src\n')
  const head = commit(fork, 'fork change')
  const metric = (remote = upstream, args = []) => run('bash', [forkScript,
    '--repo', fork, '--upstream-url', remote, ...args], env)
  return { root, upstream, fork, put, commit, git, base, tip, head, metric }
}

function failure(result, reason) {
  assert.equal(result.signal, null)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^error: [^\r\n]+\n$/)
  assert.match(result.stderr, reason)
}

test('fork metric counts additions, not deletions or upstream-only changes', (t) => {
  const { metric, base, tip, head } = fixture(t)
  const result = metric()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    metric: 'fork_thinness', value: 7, unit, lines_added_src: 7, lines_added_hot: 3,
    hot_files: {
      [src + 'conformance/index.ts']: 1,
      [src + 'cli/main.ts']: 2,
      [src + 'server/tasks.ts']: 0,
      [src + 'cli/commands.ts']: 0,
      [src + 'api/routes.ts']: 0,
      [src + 'server/serve.ts']: 0,
    },
    commits_behind_upstream: 2, head, merge_base: base, upstream: tip,
  })
})

test('fork metric reports zero for an empty diff at an explicit ref', (t) => {
  const { metric, base, git, upstream } = fixture(t)
  git(upstream, 'branch', 'baseline', base)
  const result = metric(upstream, ['--head', base, '--upstream-branch', 'baseline'])
  assert.equal(result.status, 0, result.stderr)
  const doc = JSON.parse(result.stdout)
  assert.equal(doc.head, base)
  assert.equal(doc.upstream, base)
  assert.equal(doc.value, 0)
  assert.equal(doc.lines_added_hot, 0)
  assert.equal(doc.commits_behind_upstream, 0)
})

test('fork metric fails quietly when upstream is unreachable', (t) => {
  const { metric, root } = fixture(t)
  failure(metric(join(root, 'missing')), /could not fetch/)
})

test('fork metric fails quietly with no merge base', (t) => {
  const { metric, root, put, commit, git } = fixture(t)
  const unrelated = join(root, 'unrelated')
  git(root, 'init', '-q', '-b', 'main', unrelated)
  put(unrelated, 'README.md', 'unrelated\n')
  commit(unrelated, 'unrelated')
  failure(metric(unrelated), /no merge base/)
})

test('fork metric rejects binary additions under src', (t) => {
  const { metric, fork, put, commit } = fixture(t)
  put(fork, src + 'binary', Buffer.from([0, 1, 2]))
  commit(fork, 'binary')
  failure(metric(), /binary row/)
})

const claim = (...args) => run(process.execPath, [claimScript, ...args])
for (const [name, args, reason] of [
  ['unknown argument', ['--bogus'], /unknown argument/],
  ['missing value', ['--repo', '--head', 'HEAD'], /missing value for --repo/],
  ['invalid timeout', ['--timeout', '0'], /--timeout must be a positive integer/],
]) {
  test(`claim metric rejects ${name}`, () => failure(claim(...args), reason))
}

test('claim metric fails quietly when its source is missing', (t) => {
  failure(claim('--repo', join(temp(t), 'not-a-repo'), '--timeout', '5'), /clone failed/)
})
