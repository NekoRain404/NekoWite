import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createBoundVaultIndexCoordinator } from '../features/vault/services/indexCoordinatorWiring'
import { notifyError } from '../services/errors'
import { t } from '../i18n'
import type { VaultIndexCoordinator } from '../features/vault/services/vaultIndexCoordinator'
import type { IndexLookupResult } from '../services/contentSearch'
import { useDocumentListStore } from './documentList'
import { useFileTreeStore } from './fileTree'

/**
 * Vault session store: which vault is open and the switch lifecycle.
 *
 * It owns no file/index logic — the vault index coordinator (an application
 * service) does the watcher subscription, note indexing and search-index build.
 * This store mirrors the coordinator's callbacks into the document-list and
 * file-tree stores, resets those on switch and delegates the read helpers
 * (`noteContent`, `indexEntryFor`, `indexCandidatePaths`) used by content search.
 *
 * A switch is latest-wins: the previous coordinator is `detach`ed (cancelling its
 * in-flight index tasks and clearing its fs subscription) before the new one is
 * created, so a stale vault can never write results into the new one.
 */
export const useVaultSessionStore = defineStore('vaultSession', () => {
  const vault = ref<string | null>(null)
  let coordinator: VaultIndexCoordinator | null = null

  function indexVault(path: string): Promise<void> {
    const doc = useDocumentListStore()
    const tree = useFileTreeStore()
    // Teardown any prior vault's coordinator before switching: cancel its index
    // tasks and clear its fs subscription (latest-wins / no stale results).
    coordinator?.detach()
    coordinator = null
    // `resetForVault` also activates THIS vault's favorites/recents bucket: the
    // previous vault's entries stay in storage (they belong to it) and the new
    // vault starts from its own list.
    doc.resetForVault(path)
    tree.resetForVault()
    vault.value = path
    const next = createBoundVaultIndexCoordinator({
      onNotes: (notes) => doc.setNotes(notes),
      onIndexing: (v) => doc.setIndexing(v),
      onTruncated: (v) => tree.setVaultTruncated(v),
      onAttachmentCount: (n) => tree.setAttachmentCount(n),
      onNotesPruned: (favs, recents) => doc.setFavoritesRecents(favs, recents),
      onIndexState: (state, progress) => doc.setIndexState(state, progress),
      getFavorites: () => doc.favorites,
      getRecents: () => doc.recents,
      onFsWatch: (ok, error) => {
        // The list, the attachment badge and the content index all stop
        // tracking the disk when this subscription is missing, and nothing on
        // screen would look different. Say so, and say what brings it back.
        if (ok) {
          notifyError(t('tabs.watchRestored'))
          return
        }
        console.error('[NekoWite] vault watch failed', error)
        notifyError(t('tabs.watchFailed'))
      },
    })
    coordinator = next
    return next.indexVault(path)
  }

  function detachVault(): void {
    const doc = useDocumentListStore()
    const tree = useFileTreeStore()
    coordinator?.detach()
    coordinator = null
    vault.value = null
    doc.resetForVault(null)
    tree.resetForVault()
  }

  return {
    vault,
    indexVault,
    detachVault,
    buildSearchIndex: (vaultPath: string): Promise<void> =>
      coordinator?.buildSearchIndex(vaultPath) ?? Promise.resolve(),
    cancelSearchIndexBuild: (): void => coordinator?.cancelSearchIndexBuild(),
    rebuildIndex: (): Promise<void> => coordinator?.rebuildIndex() ?? Promise.resolve(),
    indexEntryFor: (path: string): IndexLookupResult | null => coordinator?.indexEntryFor(path) ?? null,
    indexCandidatePaths: (query: string): string[] => coordinator?.indexCandidatePaths(query) ?? [],
    noteContent: (path: string): Promise<string | null> =>
      coordinator?.noteContent(path) ?? Promise.resolve(null),
  }
})
