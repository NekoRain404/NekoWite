/**
 * The consistency path for one changed note: what an fs event does once it has
 * survived the watcher's coalescing.
 *
 * The change has to reach two places - the note-list mirror and the persistent
 * search index - and the order is load-bearing in one direction: the note list
 * is published only AFTER the persistent entry has been written, because
 * content search builds its candidate set from the note list and would
 * otherwise be handed a note the index cannot answer for. A removal runs the
 * same way round: the mirror drops the note, the entry goes, then the list is
 * published.
 *
 * `isStale` is the watcher's coalescing guard (a newer event for the same path,
 * or a vault switch). It is re-checked after every await because the note is
 * read from disk in between: a read that resolves after its event was
 * superseded must write nothing at all - not the shared content cache, not the
 * stat snapshot, not the mirror, not the index.
 */

import type { ContentCache } from '../../../services/contentCache'
import type { FsChangeKind } from '../../../platform/gateways/contracts'
import type { VaultNoteIndex } from './vault-note-index'
import type { VaultSearchIndex } from './vault-search-index'

export interface VaultNoteChangeDeps {
  /** The note-list mirror and its single-note reader. */
  notes: Pick<VaultNoteIndex, 'indexNote' | 'upsert' | 'remove' | 'forget' | 'publish'>
  /** The persistent index, one note at a time. */
  search: Pick<VaultSearchIndex, 'upsertNote' | 'removeNote'>
  /** Shared content cache: the body the note-list index just read. */
  cache: ContentCache
}

export interface VaultNoteChange {
  /** Apply one coalesced markdown fs change to the note list and the persistent
   *  index. */
  apply(vault: string, path: string, kind: FsChangeKind, isStale: () => boolean): Promise<void>
}

export function createVaultNoteChange(deps: VaultNoteChangeDeps): VaultNoteChange {
  async function apply(
    vault: string,
    path: string,
    kind: FsChangeKind,
    isStale: () => boolean,
  ): Promise<void> {
    if (isStale()) return
    if (kind === 'removed') {
      deps.notes.forget(path)
      await deps.search.removeNote(path)
      deps.notes.publish()
      return
    }
    const summary = await deps.notes.indexNote(vault, path, {
      force: true,
      shouldCommit: () => !isStale(),
    })
    if (isStale()) return
    if (!summary) {
      // Unreadable (deleted between the event and the read, or a permission
      // change): the note list must not keep advertising it. The content cache
      // keeps its body - a failed read says nothing about a body that was read
      // successfully before.
      deps.notes.remove(path)
      deps.notes.publish()
      return
    }
    const freshContent = deps.cache.get(path)
    if (freshContent !== undefined) {
      await deps.search.upsertNote(vault, path, freshContent, summary.mtime, summary.size)
    }
    deps.notes.upsert(summary)
    deps.notes.publish()
  }

  return { apply }
}
