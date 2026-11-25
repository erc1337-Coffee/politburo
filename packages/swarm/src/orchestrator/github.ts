// GitHub REST reads and the one write the orchestrator makes: a draft PR whose head
// and base are in the same repository. It never pushes, merges or marks a PR ready.

export class GitHubError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface PullRequest { url: string; state: 'open' | 'closed'; merged: boolean }

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

  /** The repository's default branch, after checking that GitHub knows it by exactly this name. */
  async defaultBranch(repository: string): Promise<string> {
    const { status, data } = await this.#call<{ full_name?: string; default_branch?: string }>('GET', `/repos/${repository}`)
    if (status !== 200 || !data?.default_branch) throw new GitHubError(status, `cannot read ${repository}`)
    if (data.full_name?.toLowerCase() !== repository.toLowerCase()) throw new GitHubError(409, `${repository} is now ${data.full_name}`)
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
    const { status, data } = await this.#call<Array<{ html_url: string; state: 'open' | 'closed'; merged_at: string | null }>>(
      'GET', `/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    )
    if (status !== 200 || !Array.isArray(data)) throw new GitHubError(status, `cannot list PRs of ${repository}`)
    const pull = data[0]
    return pull ? { url: pull.html_url, state: pull.state, merged: pull.merged_at !== null } : null
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
