/** Persistent, incremental full-text index for vault search.
 *
 * Compatibility surface: the implementation moved to `features/search/services/`
 * (§13.3) and split along its build / query / persistence seams — what a note
 * contributes and how the index is built, how a query answers, and how shards are
 * stored. This module re-exports all of it under the paths it has always had, so
 * no consumer changes; nothing outside the feature should import those internals
 * directly.
 *
 * Why the index exists: the note list does a live full-body scan for content
 * search, which is correct (a deep-body-only match is still found) but re-reads
 * every note on every keystroke. The index lets a search skip notes that cannot
 * match, while the full-body scan remains the source of truth for the snippet
 * (see contentSearch `searchWithIndex`).
 *
 * How it is stored: per-vault in **shards**, so a large vault never serializes
 * one huge blob. Notes are partitioned across a fixed number of shards by a
 * stable hash of their path, each shard is persisted under its own storage key
 * and carries a checksum, so a corrupted shard is detected and only that shard
 * (not the whole index) is rebuilt. A per-note version token (`mtime:size`) lets
 * a rebuild update only the notes that actually changed, and a `text` field
 * holds the lowercased haystack of every searchable field — including the full
 * body, so a deep-body match is captured by the index itself and never silently
 * dropped.
 */

/** The stored document shape and its on-disk version. */
export {
  INDEX_VERSION,
  type IndexedDoc,
  type IndexState,
  type StoredIndex,
} from '../features/search/services/index-model'

/** Shard placement and integrity. */
export {
  checksumOf,
  hashPath,
  INDEX_SHARD_COUNT,
  INDEX_SHARD_NAME_PREFIX,
  shardLabelForPath,
  shardLabels,
} from '../features/search/services/index-shards'

/** The storage seam: contracts, key scheme and the fallback/fs adapters. */
export {
  createFileIndexStorage,
  defaultAsyncIndexStorage,
  indexKey,
  indexMetaKey,
  indexShardKey,
  type AsyncIndexStorage,
  type IndexStorage,
} from '../features/search/services/index-storage'

/** Sharded load/save/clear and the atomic commit. */
export {
  clearIndex,
  loadIndex,
  saveIndex,
  type IndexShardMeta,
  type IndexShardMetaEntry,
} from '../features/search/services/index-shard-store'

/** The build/update path. */
export {
  buildIndexIncremental,
  buildSearchText,
  docToken,
  searchableText,
  type IndexBuildDeps,
  type IndexBuildOptions,
  type IndexBuildResult,
} from '../features/search/services/index-build'

/** The query path. */
export { indexStateOf, queryIndex } from '../features/search/services/index-query'
