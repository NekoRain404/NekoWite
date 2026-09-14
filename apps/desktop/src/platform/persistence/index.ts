/**
 * Persistence adapter composition.
 *
 * `createPersistence()` builds the sync {@link PersistencePort} for the current
 * environment. The backend is resolved lazily (per call) so a module-singleton
 * created at import time still sees a `localStorage` that is only defined later
 * (the vitest setup defines `window.localStorage` in a `beforeAll` hook, after
 * module evaluation): as soon as `globalThis.localStorage` is available the
 * localStorage adapter is used; otherwise it degrades to the in-memory adapter
 * so the port is never quiescent. This mirrors the gateway environment
 * autodetection in `platform/gateways` while keeping the sync port thin.
 *
 * The fs-backed async adapter (`filePersistencePort`) is exposed separately so
 * large-data callers (the per-vault search index) opt in.
 */

import type { PersistencePort } from './contracts'
import { localStoragePersistencePort } from './local-storage'
import { memoryPersistencePort } from './memory'

export function createPersistence(): PersistencePort {
  const memory = memoryPersistencePort()
  let ls: PersistencePort | null = null

  function backend(): PersistencePort {
    try {
      if (globalThis.localStorage) {
        if (!ls) ls = localStoragePersistencePort()
        return ls
      }
    } catch {
      // fall through to memory
    }
    return memory
  }

  return {
    get: (key, fallback) => backend().get(key, fallback),
    set: (key, value) => backend().set(key, value),
    remove: (key) => backend().remove(key),
    migrate: (from, to) => backend().migrate(from, to),
  }
}

export { localStoragePersistencePort } from './local-storage'
export { memoryPersistencePort } from './memory'
export { filePersistencePort, encodePersistenceKey, persistencePathFor } from './file'
export type { PersistencePort, AsyncPersistencePort } from './contracts'
