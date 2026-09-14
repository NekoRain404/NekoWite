/**
 * The open vault's persistent full-text index: it owns the
 * {@link IndexPersistence} instance, builds it from the vault's file list,
 * rebuilds it from scratch, keeps single notes in step with it, and answers
 * what content search reads (`entryFor`, `candidatePaths`).
 *
 * It is vault-scoped on purpose. Every command takes the vault it is meant for
 * and drops out when a switch has already moved on, because the build runs in
 * the background across awaits and a superseded one must not publish state for
 * a vault that is no longer open. The read it gets from the caller is the
 * note-list index's reader, so the index build reuses notes that were already
 * read and checks staleness against the same stat snapshot.
 *
 * Degraded mode is inherited, not decided here: while the fs watch is down
 * (`setWatcherDown`) the index may not answer "cannot match" on its own and may
 * not call itself `up-to-date` (see `IndexPersistence`), and the reader the
 * caller injects falls back to the disk for the same reason.
 */

import type { FileStat } from '../../../platform/gateways/contracts'
import type { IndexLookupResult } from '../../../services/content-search'
import type { IndexState, StoredIndex } from '../../../services/search-index'
import { createIndexPersistence, type IndexPersistence } from './index-persistence'
import type { NoteStat } from './vault-note-index'

export interface VaultSearchIndexDeps {
  /** Load the persisted index for `vault`, or null when none/unchanged. */
  loadIndex(vault: string): Promise<StoredIndex | null>
  /** Persist the index (atomic blob write). */
  saveIndex(index: StoredIndex): Promise<void>
  /** Drop the persisted index for `vault`. */
  clearIndex(vault: string): Promise<void>
  /** The vault that is open right now, or null after `detach`. */
  currentVault(): string | null
  /** List the vault's note paths (the caller re-lists on rebuild). */
  listPaths(vault: string): Promise<string[]>
  /** Stat one note for the incremental reconcile (null when unreadable). */
  stat(vault: string, path: string): Promise<FileStat | null>
  /** Read one note body for the index; null when it cannot be read, which
   *  indexes as empty text rather than failing the build. */
  read(vault: string | null, path: string): Promise<string | null>
  /** The note-list index's stat snapshot, for the `up-to-date` decision. */
  statOf(path: string): NoteStat | undefined
  /** Report state/progress transitions to the reactive layer. */
  onState(state: IndexState, progress: { done: number; total: number } | null): void
}

export interface VaultSearchIndex {
  /** Build (or incrementally reconcile) the index for `vault`. No-op when a
   *  switch has already moved on. A background build never rejects. */
  build(vault: string): Promise<void>
  /** Re-list `vault` and rebuild from scratch (the user's "refresh" command). */
  rebuild(vault: string): Promise<void>
  /** Persist one changed note's entry in place. */
  upsertNote(vault: string, path: string, content: string, mtime: number, size: number): Promise<void>
  /** Drop a removed note's entry from the index. */
  removeNote(path: string): Promise<void>
  /** Cancel an in-flight build without touching the mirror. */
  cancel(): void
  /** Report that the fs-change subscription is down (degraded) or back. */
  setWatcherDown(down: boolean): void
  /** Cancel in-flight work and clear the mirror + state (vault switch). */
  detach(): void
  /** Look up a note's entry for content search. */
  entryFor(path: string): IndexLookupResult | null
  /** Candidate note paths whose indexed text contains `query`. */
  candidatePaths(query: string): string[]
}

export function createVaultSearchIndex(deps: VaultSearchIndexDeps): VaultSearchIndex {
  const persistence: IndexPersistence = createIndexPersistence({
    load: deps.loadIndex,
    save: deps.saveIndex,
    clear: deps.clearIndex,
    stat: (path) => deps.stat(deps.currentVault() ?? '', path).catch(() => null),
    read: async (path) => (await deps.read(deps.currentVault(), path)) ?? '',
    getStat: (path) => deps.statOf(path),
    onState: deps.onState,
  })

  async function build(vault: string): Promise<void> {
    try {
      const paths = await deps.listPaths(vault)
      if (deps.currentVault() !== vault) return
      await persistence.build(vault, paths)
    } catch {
      // A background build must never reject the vault switch.
    }
  }

  async function rebuild(vault: string): Promise<void> {
    try {
      await persistence.rebuild(vault, await deps.listPaths(vault))
    } catch {
      // swallow — the index state reflects a failure via `stale`/`needs-rebuild`.
    }
  }

  return {
    build,
    rebuild,
    upsertNote: (vault, path, content, mtime, size) =>
      persistence.upsert(vault, path, content, mtime, size),
    removeNote: (path) => persistence.remove(path),
    cancel: () => persistence.cancel(),
    setWatcherDown: (down) => persistence.setWatcherDown(down),
    detach: () => persistence.detach(),
    entryFor: (path) => persistence.entryFor(path),
    candidatePaths: (query) => persistence.candidatePaths(query),
  }
}
