/**
 * Shared persistence surface + versioned-domain helper (P2.3).
 *
 * `persistence` is the single sync {@link PersistencePort} the application
 * resolves through. It is the only place a store/service reaches for a global
 * string-keyed store; `platform/persistence` owns the adapters and the
 * environment selection.
 *
 * `createDomainPersister` wraps a single-key, single-object domain (appearance,
 * window state, chat sessions, ...) with a per-domain schema `version` and a
 * `migrate()` that runs on load: a stored blob carrying an older version is
 * pulled forward through the registered migration chain (schema bump) and any
 * key-rename migration (port `migrate(from, to)`) is applied before the value is
 * parsed. Corruption never throws — the `parse` failure falls back to `defaults`.
 *
 * The domains that use many scalar keys (settings) go through the port directly
 * (`persistence.get/set`), preserving their legacy per-key format; the domain
 * versioning is a property of the single-object domains that can carry a schema.
 */

import { createPersistence, type PersistencePort } from '../platform/persistence'

/** The shared sync persistence instance (localStorage when available, else
 *  memory). Stores import this instead of touching `localStorage` directly. */
export const persistence: PersistencePort = createPersistence()

function defaultStoredVersion(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { _v?: unknown }
    return typeof parsed?._v === 'number' ? parsed._v : 1
  } catch {
    return 1
  }
}

export interface DomainPersister<T> {
  /** Read + parse + migrate the stored value; returns `defaults` on none/corrupt. */
  load(): T
  /** Serialize + write the value (never throws). */
  save(value: T): void
  /** The current schema version for this domain. */
  readonly version: number
}

export interface DomainOptions<T> {
  /** Primary storage key. */
  key: string
  /** Current schema version. */
  version: number
  /** Fresh default value. */
  defaults: () => T
  /** Parse a raw string to a value, or null when corrupt/unknown. */
  parse: (raw: string) => T | null
  /** Serialize a value to a string. */
  serialize: (value: T) => string
  /** Detect a stored blob's schema version (default: `_v` field, else 1). */
  storedVersion?: (raw: string) => number
  /** Migration chain: `from` version → transform the raw string one version.
   *  Runs until the stored version reaches `version`. */
  migrations?: Record<number, (raw: string) => string>
  /** Legacy keys this domain was previously stored under; pulled forward via a
   *  port `migrate(from, to)` key rename on load. */
  migratedFrom?: string[]
}

export function createDomainPersister<T>(
  port: PersistencePort,
  cfg: DomainOptions<T>,
): DomainPersister<T> {
  const versionOf = cfg.storedVersion ?? defaultStoredVersion

  function load(): T {
    if (cfg.migratedFrom) {
      for (const from of cfg.migratedFrom) port.migrate(from, cfg.key)
    }
    const raw = port.get(cfg.key)
    if (raw === null) return cfg.defaults()
    let value = raw
    let v = versionOf(value)
    let migrated = false
    while (v < cfg.version) {
      const step = cfg.migrations?.[v]
      if (!step) break
      value = step(value)
      v += 1
      migrated = true
    }
    if (migrated) {
      try {
        port.set(cfg.key, value)
      } catch {
        // A migration must never throw up into the caller.
      }
    }
    try {
      return cfg.parse(value) ?? cfg.defaults()
    } catch {
      return cfg.defaults()
    }
  }

  function save(value: T): void {
    try {
      port.set(cfg.key, cfg.serialize(value))
    } catch {
      // A quota/unavailable storage must never throw up into the caller.
    }
  }

  return { load, save, version: cfg.version }
}
