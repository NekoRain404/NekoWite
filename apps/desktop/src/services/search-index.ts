/**
 * Compatibility surface, ONE stage only (§10.1.5).
 *
 * The implementation moved to `features/search/services/` (§13.3) and split
 * along its build / query / persistence seams. This module keeps the old
 * `services/searchIndex` path resolving so an import this change did not reach
 * cannot break, and is deleted with the rest of the compatibility layer once
 * nothing imports it.
 *
 * It re-exports through `features/search` — the feature's public entry point —
 * rather than reaching into its service files. The list below is therefore the
 * compatibility contract as a whole: a helper the feature shares internally
 * cannot leak out here by accident, and a name dropped from either surface is a
 * failing typecheck rather than a silent absence. What the index is, why it
 * exists and how it is stored is documented there.
 *
 * Nothing outside the search feature should import its internals directly: new
 * callers go through `features/search`, which exports the same names.
 */

/** The stored document shape and its on-disk version. */
export {
  INDEX_VERSION,
  type IndexedDoc,
  type IndexState,
  type StoredIndex,
} from '../features/search'

/** Shard placement and integrity. */
export {
  checksumOf,
  hashPath,
  INDEX_SHARD_COUNT,
  INDEX_SHARD_NAME_PREFIX,
  shardLabelForPath,
  shardLabels,
} from '../features/search'

/** The storage seam: contracts, key scheme and the fallback/fs adapters. */
export {
  createFileIndexStorage,
  defaultAsyncIndexStorage,
  indexKey,
  indexMetaKey,
  indexShardKey,
  type AsyncIndexStorage,
  type IndexStorage,
} from '../features/search'

/** Sharded load/save/clear and the atomic commit. */
export {
  clearIndex,
  loadIndex,
  saveIndex,
  type IndexShardMeta,
  type IndexShardMetaEntry,
} from '../features/search'

/** The build/update path. */
export {
  buildIndexIncremental,
  buildSearchText,
  docToken,
  searchableText,
  type IndexBuildDeps,
  type IndexBuildOptions,
  type IndexBuildResult,
} from '../features/search'

/** The query path. */
export { indexStateOf, queryIndex } from '../features/search'
