/** Full-text search helpers for the note list's "content search" mode.
 *
 * The backend `search_notes` only matches filenames, so genuine content search
 * is assembled on the client: candidates (indexed note paths) are read and
 * matched against their body. These pure functions do the matching / snippet
 * extraction / concurrent batching so the UI layer stays thin and testable.
 */

export interface ContentCandidate {
  path: string
  name: string
  content: string
}

export interface ContentMatch {
  path: string
  name: string
  snippet: string
}

/** Number of characters to keep on each side of a hit when building a snippet. */
export const SNIPPET_RADIUS = 40

/** True when `content` contains `query`, case-insensitively. An empty/blank
 *  query never matches (an idle search box must not list every note). */
export function matchContent(content: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return content.toLowerCase().includes(q)
}

/** Build a one-line plain-text snippet around the first hit of `query`. The
 *  fragment is whitespace-collapsed and ellipsised at either edge when it was
 *  clipped. Returns '' when the query is absent or blank. */
export function buildSnippet(content: string, query: string, radius = SNIPPET_RADIUS): string {
  const q = query.trim().toLowerCase()
  if (!q) return ''
  const idx = content.toLowerCase().indexOf(q)
  if (idx < 0) return ''
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + q.length + radius)
  let slice = content.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) slice = `…${slice}`
  if (end < content.length) slice = `${slice}…`
  return slice
}

/** Match one read note against `query`; returns a content match (path/name +
 *  snippet) or null when the query is absent / not found. */
export function contentMatchOf(
  candidate: ContentCandidate,
  query: string,
  radius?: number,
): ContentMatch | null {
  if (matchContent(candidate.content, query) === false) return null
  return {
    path: candidate.path,
    name: candidate.name,
    snippet: buildSnippet(candidate.content, query, radius),
  }
}

/** Map `items` to `results` via an async `worker`, running no more than `limit`
 *  workers concurrently. Input order is preserved; a thrown worker rejects the
 *  whole batch. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  if (items.length === 0) return results
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor
      cursor += 1
      results[i] = await worker(items[i])
    }
  })
  await Promise.all(workers)
  return results
}
