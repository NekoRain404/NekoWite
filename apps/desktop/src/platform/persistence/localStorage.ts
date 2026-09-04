/**
 * `localStoragePersistencePort` — the real-browser/webview adapter.
 *
 * Thin wrap over `globalThis.localStorage`. It resolves the Storage lazily (per
 * call) so a fresh adapter can be created before `localStorage` is available, and
 * so tests that install a mock Storage mid-suite see it. Every method is wrapped
 * in try/catch: a private-mode webview, an elevated-quota profile or a throwing
 * mock must never crash a store — the write is dropped and warned, the read
 * returns the fallback.
 */

import type { PersistencePort } from './contracts'

export function localStoragePersistencePort(storage?: Storage): PersistencePort {
  function resolveStorage(): Storage | null {
    try {
      return storage ?? globalThis.localStorage ?? null
    } catch {
      return null
    }
  }

  return {
    get(key, fallback?) {
      const ls = resolveStorage()
      if (!ls) return fallback ?? null
      try {
        const v = ls.getItem(key)
        return v ?? fallback ?? null
      } catch {
        return fallback ?? null
      }
    },

    set(key, value) {
      const ls = resolveStorage()
      if (!ls) return
      try {
        ls.setItem(key, value)
      } catch (err) {
        // QuotaExceeded (large chat blobs, image data-URLs) or a disabled
        // storage: drop the write instead of throwing into the caller.
        console.warn(`[persistence] set failed for "${key}"`, err)
      }
    },

    remove(key) {
      const ls = resolveStorage()
      if (!ls) return
      try {
        ls.removeItem(key)
      } catch (err) {
        console.warn(`[persistence] remove failed for "${key}"`, err)
      }
    },

    migrate(from, to) {
      const ls = resolveStorage()
      if (!ls) return
      try {
        const v = ls.getItem(from)
        if (v === null) return
        ls.setItem(to, v)
        ls.removeItem(from)
      } catch (err) {
        console.warn(`[persistence] migrate "${from}" -> "${to}" failed`, err)
      }
    },
  }
}
