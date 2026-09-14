/**
 * Coordinates filesystem watch events into note-list and full-text index tasks
 * for the currently-open vault.
 *
 * This is the vault's application service: it composes the note-list index
 * (`vault-note-index`), the fs watch (`vault-fs-watch`), the attachment badge
 * (`vault-attachment-badge`) and the persistent search index
 * (`vault-search-index`), and it is the only one of them that knows more than
 * its own concern — the incremental path below is where a note re-read has to
 * reach the note list and the persisted index in a defined order.
 *
 * It is Vue- and Pinia-free — state changes are reported through the injected
 * callbacks so a store can mirror them into reactive refs, and the whole
 * coordinator can be driven by a memory gateway in a plain unit test.
 *
 * Lifecycle is latest-wins with an explicit detach: `indexVault` bumps a
 * generation and tears down the previous vault's subscription + pending index
 * tasks, so a superseded switch never writes stale notes into the new vault.
 * `detach()` cancels in-flight builds and clears the subscription, satisfying
 * "switching vault cancels the prior vault's index tasks and clears its
 * subscriptions".
 */

import type { ContentCache } from '../../../services/content-cache'
import type { FileEntry, FileStat, FsChangeEvent } from '../../../platform/gateways/contracts'
import type { NoteSummary } from '../../notes'
import type { IndexLookupResult } from '../../../services/content-search'
import type { IndexState, StoredIndex } from '../../search'
import { createVaultAttachmentBadge } from './vault-attachment-badge'
import { createVaultFsWatch } from './vault-fs-watch'
import { createVaultNoteChange } from './vault-note-change'
import { createVaultNoteIndex } from './vault-note-index'
import { createVaultSearchIndex } from './vault-search-index'

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
  /**
   * The fs-change subscription could not be established (`ok: false`) or was
   * established again (`ok: true`).
   *
   * This is a DEGRADED mode with no visible symptom until the user notices
   * their own file is missing from the list: without the subscription nothing
   * tells the app that a file appeared, changed or vanished, so the note list,
   * the attachment badge and the content index all keep showing what they saw
   * at index time. Silently swallowing the failure (what this did) meant the
   * app looked healthy while quietly ignoring every change made outside it.
   */
  onFsWatch?(ok: boolean, error?: unknown): void
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
  /** Candidate note paths whose indexed text contains `query`. While the fs
   *  subscription is degraded this is every indexed note: a candidate list is a
   *  filter, a filter is an exclusion, and a mirror that cannot be verified may
   *  not exclude a note the user just edited. */
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
  /** Vault session generation. `detach` bumps it; every continuation that must
   *  not write across a switch compares against it live, never against a
   *  snapshot taken before an await. Clearing `currentVault` does not make it
   *  redundant: reopening the SAME vault restores the same string, so only the
   *  bumped counter can tell a torn-down session's run from the current one. */
  let indexSeq = 0
  let currentVault: string | null = null
  let unlistenFs: (() => void) | null = null

  const noteIndex = createVaultNoteIndex({
    read: deps.read,
    stat: deps.stat,
    cache: deps.cache,
    // The fs watch reports its own state; the note-list read path asks it
    // whether a cached body may still be trusted.
    isWatcherDown: () => fsWatch.isDown(),
    onNotes: deps.onNotes,
  })

  const search = createVaultSearchIndex({
    loadIndex: deps.loadIndex,
    saveIndex: deps.saveIndex,
    clearIndex: deps.clearIndex,
    currentVault: () => currentVault,
    listPaths: (v) => deps.fileIndex.get(v),
    stat: (v, path) => deps.stat(v, path).catch(() => null),
    read: (v, path) => noteIndex.readBody(v, path),
    statOf: (path) => noteIndex.statOf(path),
    onState: deps.onIndexState,
  })

  const noteChange = createVaultNoteChange({
    notes: noteIndex,
    search,
    cache: deps.cache,
  })

  const badge = createVaultAttachmentBadge({
    list: deps.list,
    generation: () => indexSeq,
    publish: deps.onAttachmentCount,
  })

  const fsWatch = createVaultFsWatch({
    onFsChange: deps.onFsChange,
    currentVault: () => currentVault,
    generation: () => indexSeq,
    invalidateFileList: (v) => deps.fileIndex.invalidate(v),
    indexedNotesCover: (v, path) => noteIndex.covers(v, path),
    reindexAll: (v, seq) => void runIndex(v, seq),
    noteChanged: (v, path, kind, isStale) => void noteChange.apply(v, path, kind, isStale),
    attachmentChanged: (v, seq) => badge.schedule(v, seq),
    watcherStateChanged: reportWatcherState,
  })

  /** Report a change in the fs subscription to the search index and the view.
   *
   *  While the subscription is missing nothing local may claim to be current:
   *  the note stat mirror and the content cache keep whatever they saw last, so
   *  the index is told to stop voting on matches (see `entryFor`) and to report
   *  itself as stale instead of `up-to-date`. */
  function reportWatcherState(down: boolean, error?: unknown): void {
    search.setWatcherDown(down)
    deps.onFsWatch?.(!down, error)
  }

  async function runIndex(v: string, seq: number): Promise<void> {
    deps.onIndexing(true)
    try {
      const files = await deps.fileIndex.get(v)
      if (seq !== indexSeq) return
      const results = await noteIndex.indexAll(v, files)
      if (seq !== indexSeq) return
      noteIndex.replace(results)
      noteIndex.publish()
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

  async function noteContent(path: string): Promise<string | null> {
    return noteIndex.readBody(currentVault, path)
  }

  async function indexVault(v: string): Promise<void> {
    detach()
    const mySeq = indexSeq
    currentVault = v
    // Do not show the previous vault's notes while the new vault is indexing.
    noteIndex.clear()
    noteIndex.publish()
    deps.onAttachmentCount(0)
    const listener = await fsWatch.subscribe(v)
    if (mySeq !== indexSeq) {
      // Superseded by a newer vault switch while awaiting: detach our listener
      // and do not touch the vault-scoped state.
      listener?.()
      return
    }
    unlistenFs = listener
    void badge.refresh(v, mySeq)
    await runIndex(v, mySeq)
    void search.build(v)
  }

  function detach(): void {
    indexSeq += 1
    // Forget the vault, not just its subscription. `currentVault` is what every
    // port below answers "is a vault open" with, and the object stays usable
    // after detach: a held one would otherwise still read for the vault it left,
    // re-index it through `rebuildIndex` (publishing its notes into whatever
    // list is on screen now) and re-subscribe its fs watch. Defensive today —
    // the session store drops its coordinator before creating the next — but
    // detach is the function that claims to clear vault state.
    currentVault = null
    fsWatch.stop()
    badge.cancel()
    search.detach()
    unlistenFs?.()
    unlistenFs = null
    noteIndex.clear()
    deps.onTruncated(false)
  }

  async function rebuildIndex(): Promise<void> {
    const vault = currentVault
    if (!vault) return
    // Rebuild has to mean re-list: the vault file list is cached until an fs
    // event invalidates it, and a note created while the subscription was
    // missing has no event coming, so reusing the cached list would leave it
    // invisible for good — the one thing this button exists to repair.
    deps.fileIndex.invalidate(vault)
    // A missing fs subscription is invisible in the index itself, so "refresh
    // this list" is also the natural place to put it back: retry it before the
    // rebuild, and tell the user when it comes back.
    if (fsWatch.isDown()) {
      const mySeq = indexSeq
      const listener = await fsWatch.subscribe(vault)
      if (mySeq === indexSeq && listener) {
        unlistenFs?.()
        unlistenFs = listener
      }
    }
    // Catch the note list up first: content search iterates it, so a note that
    // is missing there cannot be found by any query, however fresh the index.
    const seq = indexSeq
    await runIndex(vault, seq)
    await search.rebuild(vault)
  }

  return {
    indexVault,
    detach,
    noteContent,
    indexEntryFor: (path) => search.entryFor(path),
    indexCandidatePaths: (query) => search.candidatePaths(query),
    buildSearchIndex: (v) => search.build(v),
    cancelSearchIndexBuild: () => search.cancel(),
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
  /** The fs-change subscription failed or came back (see
   *  `VaultIndexCoordinatorDeps.onFsWatch`). */
  onFsWatch(ok: boolean, error?: unknown): void
}
