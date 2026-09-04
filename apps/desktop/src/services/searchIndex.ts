/** Persistent, incremental full-text index for vault search.
 *
 * The note list currently does a live full-body scan for content search. That
 * scan is correct (a deep-body-only match is still found) but re-reads every
 * note on every keystroke. This module builds a persistent, incremental term
 * index over each note's searchable fields so a search can skip notes that
 * cannot match, while the full-body scan remains the source of truth for the
 * snippet (see contentSearch `searchWithIndex`).
 *
 * The index is stored per-vault in localStorage (a compact JSON blob). A
 * per-note version token (`mtime:size`) lets a rebuild update only the notes
 * that actually changed, and a `text` field holds the lowercased haystack of
 * every searchable field — including the full body, so a deep-body match is
 * captured by the index itself and never silently dropped.
 */

import { parseNoteMeta } from './noteMeta'
import type { FileStat } from './gateways/contracts'

export interface IndexedDoc {
  /** Version token `${mtime}:${size}` — changed files produce a different token. */
  token: string
  /** Lowercased concatenation of every searchable field (path, name, dir, title,
   *  tags, summary, frontmatter, and the full body text / MDX text). */
  text: string
  mtime: number
  size: number
}

export interface StoredIndex {
  version: 1
  vault: string
  builtAt: number
  notes: Record<string, IndexedDoc>
}

/** UI-facing state of the persistent index for the current vault. */
export type IndexState = 'idle' | 'building' | 'up-to-date' | 'stale' | 'needs-rebuild'

export interface IndexStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const INDEX_VERSION = 1
const LS_PREFIX = 'nekowite.searchIndex'

/** In-memory fallback used when localStorage is unavailable (some test envs). */
const memoryStorage: IndexStorage = (() => {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, String(v))
    },
    removeItem: (k) => {
      store.delete(k)
    },
  }
})()

function defaultStorage(): IndexStorage {
  try {
    const ls = globalThis.localStorage
    if (ls) return ls
  } catch {
    // ignore — fall through to memory
  }
  return memoryStorage
}

export function indexKey(vault: string): string {
  return `${LS_PREFIX}.v1.${vault}`
}

/** Version token for a note's indexed content. */
export function docToken(mtime: number, size: number): string {
  return `${mtime}:${size}`
}

/** Fold every searchable field of a note into one lowercased haystack. The full
 *  `content` (frontmatter + body + MDX text, including any referenced
 *  attachment path / alt-text) is included so a deep-body-only match is present
 *  in the index and never dropped by a metadata-first prefilter. */
export function searchableText(
  path: string,
  content: string,
  meta: { title: string; tags: string[]; summary: string; name: string; dir: string },
): string {
  return [
    path,
    meta.name,
    meta.dir,
    meta.title,
    meta.tags.join(' '),
    meta.summary,
    content,
  ]
    .join('\n')
    .toLowerCase()
}

/** Build the index text for a single note from its raw content + stat. Reuses
 *  the note-meta parser so the index fields mirror the note list. */
export function buildSearchText(
  path: string,
  content: string,
  vault: string,
  mtime: number,
  size: number,
): string {
  const meta = parseNoteMeta(path, content, { mtime, size, vault })
  return searchableText(path, content, meta)
}

