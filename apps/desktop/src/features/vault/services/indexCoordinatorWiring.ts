/**
 * Application wiring for the vault index coordinator.
 *
 * Binds the Vue-free coordinator to the real platform services (fs gateway,
 * vault file index, shared content cache and the persistent search-index
 * storage). The store imports this factory so it never depends on a gateway
 * directly (see §5.6.2: a store must have 0 platform/gateway dependencies and
 * go through an application service). Tests drive `createVaultIndexCoordinator`
 * directly with a memory gateway and never touch this module.
 */

import { contentCache } from '../../../services/contentCache'
import { fsService } from '../../../platform/gateways/fs'
import { clearIndex, loadIndex, saveIndex } from '../../../services/searchIndex'
import { vaultFileIndex } from '../../../services/vaultFiles'
import {
  createVaultIndexCoordinator,
  type VaultIndexCoordinator,
  type VaultIndexCoordinatorCallbacks,
} from './vaultIndexCoordinator'

export function createBoundVaultIndexCoordinator(
  callbacks: VaultIndexCoordinatorCallbacks,
): VaultIndexCoordinator {
  return createVaultIndexCoordinator({
    read: (v, p) => fsService.read(v, p),
    stat: (v, p) => fsService.stat(v, p),
    list: (v, d) => fsService.list(v, d),
    onFsChange: (cb) => fsService.onFsChange(cb),
    fileIndex: {
      get: (v) => vaultFileIndex.get(v),
      isTruncated: (v) => vaultFileIndex.isTruncated(v),
      invalidate: (v) => vaultFileIndex.invalidate(v),
    },
    cache: contentCache,
    loadIndex: (v) => loadIndex(v),
    saveIndex: (i) => saveIndex(i),
    clearIndex: (v) => clearIndex(v),
    onNotes: callbacks.onNotes,
    onIndexing: callbacks.onIndexing,
    onTruncated: callbacks.onTruncated,
    onAttachmentCount: callbacks.onAttachmentCount,
    onNotesPruned: callbacks.onNotesPruned,
    onIndexState: callbacks.onIndexState,
    getFavorites: callbacks.getFavorites,
    getRecents: callbacks.getRecents,
  })
}
