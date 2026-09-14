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

import { contentCache } from '../../../services/content-cache'
import { fsService } from '../../../platform/gateways/fs'
import {
  clearIndex,
  createFileIndexStorage,
  defaultAsyncIndexStorage,
  loadIndex,
  saveIndex,
  type AsyncIndexStorage,
} from '../../../services/search-index'
import { vaultFileIndex } from '../../../services/vault-files'
import {
  createVaultIndexCoordinator,
  type VaultIndexCoordinator,
  type VaultIndexCoordinatorCallbacks,
} from './vault-index-coordinator'

/** True when running under Tauri (the fs-backed `.nekowite/index/` store is then
 *  the authoritative shard source). In the browser demo / memory tests the shard
 *  store falls back to the NON-authoritative localStorage sharded cache. */
function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  )
}

/** Per-vault async shard storage: fs-backed files in Tauri, localStorage cache
 *  otherwise. */
function indexStorageFor(vault: string): AsyncIndexStorage {
  return isTauriEnv() ? createFileIndexStorage(fsService, vault) : defaultAsyncIndexStorage()
}

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
    loadIndex: (v) => loadIndex(v, indexStorageFor(v)),
    saveIndex: (i) => saveIndex(i, indexStorageFor(i.vault)),
    clearIndex: (v) => clearIndex(v, indexStorageFor(v)),
    onNotes: callbacks.onNotes,
    onIndexing: callbacks.onIndexing,
    onTruncated: callbacks.onTruncated,
    onAttachmentCount: callbacks.onAttachmentCount,
    onNotesPruned: callbacks.onNotesPruned,
    onIndexState: callbacks.onIndexState,
    getFavorites: callbacks.getFavorites,
    getRecents: callbacks.getRecents,
    onFsWatch: callbacks.onFsWatch,
  })
}
