/** Full-text search for the note list's "content search" mode.
 *
 * Candidates (indexed note paths) are read and matched against their body; the
 * vault's persistent index is only an accelerator for that read, never a
 * substitute for it, so a note whose entry is stale is still read. These pure
 * functions own the matching, the snippet extraction and the bounded
 * concurrency, so the UI layer stays thin and testable.
 */

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
const SNIPPET_RADIUS = 40

/** Max concurrent body reads / matches during a content search. */
export const CONTENT_SEARCH_CONCURRENCY = 8

/** Build a one-line plain-text snippet around a hit. `q` must be the folded
 *  (lowercased, trimmed) query and `idx` its index inside the folded body. We
 *  slice the *original* `content` so case/punctuation survives round-trip. */
function snippetAt(content: string, q: string, idx: number, radius = SNIPPET_RADIUS): string {
  if (idx < 0) return ''
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + q.length + radius)
  let slice = content.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) slice = `…${slice}`
  if (end < content.length) slice = `${slice}…`
  return slice
}

/** Map `items` to `results` via an async `worker`, running no more than `limit`
 *  workers concurrently. Input order is preserved; a thrown worker rejects the
 *  whole batch. When `signal` aborts, workers stop scheduling new items so an
 *  in-flight batch unwinds quickly. */
async function mapWithConcurrency<T, R>(
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

/** Result of looking up a note's entry in the persistent search index.
 *  `upToDate` means the stored index text matches the note's current disk state
 *  (stat token), so an absence of the query in `text` is authoritative and the
 *  body never needs to be read. `text` is the lowercased searchable haystack.
 *  A caller that cannot prove that match - the vault index coordinator does not
 *  when its fs subscription is degraded - reports `false`, which makes this an
 *  accelerator only: the body is read and the miss is never trusted. */
export interface IndexLookupResult {
  upToDate: boolean
  text: string
}

/** Full-text search accelerated by the persistent index.
 *
 *  The index holds a lowercased haystack of every searchable field (including
 *  the full body), so for a note whose index entry is up-to-date an absence of
 *  the query in `text` is definitive and the body is never read. When the entry
 *  is missing or stale (index still building, note just changed), we fall back
 *  to reading the body — preserving completeness, so a deep-body-only match is
 *  never dropped just because the index does not yet cover it.
 *
 *  A positive index hit still reads the body to produce the snippet (the full
 *  body scan + snippet remains the source of truth for what is shown).
 *
 *  Cancellation is latest-wins: `indexLookup` is only consulted before a read,
 *  and `signal` is checked before and after every read and at the top of each
 *  worker loop, so a superseded search stops scheduling new work instead of
 *  grinding through the whole vault.
 */
export async function searchWithIndex(
  candidates: readonly ContentSearchCandidate[],
  query: string,
  indexLookup: (path: string) => IndexLookupResult | null,
  signal?: AbortSignal,
  concurrency = CONTENT_SEARCH_CONCURRENCY,
): Promise<ContentMatch[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  if (signal?.aborted) return []

  const hits = await mapWithConcurrency(
    candidates,
    concurrency,
    async (c) => {
      if (signal?.aborted) return null
      const entry = indexLookup(c.path)
      // An up-to-date index that does not contain the query is authoritative:
      // the note's full body is part of the index text, so it cannot match.
      if (entry && entry.upToDate && !entry.text.includes(q)) return null
      const content = await c.readContent()
      if (content === null || signal?.aborted) return null
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
