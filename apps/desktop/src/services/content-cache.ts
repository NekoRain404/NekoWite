/** Bounded LRU cache of note path → file content, shared by the library
 * indexer (which reads full content once per note) and the full-text search /
 * graph readers so the same IPC read is reused instead of re-reading every note.
 *
 * `max` caps retained content so a very large vault cannot balloon memory: when
 * full, the least-recently-used entry is evicted and callers fall back to a
 * fresh fs read on a miss. An entry is re-promoted to most-recent on `get` and
 * `set`, so frequently searched notes stay resident. */
export class ContentCache {
  private readonly entries = new Map<string, string>()

  constructor(private readonly max = 200) {}

  /** Return the cached content without touching recency order. */
  peek(path: string): string | undefined {
    return this.entries.get(path)
  }

  /** Return the cached content, promoting the entry to most-recent on a hit. */
  get(path: string): string | undefined {
    const hit = this.entries.get(path)
    if (hit === undefined) return undefined
    this.entries.delete(path)
    this.entries.set(path, hit)
    return hit
  }

  set(path: string, content: string): void {
    this.entries.delete(path)
    this.entries.set(path, content)
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  delete(path: string): void {
    this.entries.delete(path)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/** Upper bound on content entries kept in memory per vault session. A note hit
 * beyond this is read from disk and the least-recently-used entry is dropped. */
export const CONTENT_CACHE_MAX = 200

/** Shared instance used by the library index and the note-list content search. */
export const contentCache = new ContentCache(CONTENT_CACHE_MAX)
