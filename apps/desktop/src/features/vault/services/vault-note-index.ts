/**
 * The open vault's note-list index: it reads note bodies off the disk, turns
 * them into {@link NoteSummary} entries and owns the in-memory mirror of the
 * list (what the note list panel renders, what the link queries read, and what
 * the fs watcher checks a changed folder against).
 *
 * Vue- and Pinia-free: the mirror is a plain array and every mutation is
 * reported through the injected `onNotes` callback, so a store can mirror it
 * into a reactive ref and the whole index can be driven by a memory gateway in
 * a plain unit test.
 *
 * Mutations are silent and `publish()` reports; the callers in
 * `vault-index.ts` need that split because the order of "update the mirror" and
 * "persist the change" is load-bearing (see `applyMdChange` there).
 *
 * A full index reads with bounded concurrency and yields to the event loop
 * between slices, so a 10k-file vault neither floods the fs gateway nor blocks
 * input while the list is being built. Each note that a re-index commits also
 * refreshes the shared content cache and the stat snapshot; a *superseded*
 * full run still feeds both (the coordinator checks supersession after the
 * run, and a stat/cache entry for the vault that was left is still the truth
 * about that file), which is why `indexAll` carries no commit predicate.
 */

import type { ContentCache } from '../../../services/content-cache'
import type { FileStat } from '../../../platform/gateways/contracts'
// Cycle-blocked deep imports (§13.11): `features/notes` pulls in useNoteList,
// which reaches back here through the vault session and the index coordinator.
// The summary and path modules reach nothing but i18n and the path helpers, so
// reading them directly is the one edge that does not close the loop.
import { parseNoteMeta, type NoteSummary } from '../../notes/services/note-summary'
import { relPathOf } from '../../notes/services/note-paths'
import { stripVaultPrefix } from '../../../services/paths'

/** Maximum number of note reads running concurrently during a full index. */
const INDEX_CONCURRENCY = 8
/** Yield to the event loop every N indexed notes so a 10k-file vault never
 * blocks input while the note list is being built. */
const INDEX_YIELD_EVERY = 32

/** Cooperative yield to the event loop so a large note-list index never blocks
 * input for long. Prefers the scheduler API, then requestAnimationFrame, then a
 * macrotask timeout. */
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

/** The stat snapshot recorded for a note at its last index or read. */
export interface NoteStat {
  mtime: number
  size: number
}

export interface VaultNoteIndexDeps {
  /** Read one note body. */
  read(vault: string, path: string): Promise<string>
  /** Stat one note; throws when unreadable. */
  stat(vault: string, path: string): Promise<FileStat>
  /** Shared bounded content cache. */
  cache: ContentCache
  /** True while the fs-change subscription is missing (see `readBody`). */
  isWatcherDown(): boolean
  /** Report the mirror after a mutation. */
  onNotes(notes: NoteSummary[]): void
}

export interface VaultNoteIndex {
  /** Index every path in `paths` and return the summaries, in completion order.
   *  The mirror is NOT touched: the caller replaces it once it knows its run is
   *  still the current one. */
  indexAll(vault: string, paths: string[]): Promise<NoteSummary[]>
  /** Index one note. Reuses the cached content when the stat token is unchanged;
   *  `force` bypasses the cache for a fs-change re-index. `shouldCommit` gates
   *  every commit of the read (content cache and stat snapshot), so a run that
   *  was superseded while its reads were in flight writes neither. */
  indexNote(
    vault: string,
    path: string,
    opts?: { force?: boolean; shouldCommit?: () => boolean },
  ): Promise<NoteSummary | null>
  /** Replace the mirror without publishing it. */
  replace(notes: NoteSummary[]): void
  /** Replace `summary`'s entry in the mirror without publishing it. */
  upsert(summary: NoteSummary): void
  /** Drop `path` from the mirror without publishing it (it no longer parses or
   *  reads; the caches are kept - the body may still be valid). */
  remove(path: string): void
  /** Drop a deleted note from the mirror and from both caches. */
  forget(path: string): void
  /** Empty the mirror without publishing it (vault switch). The stat snapshot
   *  survives: it is keyed by absolute path and still describes those files. */
  clear(): void
  /** Report the mirror through `onNotes`. */
  publish(): void
  /** Mirror contents. */
  list(): NoteSummary[]
  /** True when `path` is, or contains, a note the mirror lists.
   *
   *  The event for a folder rename or delete arrives for the FOLDER alone (there
   *  is no per-child event to rely on), so a non-note change is only structural
   *  for the note list when a listed note lives under it. Comparing against the
   *  index keeps attachment churn — an image saved on every paste — from
   *  triggering a full re-read of the vault. */
  covers(vault: string, path: string): boolean
  /** The stat snapshot recorded for `path`, used to decide whether a persistent
   *  index entry still describes the file. */
  statOf(path: string): NoteStat | undefined
  /** Read one note body, reusing the cache only while the fs subscription can
   *  still tell us the entry is current. In degraded mode a cached body may
   *  predate an edit made in another editor - nothing would have invalidated it
   *  - so the file is read from disk instead. A slower search is the price of
   *  not answering "no match" for text that is right there in the note. */
  readBody(vault: string | null, path: string): Promise<string | null>
}

