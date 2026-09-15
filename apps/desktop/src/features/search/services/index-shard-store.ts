/** Persisting an index: split it across shards, commit it, load it back.
 *
 * A save writes each shard atomically (temp blob → swap) under its own key with
 * a per-shard checksum, then writes a shard-metadata record last as the commit
 * marker — so an interrupted write never leaves a torn index. On the next load a
 * shard whose checksum no longer matches the metadata is dropped from the
 * in-memory `notes` and reported as corrupt, and the incremental build step
 * re-reads exactly those notes (a targeted shard rebuild, not a full one).
 *
 * Because that record IS what an index is, the saves of one vault are ordered
 * against each other (see {@link inWriteOrder}): two overlapping runs used to
 * race for the marker, and the loser could be the newer snapshot.
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

/** One writer per vault.
 *
 * The commit marker is what an index *is* — a load reads it and then the shards
 * it names — so two saves of one vault race for it, and with the writes
 * interleaved the run that reaches the marker last wins whether or not it holds
 * the newer state. That is how a note that is on disk, in its shard, and in the
 * in-memory mirror disappears from the persisted index: the older run's marker
 * names the shards it wrote, and the newer note's shard is left on disk with
 * nothing pointing at it.
 *
 * Ordering the writes removes the race rather than narrowing it. Each save's
 * snapshot is taken when its own writes begin, and no other write to that vault
 * — a save or a clear — can begin until it is done, so the last save to run is
 * the last to commit, and the marker always describes the state at the moment
 * its claim was earned.
 */
const writeChains = new Map<string, Promise<void>>()

function inWriteOrder<T>(vault: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(vault) ?? Promise.resolve()
  // A failed write must not block the next one, and must still reach its own
  // caller: the task runs on either settle outcome, and `result` carries the
  // failure to whoever asked for it.
  const result = previous.then(task, task)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  writeChains.set(vault, tail)
  void tail.then(() => {
    // Nothing is queued behind us: drop the chain rather than keep an entry per
    // vault this session has ever written.
    if (writeChains.get(vault) === tail) writeChains.delete(vault)
  })
  return result
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
 *  never materialised, so a small vault only touches the shards it needs.
 *
 *  Queued behind any save or clear of the same vault already running. */
export function saveIndex(
  index: StoredIndex,
  storage: AsyncIndexStorage = defaultAsyncIndexStorage(),
): Promise<void> {
  return inWriteOrder(index.vault, () => writeIndex(index, storage))
}

/** The ordered body of {@link saveIndex}: everything below runs while no other
 *  write of `index.vault` can, which is also why the snapshot is taken here —
 *  the notes are read at the moment the shards are actually written. */
async function writeIndex(index: StoredIndex, storage: AsyncIndexStorage): Promise<void> {
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
 *  Stale `.tmp` keys from an interrupted write are cleaned too.
 *
 *  Queued with the saves rather than beside them: a rebuild starts by dropping
 *  the index, and a save that was already in flight must not land its marker
 *  after the drop and put back what the rebuild is about to replace. */
export function clearIndex(
  vault: string,
  storage: AsyncIndexStorage = defaultAsyncIndexStorage(),
): Promise<void> {
  return inWriteOrder(vault, () => dropIndex(vault, storage))
}

async function dropIndex(vault: string, storage: AsyncIndexStorage): Promise<void> {
  for (const label of shardLabels()) {
    const key = indexShardKey(vault, label)
    await storage.removeItem(key)
    await storage.removeItem(`${key}.tmp`)
  }
  await storage.removeItem(indexMetaKey(vault))
  await storage.removeItem(`${indexMetaKey(vault)}.tmp`)
}
