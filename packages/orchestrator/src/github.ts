// GitHub REST reads, the draft PR the orchestrator opens (head and base in the same repository),
// and the pull request operations it does when a person asks for them in the task thread: mark it
// ready for review, merge, close and reopen. Pushes go through git, never through this client.

export class GitHubError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface PullRequest {
  url: string
  number: number
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  headSha: string | null
  /** GraphQL id, which `markReady` needs. */
  nodeId: string | null
}

/** The status of one pull request: GitHub's merge view and the checks on its head commit. */
export interface PullRequestStatus extends PullRequest {
  title: string
  mergeable: boolean | null
  mergeableState: string | null
  checks: Array<{ name: string; status: string; conclusion: string | null }>
  /** The combined state of commit statuses: success, pending, failure, error, or null without any. */
  combinedStatus: string | null
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

interface PullJson {
  html_url: string; number: number; state: 'open' | 'closed'; merged_at: string | null; draft?: boolean
  head?: { sha?: string }; node_id?: string; title?: string; mergeable?: boolean | null; mergeable_state?: string
  merged?: boolean
}

const pullOf = (pull: PullJson): PullRequest => ({
  url: pull.html_url, number: pull.number, state: pull.state, merged: pull.merged_at !== null || pull.merged === true,
  draft: pull.draft === true, headSha: pull.head?.sha ?? null, nodeId: pull.node_id ?? null,
})

export interface GitHubClientOptions { apiUrl: string; token: string; fetch?: typeof fetch }

/** `owner/name` from an https GitHub URL, or null. */
export function repositoryName(url: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  return match ? `${match[1]}/${match[2]}` : null
}

export class GitHubClient {
  readonly #api: string
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(options: GitHubClientOptions) {
    this.#api = options.apiUrl.replace(/\/+$/, '')
    this.#token = options.token
    this.#fetch = options.fetch ?? fetch
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const response = await this.#fetch(`${this.#api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = await response.json().catch(() => null) as T
    return { status: response.status, data }
  }

  /** The repository's default branch. */
  async defaultBranch(repository: string): Promise<string> {
    const { status, data } = await this.#call<{ default_branch?: string }>('GET', `/repos/${repository}`)
    if (status !== 200 || !data?.default_branch) throw new GitHubError(status, `cannot read ${repository}`)
    return data.default_branch
  }

  /** The commit a branch points at, or null when the branch does not exist. */
  async branchHead(repository: string, branch: string): Promise<string | null> {
    const { status, data } = await this.#call<{ commit?: { sha?: string } }>('GET', `/repos/${repository}/branches/${encodeURIComponent(branch)}`)
    if (status === 404) return null
    if (status !== 200 || !data?.commit?.sha) throw new GitHubError(status, `cannot read ${repository}@${branch}`)
    return data.commit.sha
  }

  /** The newest PR from `branch` of the same repository, any state. */
  async findPullRequest(repository: string, branch: string): Promise<PullRequest | null> {
    const owner = repository.split('/')[0]!
    const { status, data } = await this.#call<PullJson[]>(
      'GET', `/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    )
    if (status !== 200 || !Array.isArray(data)) throw new GitHubError(status, `cannot list PRs of ${repository}`)
    const pull = data[0]
    return pull ? pullOf(pull) : null
  }

  /** One pull request with its merge view and the checks of its head commit. */
  async pullRequestStatus(repository: string, number: number): Promise<PullRequestStatus> {
    const { status, data } = await this.#call<PullJson>('GET', `/repos/${repository}/pulls/${number}`)
    if (status !== 200 || !data) throw new GitHubError(status, `cannot read PR #${number} of ${repository}`)
    const pull = pullOf(data)
    let checks: PullRequestStatus['checks'] = []
    let combinedStatus: string | null = null
    if (pull.headSha) {
      const runs = await this.#call<{ check_runs?: Array<{ name: string; status: string; conclusion: string | null }> }>('GET', `/repos/${repository}/commits/${pull.headSha}/check-runs?per_page=50`)
      if (runs.status === 200) checks = (runs.data?.check_runs ?? []).map(({ name, status, conclusion }) => ({ name, status, conclusion }))
      const combined = await this.#call<{ state?: string; total_count?: number }>('GET', `/repos/${repository}/commits/${pull.headSha}/status`)
      if (combined.status === 200 && (combined.data?.total_count ?? 0) > 0) combinedStatus = combined.data?.state ?? null
    }
    return { ...pull, title: data.title ?? '', mergeable: data.mergeable ?? null, mergeableState: data.mergeable_state ?? null, checks, combinedStatus }
  }

  /** Marks a draft pull request ready for review; REST has no call for it, GraphQL does. */
  async markReady(pull: Pick<PullRequest, 'number' | 'nodeId'>, repository: string): Promise<void> {
    if (!pull.nodeId) throw new GitHubError(0, `PR #${pull.number} of ${repository} has no GraphQL id`)
    const { status, data } = await this.#call<{ errors?: Array<{ message?: string }> }>('POST', '/graphql', {
      query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: pull.nodeId },
    })
    if (status !== 200 || data?.errors?.length) throw new GitHubError(status, `cannot mark PR #${pull.number} ready: ${data?.errors?.[0]?.message ?? status}`)
  }

  async merge(repository: string, number: number, method: MergeMethod): Promise<string> {
    const { status, data } = await this.#call<{ sha?: string; message?: string }>('PUT', `/repos/${repository}/pulls/${number}/merge`, { merge_method: method })
    if (status !== 200 || !data?.sha) throw new GitHubError(status, `cannot merge PR #${number}: ${data?.message ?? status}`)
    return data.sha
  }

  /** Closes or reopens a pull request. */
  async setPullRequestState(repository: string, number: number, state: 'open' | 'closed'): Promise<void> {
    const { status, data } = await this.#call<{ message?: string }>('PATCH', `/repos/${repository}/pulls/${number}`, { state })
    if (status !== 200) throw new GitHubError(status, `cannot ${state === 'open' ? 'reopen' : 'close'} PR #${number}: ${data?.message ?? status}`)
  }

  /** Opens a draft PR from `branch` into `base`, both in `repository`. */
  async openDraftPullRequest(repository: string, input: { branch: string; base: string; title: string; body: string }): Promise<string> {
    const { status, data } = await this.#call<{ html_url?: string; message?: string }>('POST', `/repos/${repository}/pulls`, {
      title: input.title, head: input.branch, base: input.base, body: input.body, draft: true,
    })
    if (status !== 201 || !data?.html_url) throw new GitHubError(status, `cannot open a PR in ${repository}: ${data?.message ?? status}`)
    return data.html_url
  }
}