export function createVaultNoteIndex(deps: VaultNoteIndexDeps): VaultNoteIndex {
  /** path → { mtime, size } for the last index/read of that note, used to skip
   * re-reading unchanged files on a re-index. Kept across vault switches. */
  const noteStatCache = new Map<string, NoteStat>()
  let notes: NoteSummary[] = []

  async function indexNote(
    v: string,
    path: string,
    opts: { force?: boolean; shouldCommit?: () => boolean } = {},
  ): Promise<NoteSummary | null> {
    const cached = noteStatCache.get(path)
    if (cached !== undefined && !opts.force) {
      try {
        const stat = await deps.stat(v, path)
        if (stat.mtime === cached.mtime && stat.size === cached.size) {
          const content = deps.cache.get(path) ?? deps.cache.peek(path)
          if (content !== undefined) {
            return parseNoteMeta(path, content, { mtime: stat.mtime, size: stat.size, vault: v })
          }
        }
      } catch {
        // stat failed — fall through to a fresh read below.
      }
    }
    try {
      const [content, stat] = await Promise.all([
        deps.read(v, path),
        deps.stat(v, path).catch(() => null),
      ])
      const mtime = stat?.mtime ?? 0
      const size = stat?.size ?? content.length
      if (opts.shouldCommit ? opts.shouldCommit() : true) {
        deps.cache.set(path, content)
        noteStatCache.set(path, { mtime, size })
      }
      return parseNoteMeta(path, content, { mtime, size, vault: v })
    } catch {
      if (opts.shouldCommit ? opts.shouldCommit() : true) noteStatCache.delete(path)
      return null
    }
  }

  async function indexAll(v: string, paths: string[]): Promise<NoteSummary[]> {
    const results: NoteSummary[] = []
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        const path = paths[cursor]
        cursor += 1
        const summary = await indexNote(v, path)
        if (summary) results.push(summary)
        if (cursor % INDEX_YIELD_EVERY === 0) await yieldToMainThread()
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(INDEX_CONCURRENCY, Math.max(paths.length, 1)) }, () => worker()),
    )
    return results
  }

  async function readBody(vault: string | null, path: string): Promise<string | null> {
    if (!deps.isWatcherDown()) {
      const cached = deps.cache.get(path)
      if (cached !== undefined) return cached
    }
    if (!vault) return null
    try {
      const content = await deps.read(vault, path)
      deps.cache.set(path, content)
      return content
    } catch {
      return null
    }
  }

  return {
    indexAll,
    indexNote,
    replace: (next) => {
      notes = next
    },
    upsert: (summary) => {
      notes = [...notes.filter((n) => n.path !== summary.path), summary]
    },
    remove: (path) => {
      notes = notes.filter((n) => n.path !== path)
    },
    forget: (path) => {
      notes = notes.filter((n) => n.path !== path)
      deps.cache.delete(path)
      noteStatCache.delete(path)
    },
    clear: () => {
      notes = []
    },
    publish: () => deps.onNotes(notes),
    list: () => notes,
    covers: (v, path) => {
      const target = stripVaultPrefix(path, v).replace(/[/\\]+$/, '')
      if (!target) return true
      return notes.some((n) => {
        const rel = relPathOf(n)
        return rel === target || rel.startsWith(`${target}/`)
      })
    },
    statOf: (path) => noteStatCache.get(path),
    readBody,
  }
}
