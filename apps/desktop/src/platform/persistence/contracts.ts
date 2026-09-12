/**
 * Persistence port (P2.3).
 *
 * A narrow capability for reading/writing string values under a key, so an
 * application module (a Pinia store, a service) can persist UI/session state
 * without depending on a concrete backend. It is deliberately sync — localStorage
 * and in-memory stores are synchronous — so reactive stores can read/write
 * directly inside a watcher or ref initializer. Larger, async persisted data
 * (the per-vault search index, see `services/searchIndex`) lives behind the
 * async `AsyncPersistencePort`/`filePersistencePort` adapter instead.
 *
 * The sync port is a string-keyed KV store (like `localStorage`), so swapping an
 * adapter never changes a store's read/write pattern. Each adapter degrades
 * safely: a quota error, a disabled webview storage or a corrupt read never
 * throws — it falls back to the default and warns.
 *
 * Direction (see docs/dev.md §5.3): `services`/`features`/`stores` may import
 * `platform`; `platform` must never import back into them.
 */

/** Sync string-keyed persistence (localStorage / memory). */
export interface PersistencePort {
  /** Read the value for `key`. Returns `fallback` (or null when omitted) when
   * the key is missing, unreadable, or the underlying storage threw. */
  get(key: string, fallback?: string): string | null
  /**
   * Write `value` for `key`. Never throws: a quota/unavailable storage warns
   * and drops the write.
   *
   * Returns whether the value actually landed. `false` is the ONLY signal a
   * caller gets that its data is not on disk - the port cannot throw without
   * taking the caller (often a reactive watcher) down with it - so a caller
   * that owns user data must check it and decide what to shed: the chat store
   * retries without images and tells the user, because a conversation that
   * vanishes while the write reported success is the worst possible outcome.
   */
  set(key: string, value: string): boolean
  /** Delete `key`. Never throws. */
  remove(key: string): void
  /** Move a value from one key to another, dropping the source. Used by a domain
   * migration's key-rename step; a missing source is a no-op. */
  migrate(from: string, to: string): void
}

/**
 * Async string-keyed persistence. Implemented by the fs-backed
 * `filePersistencePort` (`.nekowite/` JSON files via the async {@link FsPort});
 * it is the storage surface for persisted data large enough to warrant files
 * instead of localStorage (the per-vault search index shards).
 */
export interface AsyncPersistencePort {
  get(key: string, fallback?: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  migrate(from: string, to: string): Promise<void>
}