export function loadIndex(
  vault: string,
  storage: IndexStorage = defaultStorage(),
): StoredIndex | null {
  const raw = storage.getItem(indexKey(vault))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredIndex
    if (parsed.version !== INDEX_VERSION) return null
    if (!parsed.notes || typeof parsed.notes !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function saveIndex(index: StoredIndex, storage: IndexStorage = defaultStorage()): void {
  storage.setItem(indexKey(index.vault), JSON.stringify(index))
}

export function clearIndex(vault: string, storage: IndexStorage = defaultStorage()): void {
  storage.removeItem(indexKey(vault))
}

/** Candidate note paths whose indexed text contains `query`. Returns an empty
 *  array for a blank query. The result is sorted so the UI stays stable. */
export function queryIndex(index: StoredIndex, query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: string[] = []
  for (const [path, doc] of Object.entries(index.notes)) {
    if (doc.text.includes(q)) out.push(path)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** Coarse index state from the stored blob and the current file list. Does not
 *  stat disks — the build step reconciles mtime/size and sets a finer state. */
export function indexStateOf(index: StoredIndex | null, paths: string[]): IndexState {
  if (!index) return 'needs-rebuild'
  for (const path of paths) {
    if (!index.notes[path]) return 'stale'
  }
  return 'up-to-date'
}

/** Cooperative yield to the event loop so a large background build never
 *  blocks input. */
function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

export interface IndexBuildDeps {
  stat: (path: string) => Promise<FileStat | null>
  read: (path: string) => Promise<string>
  /** Overridable text builder (for tests); defaults to {@link buildSearchText}. */
  textOf?: (path: string, content: string, mtime: number, size: number, vault: string) => string
}

export interface IndexBuildOptions {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  force?: boolean
  concurrency?: number
}

export interface IndexBuildResult {
  index: StoredIndex
  /** Notes rebuilt from a fresh read. */
  built: number
  /** Notes left untouched because their stat matched the stored token. */
  skipped: number
  /** Note paths added/changed in this run. */
  changed: number
  /** Note paths dropped because they are no longer in the vault. */
  removed: number
  /** Notes that failed to read/stat. */
  failed: number
}

const DEFAULT_CONCURRENCY = 4
const YIELD_EVERY = 25

/** Build (or incrementally update) a persistent index for `vault`.
 *
 *  Starting from `existing` (or empty), it:
 *  - drops entries for paths no longer in `paths` (add/delete/move),
 *  - skips entries whose stat matches the stored mtime/size token,
 *  - re-reads and re-indexes only the changed paths (bounded concurrency),
 *  - yields to the event loop every few notes so a large vault never blocks
 *    the main thread,
 *  - is cancellable via `signal` (a partial index is still returned).
 */
export async function buildIndexIncremental(
  vault: string,
  paths: string[],
  deps: IndexBuildDeps,
  existing: StoredIndex | null,
  opts: IndexBuildOptions = {},
): Promise<IndexBuildResult> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const force = opts.force ?? false
  const signal = opts.signal
  const textOf =
    deps.textOf ??
    ((path: string, content: string, mtime: number, size: number, v: string) =>
      buildSearchText(path, content, v, mtime, size))
  const notes: Record<string, IndexedDoc> = existing ? { ...existing.notes } : {}
  const current = new Set(paths)

  let removed = 0
  for (const path of Object.keys(notes)) {
    if (!current.has(path)) {
      delete notes[path]
      removed += 1
    }
  }

  let built = 0
  let skipped = 0
  let failed = 0
  const changed = new Set<string>()
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < paths.length) {
      if (signal?.aborted) return
      const path = paths[cursor]
      cursor += 1
      try {
        // Resolve the current stat; a null stat (unreadable) still falls back to
        // a read attempt below rather than silently dropping the note.
        const stat = await deps.stat(path)
        if (signal?.aborted) return
        const existingDoc = notes[path]
        if (
          !force &&
          existingDoc &&
          stat &&
          existingDoc.mtime === stat.mtime &&
          existingDoc.size === stat.size
        ) {
          skipped += 1
          continue
        }
        const content = await deps.read(path)
        if (signal?.aborted) return
        const mtime = stat?.mtime ?? 0
        const size = stat?.size ?? content.length
        notes[path] = { token: docToken(mtime, size), text: textOf(path, content, mtime, size, vault), mtime, size }
        built += 1
        changed.add(path)
        opts.onProgress?.(built, paths.length)
      } catch {
        failed += 1
      }
      if (built % YIELD_EVERY === 0) await yieldToMainThread()
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(paths.length, 1)) }, () => worker()),
  )

  return {
    index: { version: INDEX_VERSION, vault, builtAt: Date.now(), notes },
    built,
    skipped,
    changed: changed.size,
    removed,
    failed,
  }
}
