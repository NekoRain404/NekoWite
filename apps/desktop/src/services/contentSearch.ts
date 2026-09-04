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

/** Index metadata available for every note WITHOUT reading its body. Reading a
 *  note's full body is the expensive part of content search, so this is what we
 *  match against first. `summary` is the first-line / visible-text proxy the
 *  indexer stores. */
export interface ContentMeta {
  path: string
  name: string
  title: string
  tags: string[]
  summary: string
}

/** A search candidate: index metadata plus a lazy body reader (backed by the
 *  shared content cache, so a cached note never touches disk). */
export interface ContentSearchCandidate extends ContentMeta {
  readContent: () => Promise<string | null>
}

/** Number of characters to keep on each side of a hit when building a snippet. */
export const SNIPPET_RADIUS = 40

/** Max concurrent body reads / matches during a content search. */
export const CONTENT_SEARCH_CONCURRENCY = 8

/** True when `content` contains `query`, case-insensitively. An empty/blank
 *  query never matches (an idle search box must not list every note). */
export function matchContent(content: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return content.toLowerCase().includes(q)
}

/** Build a one-line plain-text snippet around a hit. `q` must be the folded
 *  (lowercased, trimmed) query and `idx` its index inside the folded body. We
 *  slice the *original* `content` so case/punctuation survives round-trip,
 *  matching the pre-existing `buildSnippet` behavior exactly. */
function snippetAt(content: string, q: string, idx: number, radius = SNIPPET_RADIUS): string {
  if (idx < 0) return ''
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + q.length + radius)
  let slice = content.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) slice = `…${slice}`
  if (end < content.length) slice = `${slice}…`
  return slice
}

/** Build a one-line plain-text snippet around the first hit of `query`. The
 *  fragment is whitespace-collapsed and ellipsised at either edge when it was
 *  clipped. Returns '' when the query is absent or blank. */
export function buildSnippet(content: string, query: string, radius = SNIPPET_RADIUS): string {
  const q = query.trim().toLowerCase()
  if (!q) return ''
  const idx = content.toLowerCase().indexOf(q)
  return snippetAt(content, q, idx, radius)
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

/** Fold a candidate's index metadata into a single lowercased haystack. */
export function metaHaystack(
  meta: Pick<ContentMeta, 'path' | 'name' | 'title' | 'tags' | 'summary'>,
): string {
  return `${meta.path} ${meta.name} ${meta.title} ${meta.tags.join(' ')} ${meta.summary}`.toLowerCase()
}

/** Cheap, disk-free prefilter: does `query` appear in the index metadata
 *  (path / name / title / tags / first-line)? */
export function contentMetaMatch(meta: ContentMeta, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return metaHaystack(meta).includes(q)
}

/** Map `items` to `results` via an async `worker`, running no more than `limit`
 *  workers concurrently. Input order is preserved; a thrown worker rejects the
 *  whole batch. When `signal` aborts, workers stop scheduling new items so an
 *  in-flight batch unwinds quickly. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  if (items.length === 0) return results
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return
      const i = cursor
      cursor += 1
      results[i] = await worker(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/** Run the metadata-first full-text search. Candidates whose index metadata
 *  misses the query are rejected WITHOUT reading their body — only
 *  metadata-matching candidates are read, then folded once and body-matched so
 *  the lowercased form is reused for both the match and the snippet. The
 *  expected tradeoff is that a match sitting deep in a body (not reflected in
 *  path / name / title / tags / first-line) is not surfaced.
 *
 *  `signal` cancels in-flight work: it is checked between awaits (before each
 *  read and again after it) so a superseded search stops before its next read /
 *  match step instead of grinding through the whole vault. */
export async function searchContentMatches(
  candidates: readonly ContentSearchCandidate[],
  query: string,
  signal?: AbortSignal,
  concurrency = CONTENT_SEARCH_CONCURRENCY,
): Promise<ContentMatch[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  if (signal?.aborted) return []

  const metaHits = candidates.filter((c) => metaHaystack(c).includes(q))
  if (signal?.aborted) return []

  const hits = await mapWithConcurrency(
    metaHits,
    concurrency,
    async (c) => {
      if (signal?.aborted) return null
      const content = await c.readContent()
      if (content === null || signal?.aborted) return null
      // Fold the body once; reuse for both the match and the snippet.
      const folded = content.toLowerCase()
      const idx = folded.indexOf(q)
      if (idx < 0) return null
      return {
        path: c.path,
        name: c.name,
        snippet: snippetAt(content, q, idx),
      }
    },
    signal,
  )

  if (signal?.aborted) return []
  return hits.filter((m): m is ContentMatch => m !== null)
}
