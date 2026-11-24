import { readFileSync } from 'node:fs'
import type { ModelRoute, RepositoryView } from '../contract/channel-settings.ts'

const LIST_TTL_MS = 60_000
const FOUND_MAX = 20
const PAGES_MAX = 10

type GitHubRepository = { full_name: string; html_url: string; clone_url: string; private: boolean; description: string | null }

const viewOf = (repository: GitHubRepository): RepositoryView => ({
  name: repository.full_name,
  url: repository.clone_url,
  private: repository.private,
  description: repository.description,
})

/** Repositories a GitHub token reaches, by name, plus an exact public `owner/name`. */
export function githubRepositories(token: string, fetcher: typeof fetch = fetch) {
  let listed: { at: number; repositories: Promise<RepositoryView[]> } | null = null
  const ask = (path: string, signal: AbortSignal) =>
    fetcher(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal,
    })
  const all = (signal: AbortSignal) => {
    if (listed && Date.now() - listed.at < LIST_TTL_MS) return listed.repositories
    const repositories = (async () => {
      const found: RepositoryView[] = []
      for (let page = 1; page <= PAGES_MAX; page++) {
        const response = await ask(`/user/repos?per_page=100&sort=pushed&page=${page}`, signal)
        if (!response.ok) throw new Error(`GitHub answered ${response.status} listing repositories`)
        const batch = (await response.json()) as GitHubRepository[]
        found.push(...batch.map(viewOf))
        if (batch.length < 100) break
      }
      return found
    })()
    listed = { at: Date.now(), repositories }
    repositories.catch(() => (listed = null))
    return repositories
  }
  return async (query: string | undefined, signal: AbortSignal): Promise<RepositoryView[]> => {
    const wanted = query?.trim().toLowerCase() ?? ''
    const found = (await all(signal)).filter((repository) => repository.name.toLowerCase().includes(wanted)).slice(0, FOUND_MAX)
    if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(wanted) && !found.some((repository) => repository.name.toLowerCase() === wanted)) {
      const response = await ask(`/repos/${wanted}`, signal)
      if (response.ok) found.unshift(viewOf((await response.json()) as GitHubRepository))
    }
    return found
  }
}

/** Reads `swarm sprite routes` output. */
export function readModelRoutes(file: string): ModelRoute[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${file} holds no list of model routes`)
  return parsed.map((entry, n) => {
    const { label, provider, model } = (entry ?? {}) as Record<string, unknown>
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) throw new Error(`${file}: route ${n + 1} needs a provider and a model`)
    return { key: `${provider}/${model}`, label: typeof label === 'string' && label ? label : `${provider}/${model}`, provider, model }
  })
}
