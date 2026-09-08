/**
 * Coordinates filesystem watch events into note-list and full-text index tasks
 * for the currently-open vault.
 *
 * This is the vault's application service: it is the ONLY layer that reads file
 * content, stats, lists and subscribes to fs changes. It is Vue- and Pinia-free
 * — state changes are reported through the injected callbacks so a store can
 * mirror them into reactive refs, and the whole coordinator can be driven by a
 * memory gateway in a plain unit test.
 *
 * Lifecycle is latest-wins with an explicit detach: `indexVault` bumps a
 * generation and tears down the previous vault's subscription + pending index
 * tasks, so a superseded switch never writes stale notes into the new vault.
 * `detach()` cancels in-flight builds and clears the subscription, satisfying
 * "switching vault cancels the prior vault's index tasks and clears its
 * subscriptions".
 */

import { ATTACHMENTS_DIR } from '../../../services/attachments'
import type { ContentCache } from '../../../services/contentCache'
import type { FileEntry, FileStat, FsChangeEvent } from '../../../platform/gateways/contracts'
import { parseNoteMeta, type NoteSummary } from '../../../services/noteMeta'
import type { IndexLookupResult } from '../../../services/contentSearch'
import type { IndexState, StoredIndex } from '../../../services/searchIndex'
import { createIndexPersistence, type IndexPersistence } from './indexPersistence'

/** Coalesce bursts of markdown fs-change events for one path into a single
 * re-index (a save may otherwise emit several read + stat + index updates). */
const MD_CHANGE_DEBOUNCE_MS = 200
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

function isMdPath(path: string): boolean {
  return /\.(md|mdx)$/i.test(path)
}

/** Minimal port over the vault file list cache (see `services/vaultFiles`). */
export interface FileIndexPort {
  get(vault: string): Promise<string[]>
  isTruncated(vault: string): boolean
  invalidate(vault: string): void
}

export interface VaultIndexCoordinatorDeps {
  /** Read one note body. */
  read(vault: string, path: string): Promise<string>
  /** Stat one note; throws when unreadable. */
  stat(vault: string, path: string): Promise<FileStat>
  /** List a directory entry (for the attachment badge). */
  list(vault: string, dir: string): Promise<FileEntry[]>
  /** Subscribe to fs-change events; resolves to an unsubscribe. */
  onFsChange(cb: (e: FsChangeEvent) => void): Promise<() => void>
  /** Vault file-list cache. */
  fileIndex: FileIndexPort
  /** Shared bounded content cache. */
  cache: ContentCache
  /** Persistent search-index blob access (async: shards live on fs/localStorage). */
  loadIndex(vault: string): Promise<StoredIndex | null>
  saveIndex(index: StoredIndex): Promise<void>
  clearIndex(vault: string): Promise<void>
  // Reactive store targets (mirror coordinator state into Pinia).
  onNotes(notes: NoteSummary[]): void
  onIndexing(indexing: boolean): void
  onTruncated(truncated: boolean): void
  onAttachmentCount(count: number): void
  onNotesPruned(favorites: string[], recents: string[]): void
  onIndexState(state: IndexState, progress: { done: number; total: number } | null): void
  getFavorites(): string[]
  getRecents(): string[]
}

export interface VaultIndexCoordinator {
  /** Switch to `vault` (teardown prior + subscribe + full index) and return when
   * the note list has been indexed. The background search-index build is not
   * awaited. Superseded by any later `indexVault`/`detach`. */
  indexVault(vault: string): Promise<void>
  /** Cancel in-flight index tasks and clear the fs subscription/vault state. */
  detach(): void
  /** Read a note body for content search, reusing the shared cache. */
  noteContent(path: string): Promise<string | null>
  /** Look up a note's persistent-index entry for content search. */
  indexEntryFor(path: string): IndexLookupResult | null
  /** Candidate note paths whose indexed text contains `query`. */
  indexCandidatePaths(query: string): string[]
  /** Built (or incrementally reconcile) the persistent search index for `vault`.
   * No-op when `vault` is not the current vault (latest-wins guards inside). */
  buildSearchIndex(vault: string): Promise<void>
  /** Cancel an in-flight persistent index build. */
  cancelSearchIndexBuild(): void
  /** Drop the persisted index and force a from-scratch background rebuild. */
  rebuildIndex(): Promise<void>
}

