/** Where a vault's index shards live, and the seam that abstracts them.
 *
 * The shard store reads and writes through {@link AsyncIndexStorage}; this
 * module owns the two implementations and the key scheme they agree on. The
 * wiring (`indexCoordinatorWiring.ts`) picks the backend by environment: an
 * fs-backed store (`createFileIndexStorage`) writing each shard to a
 * `.nekowite/index/` JSON file via the async {@link FsPort} in Tauri, else the
 * localStorage sharded store as a NON-authoritative fallback (the browser demo
 * / tests).
 *
 * The fs-backed store maps the meta/shard keys to
 * `.nekowite/index/{manifest,shard-NN}.json`, keeping the same atomic temp→swap
 * the shard store uses (via `<file>.tmp`).
 */

import type { FsPort } from '../../../platform/gateways/contracts'
import { INDEX_SHARD_NAME_PREFIX } from './index-shards'

/** Synchronous string storage (localStorage / memory fallback). Used internally
 *  by the default async adapter; the public index functions accept the async
 *  {@link AsyncIndexStorage}. */
export interface IndexStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Async string storage for the sharded index. Implemented by the fs-backed
 *  `.nekowite/index/` store and by the localStorage fallback; `loadIndex` /
 *  `saveIndex` / `clearIndex` are async over this interface. */
export interface AsyncIndexStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

const LS_PREFIX = 'nekowite.searchIndex.v2'

/** In-memory fallback used when localStorage is unavailable (some test envs). */
const memoryStorage: IndexStorage = (() => {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, String(v))
    },
    removeItem: (k) => {
      store.delete(k)
    },
  }
})()

function defaultStorage(): IndexStorage {
  try {
    const ls = globalThis.localStorage
    if (ls) return ls
  } catch {
    // ignore — fall through to memory
  }
  return memoryStorage
}

/** The default async store: a thin promise wrapper over the sync localStorage /
 *  memory store. This is the NON-authoritative fallback used by the browser demo
 *  and tests; Tauri uses {@link createFileIndexStorage} instead. */
export function defaultAsyncIndexStorage(): AsyncIndexStorage {
  const sync = defaultStorage()
  return {
    getItem: async (key) => sync.getItem(key),
    setItem: async (key, value) => {
      sync.setItem(key, value)
    },
    removeItem: async (key) => {
      sync.removeItem(key)
    },
  }
}

/** Storage key for the shard-metadata (commit) record of `vault`. */
export function indexMetaKey(vault: string): string {
  return `${LS_PREFIX}.${vault}.meta`
}

/** Storage key for one shard of `vault`'s index. */
export function indexShardKey(vault: string, label: string): string {
  return `${LS_PREFIX}.${vault}.${INDEX_SHARD_NAME_PREFIX}${label}`
}

/** Back-compat alias for the index's primary (metadata) key. */
export function indexKey(vault: string): string {
  return indexMetaKey(vault)
}

/** Vault-relative path of a key within `.nekowite/index/`. The metadata record is
 *  always `manifest.json`; each shard is `shard-<label>.json`; a staged atomic
 *  write uses a `<file>.tmp` sibling. */
function filePathForIndexKey(key: string, baseDir: string): string {
  const isTmp = key.endsWith('.tmp')
  const base = isTmp ? key.slice(0, -'.tmp'.length) : key
  let name: string
  if (base.endsWith('.meta')) {
    name = 'manifest.json'
  } else {
    const marker = '2048-shard-'
    const idx = base.lastIndexOf(marker)
    name = `shard-${idx >= 0 ? base.slice(idx + marker.length) : encodeURIComponent(base)}.json`
  }
  return `${baseDir}/${name}${isTmp ? '.tmp' : ''}`
}

/** fs-backed shard storage: one JSON file per shard plus a `manifest.json` under
 *  `.nekowite/index/`, written via the async {@link FsPort}. Writes pass
 *  `maxHistory=0` so an index shard never accumulates undo snapshots. A missing
 *  or unreadable file reads as `null` (so a load flags it corrupt and the
 *  incremental build re-reads exactly those notes). */
export function createFileIndexStorage(fs: FsPort, vault: string, baseDir = '.nekowite/index'): AsyncIndexStorage {
  const fileFor = (key: string): string => filePathForIndexKey(key, baseDir)
  return {
    async getItem(key) {
      try {
        return await fs.read(vault, fileFor(key))
      } catch {
        return null
      }
    },
    async setItem(key, value) {
      await fs.write(vault, fileFor(key), String(value), 0)
    },
    async removeItem(key) {
      try {
        await fs.deleteFile(vault, fileFor(key))
      } catch {
        // Missing file is a no-op remove.
      }
    },
  }
}
