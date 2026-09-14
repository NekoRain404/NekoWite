/** The search index's domain model: what a stored index *is*.
 *
 * This is the feature's shared kernel — the build path produces one, the query
 * path answers over one, the shard store persists one — so it lives apart from
 * the concerns that use it rather than inside any one of them. The build, query
 * and persistence concerns are their own modules; this file holds only the
 * document shape and its on-disk version.
 */

export interface IndexedDoc {
  /** Version token `${mtime}:${size}` — changed files produce a different token. */
  token: string
  /** Lowercased concatenation of every searchable field (path, name, dir, title,
   *  tags, summary, frontmatter, and the full body text / MDX text). */
  text: string
  mtime: number
  size: number
}

export interface StoredIndex {
  version: number
  vault: string
  builtAt: number
  notes: Record<string, IndexedDoc>
  /** Path-hash shard labels whose loaded checksum failed. When present, the
   *  persistence layer rebuilds just those shards on the next build/save. */
  corruptShards?: string[]
}

/** UI-facing state of the persistent index for the current vault. */
export type IndexState = 'idle' | 'building' | 'up-to-date' | 'stale' | 'needs-rebuild'

/** Current on-disk index format version. A stored index whose metadata version
 *  does not match is treated as stale and rebuilt. */
export const INDEX_VERSION = 2
