export type WatcherSpec = { tail: string }

/** By UTF-16 code unit, as `sort()` orders strings: the same in every locale and runtime. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * What `watchersHash` hashes, the same on both ends: a board on `http()` hashes its watchers, and
 * the board it uses hashes what it holds.
 */
export function canonicalWatchers(watch: Record<string, WatcherSpec>): string {
  const canonical: unknown[] = Object.keys(watch)
    .sort(byCodeUnit)
    .map((id) => [id, watch[id]!.tail])
  return JSON.stringify(canonical)
}
