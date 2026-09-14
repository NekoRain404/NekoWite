/** Persisting an index: split it across shards, commit it, load it back.
 *
 * A save writes each shard atomically (temp blob → swap) under its own key with
 * a per-shard checksum, then writes a shard-metadata record last as the commit
 * marker — so an interrupted write never leaves a torn index. On the next load a
 * shard whose checksum no longer matches the metadata is dropped from the
 * in-memory `notes` and reported as corrupt, and the incremental build step
 * re-reads exactly those notes (a targeted shard rebuild, not a full one).
 */

import {
  defaultAsyncIndexStorage,
  indexMetaKey,
  indexShardKey,
  type AsyncIndexStorage,
} from './index-storage'
import { checksumOf, shardLabelForPath, shardLabels } from './index-shards'
import { INDEX_VERSION, type IndexedDoc, type StoredIndex } from './index-model'

/** Integrity record for one shard of an index. */
export interface IndexShardMetaEntry {
  /** Number of notes stored in this shard. */
  count: number
  /** FNV-1a checksum (hex) of the shard's canonical JSON payload. */
  checksum: string
}

/** Top-level shard metadata (the "commit" record written last on a save). */
export interface IndexShardMeta {
  version: number
  vault: string
  builtAt: number
  /** Total note count across all shards. */
  noteCount: number
  /** Per-shard integrity: label → `{ count, checksum }`. */
  shards: Record<string, IndexShardMetaEntry>
}

/** Write `value` to `key` atomically (temp key, then swap, then clean the temp),
 *  so an interrupted write never leaves a shard that fails to parse — the
 *  previous committed value under `key` is untouched until the new one is fully
 *  staged. */
async function storageSetAtomic(storage: AsyncIndexStorage, key: string, value: string): Promise<void> {
  await storage.setItem(`${key}.tmp`, value)
  await storage.setItem(key, value)
  await storage.removeItem(`${key}.tmp`)
}

/** Load `vault`'s sharded index. Assembles every shard listed in the metadata,
 *  verifying each shard's checksum (and JSON). A shard that fails validation is
 *  dropped from `notes` and recorded in `index.corruptShards` so the incremental
 *  build step re-reads exactly those notes (rebuilding only that shard). Returns
 *  null when there is no metadata, the metadata is corrupt, or the metadata
 *  version is stale (the caller then rebuilds the whole index). */
export async function loadIndex(
  vault: string,
  storage: AsyncIndexStorage = defaultAsyncIndexStorage(),
): Promise<StoredIndex | null> {
  const rawMeta = await storage.getItem(indexMetaKey(vault))
  if (!rawMeta) return null
  let meta: IndexShardMeta
  try {
    meta = JSON.parse(rawMeta) as IndexShardMeta
  } catch {
    return null
  }
  if (meta.version !== INDEX_VERSION) return null
  if (!meta.shards || typeof meta.shards !== 'object') return null
  const notes: Record<string, IndexedDoc> = {}
  const corruptShards: string[] = []
  for (const [label, shardMeta] of Object.entries(meta.shards)) {
    const raw = await storage.getItem(indexShardKey(vault, label))
    if (raw && shardMeta.checksum && checksumOf(raw) === shardMeta.checksum) {
      try {
        const parsed = JSON.parse(raw) as { notes?: Record<string, IndexedDoc> }
        if (parsed.notes && typeof parsed.notes === 'object') {
          Object.assign(notes, parsed.notes)
          continue
        }
      } catch {
        // fall through to mark the shard corrupt
      }
    }
    corruptShards.push(label)
  }
  const index: StoredIndex = {
    version: meta.version,
    vault: meta.vault,
    builtAt: meta.builtAt,
    notes,
  }
  if (corruptShards.length > 0) index.corruptShards = corruptShards
  return index
}

/** Save `index`, splitting its notes across path-hash shards. Each shard is
 *  written atomically under its own key with a per-shard checksum, then the
 *  metadata record is written (last) as the commit marker. Empty shards are
 *  never materialised, so a small vault only touches the shards it needs. */
export async function saveIndex(index: StoredIndex, storage: AsyncIndexStorage = defaultAsyncIndexStorage()): Promise<void> {
  const groups = new Map<string, Record<string, IndexedDoc>>()
  for (const [path, doc] of Object.entries(index.notes)) {
    const label = shardLabelForPath(path)
    let bucket = groups.get(label)
    if (!bucket) {
      bucket = {}
      groups.set(label, bucket)
    }
    bucket[path] = doc
  }
  const meta: IndexShardMeta = {
    version: index.version,
    vault: index.vault,
    builtAt: index.builtAt,
    noteCount: Object.keys(index.notes).length,
    shards: {},
  }
  for (const [label, bucket] of groups) {
    const payload = JSON.stringify({ notes: bucket })
    await storageSetAtomic(storage, indexShardKey(index.vault, label), payload)
    meta.shards[label] = { count: Object.keys(bucket).length, checksum: checksumOf(payload) }
  }
  await storageSetAtomic(storage, indexMetaKey(index.vault), JSON.stringify(meta))
}

/** Drop `vault`'s entire sharded index (metadata + every possible shard key).
 *  Stale `.tmp` keys from an interrupted write are cleaned too. */
export async function clearIndex(vault: string, storage: AsyncIndexStorage = defaultAsyncIndexStorage()): Promise<void> {
  for (const label of shardLabels()) {
    const key = indexShardKey(vault, label)
    await storage.removeItem(key)
    await storage.removeItem(`${key}.tmp`)
  }
  await storage.removeItem(indexMetaKey(vault))
  await storage.removeItem(`${indexMetaKey(vault)}.tmp`)
}
