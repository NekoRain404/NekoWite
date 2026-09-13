/**
 * `memoryPersistencePort` — pure in-memory adapter for tests and the browser
 * demo. Identical semantics to the localStorage adapter (string KV, safe
 * degrade) backed by a Map, so a store can run against it in a unit test and a
 * later adapter swap needs no store change.
 */

import type { PersistencePort } from './contracts'

export function memoryPersistencePort(): PersistencePort {
  const store = new Map<string, string>()

  return {
    get(key, fallback?) {
      if (!store.has(key)) return fallback ?? null
      return store.get(key)!
    },

    set(key, value) {
      // A Map cannot fail, but the storage-budget semantics are the same: the
      // adapter reports whether the write landed (see `PersistencePort.set`).
      store.set(key, String(value))
      return true
    },

    remove(key) {
      store.delete(key)
    },

    migrate(from, to) {
      if (!store.has(from)) return
      store.set(to, store.get(from)!)
      store.delete(from)
    },
  }
}
