/**
 * Persistent, incremental full-text index lifecycle for the open vault.
 *
 * Owns the in-memory mirror of the persisted {@link StoredIndex} and the
 * build/cancel/rebuild machinery. It is deliberately Vue-free: it never touches
 * a Pinia store or a reactive ref. Instead it reports state transitions through
 * the injected `onState` callback so an application/service layer (the vault
 * index coordinator) can mirror them into reactive store state. This makes the
 * whole build cycle testable with a memory gateway in a plain unit test.
 *
 * Concurrency is latest-wins: every `build`/`rebuild` bumps a sequence and
 * aborts the previous controller, so a superseded background build can never
 * overwrite the current index. `detach()` cancels any in-flight build and
 * clears the mirror for a vault switch.
 */

import type { IndexLookupResult } from '../../../services/contentSearch'
import type { FileStat } from '../../../services/gateways/contracts'
import {
  buildIndexIncremental,
  buildSearchText,
  docToken,
  queryIndex,
  type IndexState,
  type StoredIndex,
} from '../../../services/searchIndex'

export interface IndexPersistenceDeps {
  /** Load the persisted index for `vault`, or null when none/unchanged. */
  load(vault: string): StoredIndex | null
  /** Persist `index` (atomic blob write). */
  save(index: StoredIndex): void
  /** Drop the persisted index for `vault` (rebuild start). */
  clear(vault: string): void
  /** Stat one note for the incremental reconcile (null on unreadable). */
  stat(path: string): Promise<FileStat | null>
  /** Read one note body for the index (cached by the caller). */
  read(path: string): Promise<string>
  /** Optional accessor for the coordinator's note-stat cache, used to decide
   * whether an index entry is still `up-to-date` for content search. */
  getStat?(path: string): { mtime: number; size: number } | undefined
  /** Report state/progress transitions to the reactive layer. */
  onState?(state: IndexState, progress: { done: number; total: number } | null): void
}

export interface IndexPersistence {
  /** Build (or incrementally reconcile) the index for `vault`. Latest-wins;
   * a newer build supersedes an in-flight one. */
  build(vault: string, paths: string[], opts?: { force?: boolean }): Promise<void>
  /** Cancel the in-flight build without touching the mirror. */
  cancel(): void
  /** Clear the in-memory mirror + persisted blob (rebuild start). */
  reset(vault: string): void
  /** Build from scratch: drop the persisted index then force a full build. */
  rebuild(vault: string, paths: string[]): Promise<void>
  /** Persist one changed note's entry in place. */
  upsert(vault: string, path: string, content: string, mtime: number, size: number): void
  /** Drop a removed note's entry from the index. */
  remove(path: string): void
  /** Look up a note's persistent-index entry for content search. */
  entryFor(path: string): IndexLookupResult | null
  /** Candidate note paths whose indexed text contains `query`. */
  candidatePaths(query: string): string[]
  /** Cancel in-flight work and clear the mirror + state on vault switch. */
  detach(): void
  /** Current UI-facing index state. */
  state(): IndexState
  /** Current build progress, or null when idle. */
  progress(): { done: number; total: number } | null
}

export function createIndexPersistence(deps: IndexPersistenceDeps): IndexPersistence {
  let currentIndex: StoredIndex | null = null
  let abort: AbortController | null = null
  let seq = 0
  let state: IndexState = 'idle'
  let progress: { done: number; total: number } | null = null

  function fire(): void {
    deps.onState?.(state, progress)
  }

  async function build(vault: string, paths: string[], opts: { force?: boolean } = {}): Promise<void> {
    const mySeq = ++seq
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    state = 'building'
    progress = { done: 0, total: 0 }
    fire()
    try {
      const existing = deps.load(vault)
      if (mySeq !== seq) return
      progress = { done: 0, total: paths.length }
      fire()
      const result = await buildIndexIncremental(
        vault,
        paths,
        { stat: deps.stat, read: deps.read },
        existing,
        {
          signal: controller.signal,
          force: opts.force,
          onProgress: (done, total) => {
            if (mySeq === seq) {
              progress = { done, total }
              fire()
            }
          },
        },
      )
      if (mySeq !== seq || controller.signal.aborted) return
      currentIndex = result.index
      deps.save(result.index)
      state = result.failed > 0 ? 'stale' : 'up-to-date'
      fire()
    } finally {
      if (mySeq === seq) {
        progress = null
        abort = null
        fire()
      }
    }
  }

  function cancel(): void {
    abort?.abort()
    abort = null
  }

  function reset(vault: string): void {
    seq += 1
    cancel()
    currentIndex = null
    state = 'idle'
    progress = null
    deps.clear(vault)
    fire()
  }

  async function rebuild(vault: string, paths: string[]): Promise<void> {
    const mySeq = ++seq
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    deps.clear(vault)
    // Clear the in-memory mirror first so a rebuild is truly from scratch.
    currentIndex = null
    state = 'building'
    progress = { done: 0, total: paths.length }
    fire()
    try {
      if (mySeq !== seq) return
      const result = await buildIndexIncremental(
        vault,
        paths,
        { stat: deps.stat, read: deps.read },
        null,
        {
          signal: controller.signal,
          force: true,
          onProgress: (done, total) => {
            if (mySeq === seq) {
              progress = { done, total }
              fire()
            }
          },
        },
      )
      if (mySeq !== seq || controller.signal.aborted) return
      currentIndex = result.index
      deps.save(result.index)
      state = result.failed > 0 ? 'stale' : 'up-to-date'
      fire()
    } finally {
      if (mySeq === seq) {
        progress = null
        abort = null
        fire()
      }
    }
  }

  function upsert(vault: string, path: string, content: string, mtime: number, size: number): void {
    if (!currentIndex) {
      currentIndex = { version: 1, vault, builtAt: Date.now(), notes: {} }
    }
    const text = buildSearchText(path, content, vault, mtime, size)
    currentIndex.notes[path] = { token: docToken(mtime, size), text, mtime, size }
    deps.save(currentIndex)
  }

  function remove(path: string): void {
    if (!currentIndex || !currentIndex.notes[path]) return
    delete currentIndex.notes[path]
    deps.save(currentIndex)
  }

  function entryFor(path: string): IndexLookupResult | null {
    const index = currentIndex
    if (!index) return null
    const doc = index.notes[path]
    if (!doc) return null
    const currentStat = deps.getStat?.(path)
    const upToDate =
      currentStat !== undefined && currentStat.mtime === doc.mtime && currentStat.size === doc.size
    return { upToDate, text: doc.text }
  }

  function candidatePaths(query: string): string[] {
    if (!currentIndex) return []
    return queryIndex(currentIndex, query)
  }

  function detach(): void {
    seq += 1
    cancel()
    currentIndex = null
    state = 'idle'
    progress = null
    fire()
  }

  return {
    build,
    cancel,
    reset,
    rebuild,
    upsert,
    remove,
    entryFor,
    candidatePaths,
    detach,
    state: () => state,
    progress: () => progress,
  }
}

export type { IndexState }