export function createVaultIndexCoordinator(deps: VaultIndexCoordinatorDeps): VaultIndexCoordinator {
  let indexSeq = 0
  let currentVault: string | null = null
  let unlistenFs: (() => void) | null = null
  let reindexTimer: ReturnType<typeof setTimeout> | null = null
  let attachmentRefreshTimer: ReturnType<typeof setTimeout> | null = null
  /** path → { mtime, size } for the last index/read of that note, used to skip
   * re-reading unchanged files on a re-index. Kept across vault switches. */
  const noteStatCache = new Map<string, { mtime: number; size: number }>()
  /** path → pending markdown re-index timer (coalesced per note). */
  const mdChangeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** path → latest markdown change generation; a stale read must never win. */
  const mdChangeSeq = new Map<string, number>()

  let notes: NoteSummary[] = []

  /** Index one note into a {@link NoteSummary}. Reuses the cached content when the
   * stat token is unchanged; `force` bypasses the cache for a fs-change re-index. */
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

  async function runIndex(v: string, seq: number): Promise<void> {
    deps.onIndexing(true)
    try {
      const files = await deps.fileIndex.get(v)
      if (seq !== indexSeq) return
      const results: NoteSummary[] = []
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < files.length) {
          const path = files[cursor]
          cursor += 1
          const summary = await indexNote(v, path)
          if (summary) results.push(summary)
          if (cursor % INDEX_YIELD_EVERY === 0) await yieldToMainThread()
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(INDEX_CONCURRENCY, Math.max(files.length, 1)) }, () => worker()),
      )
      if (seq !== indexSeq) return
      notes = results
      deps.onNotes(results)
      deps.onTruncated(deps.fileIndex.isTruncated(v))
      const alive = new Set(results.map((n) => n.path))
      if (deps.getFavorites().some((p) => !alive.has(p)) || deps.getRecents().some((p) => !alive.has(p))) {
        deps.onNotesPruned(
          deps.getFavorites().filter((p) => alive.has(p)),
          deps.getRecents().filter((p) => alive.has(p)),
        )
      }
    } finally {
      if (seq === indexSeq) deps.onIndexing(false)
    }
  }

  function handleFsChange(e: FsChangeEvent): void {
    const v = currentVault
    if (!v) return
    if (!isMdPath(e.path)) {
      deps.fileIndex.invalidate(v)
      if (attachmentRefreshTimer) clearTimeout(attachmentRefreshTimer)
      attachmentRefreshTimer = setTimeout(() => {
        attachmentRefreshTimer = null
        void refreshAttachmentCount(v)
      }, 200)
      return
    }
    deps.fileIndex.invalidate(v)
    const path = e.path
    const existing = mdChangeTimers.get(path)
    if (existing) clearTimeout(existing)
    const generation = (mdChangeSeq.get(path) ?? 0) + 1
    mdChangeSeq.set(path, generation)
    mdChangeTimers.set(
      path,
      setTimeout(() => {
        mdChangeTimers.delete(path)
        void applyMdChange(v, path, e.kind, generation)
      }, MD_CHANGE_DEBOUNCE_MS),
    )
  }

  async function applyMdChange(
    v: string,
    path: string,
    kind: string,
    generation: number,
  ): Promise<void> {
    if (currentVault !== v || mdChangeSeq.get(path) !== generation) return
    if (kind === 'remove') {
      notes = notes.filter((n) => n.path !== path)
      deps.cache.delete(path)
      noteStatCache.delete(path)
      await persistence.remove(path)
      deps.onNotes(notes)
      return
    }
    const summary = await indexNote(v, path, {
      force: true,
      shouldCommit: () => currentVault === v && mdChangeSeq.get(path) === generation,
    })
    if (currentVault !== v || mdChangeSeq.get(path) !== generation) return
    if (!summary) {
      notes = notes.filter((n) => n.path !== path)
      deps.onNotes(notes)
      return
    }
    const freshContent = deps.cache.get(path)
    if (freshContent !== undefined) {
      await persistence.upsert(v, path, freshContent, summary.mtime, summary.size)
    }
    notes = [...notes.filter((n) => n.path !== path), summary]
    deps.onNotes(notes)
  }

  async function refreshAttachmentCount(v: string, seq?: number): Promise<void> {
    try {
      const entries = await deps.list(v, ATTACHMENTS_DIR)
      if (seq === undefined || seq === indexSeq) deps.onAttachmentCount(entries.length)
    } catch {
      if (seq === undefined || seq === indexSeq) deps.onAttachmentCount(0)
    }
  }

  async function noteContent(path: string): Promise<string | null> {
    const cached = deps.cache.get(path)
    if (cached !== undefined) return cached
    const vault = currentVault
    if (!vault) return null
    try {
      const content = await deps.read(vault, path)
      deps.cache.set(path, content)
      return content
    } catch {
      return null
    }
  }

  async function searchRead(path: string): Promise<string> {
    const cached = deps.cache.get(path)
    if (cached !== undefined) return cached
    const vault = currentVault
    if (!vault) return ''
    try {
      const content = await deps.read(vault, path)
      deps.cache.set(path, content)
      return content
    } catch {
      return ''
    }
  }

  // The persistent search-index lifecycle. Created with closures over the
  // coordinator's own stat/cache layers so the index build reuses notes the
  // note-list indexer already read and can check staleness against the stat
  // cache. Latest-wins + detach live here; the coordinator supplies the vault.
  const persistence: IndexPersistence = createIndexPersistence({
    load: deps.loadIndex,
    save: deps.saveIndex,
    clear: deps.clearIndex,
    stat: (path) => deps.stat(currentVault ?? '', path).catch(() => null),
    read: (path) => searchRead(path),
    getStat: (path) => noteStatCache.get(path),
    onState: deps.onIndexState,
  })

  async function buildSearchIndex(v: string): Promise<void> {
    try {
      const paths = await deps.fileIndex.get(v)
      if (currentVault !== v) return
      await persistence.build(v, paths)
    } catch {
      // A background build must never reject the vault switch.
    }
  }

  async function indexVault(v: string): Promise<void> {
    detach()
    const mySeq = indexSeq
    currentVault = v
    // Do not show the previous vault's notes while the new vault is indexing.
    deps.onNotes([])
    deps.onAttachmentCount(0)
    let listener: (() => void) | null = null
    try {
      listener = await deps.onFsChange(handleFsChange)
    } catch {
      listener = null
    }
    if (mySeq !== indexSeq) {
      // Superseded by a newer vault switch while awaiting: detach our listener
      // and do not touch the vault-scoped state.
      listener?.()
      return
    }
    unlistenFs = listener
    void refreshAttachmentCount(v, mySeq)
    await runIndex(v, mySeq)
    void buildSearchIndex(v)
  }

  function detach(): void {
    indexSeq += 1
    if (reindexTimer) {
      clearTimeout(reindexTimer)
      reindexTimer = null
    }
    if (attachmentRefreshTimer) {
      clearTimeout(attachmentRefreshTimer)
      attachmentRefreshTimer = null
    }
    for (const timer of mdChangeTimers.values()) clearTimeout(timer)
    mdChangeTimers.clear()
    mdChangeSeq.clear()
    persistence.detach()
    unlistenFs?.()
    unlistenFs = null
    notes = []
    deps.onTruncated(false)
  }

  async function rebuildIndex(): Promise<void> {
    const vault = currentVault
    if (!vault) return
    try {
      await persistence.rebuild(vault, await deps.fileIndex.get(vault))
    } catch {
      // swallow — the index state reflects a failure via `stale`/`needs-rebuild`.
    }
  }

  function cancelSearchIndexBuild(): void {
    persistence.cancel()
  }

  return {
    indexVault,
    detach,
    noteContent,
    indexEntryFor: (path) => persistence.entryFor(path),
    indexCandidatePaths: (query) => persistence.candidatePaths(query),
    buildSearchIndex,
    cancelSearchIndexBuild,
    rebuildIndex,
  }
}

/** Reactive store targets the coordinator mirrors into (note list, view state,
 * index status). The default app wiring (see indexCoordinatorWiring) binds
 * these to the vault/file-tree/document-list stores. */
export interface VaultIndexCoordinatorCallbacks {
  onNotes(notes: NoteSummary[]): void
  onIndexing(indexing: boolean): void
  onTruncated(truncated: boolean): void
  onAttachmentCount(count: number): void
  onNotesPruned(favorites: string[], recents: string[]): void
  onIndexState(state: IndexState, progress: { done: number; total: number } | null): void
  getFavorites(): string[]
  getRecents(): string[]
}
