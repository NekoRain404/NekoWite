/**
 * `filePersistencePort` — fs-backed persistence for data too large for
 * localStorage (the per-vault search index).
 *
 * Each key is written as a JSON-string value at `.nekowite/<key>.json` under the
 * authorized vault root, via the async {@link FsPort}. Writes pass `maxHistory=0`
 * so governance/state files never accumulate undo snapshots. The port is async
 * (`AsyncPersistencePort`): unlike the sync UI adapters it returns Promises and
 * a caller must await it.
 *
 * Key-to-filename encoding collapses any character that is not a filename-safe
 * `[A-Za-z0-9._-]` into `_` and trims leading/trailing separators so a key can
 * never produce a path segment that escapes the base directory.
 */

import type { FsPort } from '../gateways/contracts'
import type { AsyncPersistencePort } from './contracts'

export interface FilePersistenceOptions {
  /** Vault-relative base directory (default `.nekowite`). */
  baseDir?: string
}

const DEFAULT_BASE_DIR = '.nekowite'

/** Encode a persistence key into a single filename-safe path segment. */
export function encodePersistenceKey(key: string): string {
  const encoded = key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.+/g, '.')
  const trimmed = encoded.replace(/^[._-]+|[._-]+$/g, '')
  return trimmed || '_'
}

/** Vault-relative path for a persistence key (`.nekowite/<key>.json`). */
export function persistencePathFor(key: string, baseDir = DEFAULT_BASE_DIR): string {
  return `${baseDir}/${encodePersistenceKey(key)}.json`
}

export function filePersistencePort(fs: FsPort, vault: string, opts: FilePersistenceOptions = {}): AsyncPersistencePort {
  const baseDir = opts.baseDir ?? DEFAULT_BASE_DIR
  const pathFor = (key: string): string => persistencePathFor(key, baseDir)

  return {
    async get(key, fallback?) {
      try {
        const raw = await fs.read(vault, pathFor(key))
        return raw ?? fallback ?? null
      } catch {
        return fallback ?? null
      }
    },

    async set(key, value) {
      try {
        await fs.write(vault, pathFor(key), String(value), 0)
      } catch (err) {
        console.warn(`[persistence] fs set failed for "${key}"`, err)
      }
    },

    async remove(key) {
      try {
        await fs.deleteFile(vault, pathFor(key))
      } catch {
        // Missing file is a no-op remove.
      }
    },

    async migrate(from, to) {
      const value = await this.get(from)
      if (value === null) return
      await this.set(to, value)
      await this.remove(from)
    },
  }
}
