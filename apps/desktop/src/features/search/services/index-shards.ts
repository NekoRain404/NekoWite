/** How a vault's notes are partitioned across index shards, and how a shard's
 *  integrity is proved.
 *
 * The index is stored in shards so a large vault never serializes one huge
 * blob. A note's shard is chosen by a stable hash of its path, so the same note
 * always lands in the same shard regardless of insertion order, and every shard
 * payload carries a checksum so a corrupted/torn shard is detected at load and
 * only that shard — never the whole index — is rebuilt.
 */

/** Number of path-hash shards an index is split across. A vault with few notes
 *  only materialises the shards that actually contain a note. */
export const INDEX_SHARD_COUNT = 16

/** Shard name prefix, e.g. `2048-shard-a`. A note's shard label is derived from
 *  a stable hash of its path, so the same note always lands in the same shard. */
export const INDEX_SHARD_NAME_PREFIX = '2048-shard-'

/** Stable FNV-1a checksum (8 hex chars) of a string payload, used to detect a
 *  corrupted/torn shard before trusting it. */
export function checksumOf(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Stable 32-bit hash of a path, so the same path always maps to the same shard
 *  regardless of insertion order. */
export function hashPath(path: string): number {
  let h = 5381
  for (let i = 0; i < path.length; i += 1) {
    h = ((h << 5) + h + path.charCodeAt(i)) | 0
  }
  return h >>> 0
}

/** Shard label (`0`…`9` then `a`…`f` for the default 16 shards) for a path. */
export function shardLabelForPath(path: string, count = INDEX_SHARD_COUNT): string {
  return (hashPath(path) % count).toString(36)
}

/** Every possible shard label for the configured shard count. */
export function shardLabels(count = INDEX_SHARD_COUNT): string[] {
  return Array.from({ length: count }, (_, i) => i.toString(36))
}
