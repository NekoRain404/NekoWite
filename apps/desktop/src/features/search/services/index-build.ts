/** The build/update path: what a note contributes to the index, and how the
 *  index is built or incrementally updated from the vault's file list.
 *
 * A per-note version token (`mtime:size`) lets a rebuild update only the notes
 * that actually changed, and each entry's `text` holds the lowercased haystack
 * of every searchable field — including the full body, so a deep-body match is
 * captured by the index itself and never silently dropped. Nothing here touches
 * storage: the caller loads and saves around a build.
 */

// Cycle-blocked deep import (§13.11): `features/notes` pulls in NoteListPanel and
// useNoteList, and the path from there back here runs through the vault session
// and this feature's own entry. `note-summary` reaches nothing but i18n and the
// path helpers, so reading it directly is the one edge that does not close the
// loop.
import { parseNoteMeta } from '../../notes/services/note-summary'
import type { FileStat } from '../../../platform/gateways/contracts'
import { INDEX_VERSION, type IndexedDoc, type StoredIndex } from './index-model'

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
  /** Shard labels whose stored checksum failed at load and were re-indexed in
   *  this run (a targeted shard rebuild, not a full-index rebuild). */
  rebuiltShards: string[]
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
    // Shards whose checksum failed at load were dropped from `notes`, so every
    // note in them was (re)read above — report them as a targeted rebuild.
    rebuiltShards: existing?.corruptShards ?? [],
  }
}
