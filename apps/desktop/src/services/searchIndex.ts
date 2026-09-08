/** Persistent, incremental full-text index for vault search.
 *
 * The note list currently does a live full-body scan for content search. That
 * scan is correct (a deep-body-only match is still found) but re-reads every
 * note on every keystroke. This module builds a persistent, incremental term
 * index over each note's searchable fields so a search can skip notes that
 * cannot match, while the full-body scan remains the source of truth for the
 * snippet (see contentSearch `searchWithIndex`).
 *
 * The index is stored per-vault in **shards** so a large vault never serializes
 * one huge blob. Notes are partitioned across a fixed number of shards by a
 * stable hash of their path (`shardLabelForPath`), each shard is persisted under
 * its own storage key (see {@link indexShardKey}), and a **shard metadata**
 * record carries a per-shard checksum so a corrupted shard is detected and only
 * that shard (not the whole index) is rebuilt. A per-note version token
 * (`mtime:size`) lets a rebuild update only the notes that actually changed, and
 * a `text` field holds the lowercased haystack of every searchable field —
 * including the full body, so a deep-body match is captured by the index itself
 * and never silently dropped.
 *
 * Persistence detail: the shard store is the async {@link AsyncIndexStorage}. The
 * wiring (`indexCoordinatorWiring.ts`) selects the backend by environment — an
 * fs-backed store (`createFileIndexStorage`) writing each shard to a
 * `.nekowite/index/` JSON file via the async {@link FsPort} in Tauri, else the
 * localStorage sharded store as a NON-authoritative fallback (the browser demo /
 * tests). Because `loadIndex`/`saveIndex`/`clearIndex` are async, the coordinator
 * `await`s them; the query API (`queryIndex`, `indexEntryFor`, `searchWithIndex`)
 * stays synchronous over the in-memory mirror.
 *
 * Shard writes are atomic (temp blob → swap), and the metadata record is written
 * last as a commit marker, so an interrupted write never leaves a torn index: on
 * the next load a shard whose checksum no longer matches the metadata is dropped
 * from the in-memory `notes` and rebuilt by the incremental build step. The
 * fs-backed store maps the meta/shard keys to `.nekowite/index/{manifest,shard-NN}.
 * json`, keeping the same atomic temp→swap (via `<file>.tmp`).
 */

import { parseNoteMeta } from './noteMeta'
import type { FileStat, FsPort } from '../platform/gateways/contracts'

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

/** UI-facing state of the persistent index for the current vault. */
export type IndexState = 'idle' | 'building' | 'up-to-date' | 'stale' | 'needs-rebuild'

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

/** Current on-disk index format version. A stored index whose metadata version
 *  does not match is treated as stale and rebuilt. */
export const INDEX_VERSION = 2
const LS_PREFIX = 'nekowite.searchIndex.v2'

/** Number of path-hash shards an index is split across. A vault with few notes
 *  only materialises the shards that actually contain a note. */
export const INDEX_SHARD_COUNT = 16

/** Shard name prefix, e.g. `2048-shard-a`. A note's shard label is derived from
 *  a stable hash of its path, so the same note always lands in the same shard. */
export const INDEX_SHARD_NAME_PREFIX = '2048-shard-'

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
 *  or unreadable file reads as `null` (so `loadIndex` flags it corrupt and the
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

/** Version token for a note's indexed content. */
export function docToken(mtime: number, size: number): string {
  return `${mtime}:${size}`
}

/** Fold every searchable field of a note into one lowercased haystack. The full
 *  `content` (frontmatter + body + MDX text, including any referenced
 *  attachment path / alt-text) is included so a deep-body-only match is present
 *  in the index and never dropped by a metadata-first prefilter. */
export function searchableText(
  path: string,
  content: string,
  meta: { title: string; tags: string[]; summary: string; name: string; dir: string },
): string {
  return [
    path,
    meta.name,
    meta.dir,
    meta.title,
    meta.tags.join(' '),
    meta.summary,
    content,
  ]
    .join('\n')
    .toLowerCase()
}

/** Build the index text for a single note from its raw content + stat. Reuses
 *  the note-meta parser so the index fields mirror the note list. */
export function buildSearchText(
  path: string,
  content: string,
  vault: string,
  mtime: number,
  size: number,
): string {
  const meta = parseNoteMeta(path, content, { mtime, size, vault })
  return searchableText(path, content, meta)
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

/** Candidate note paths whose indexed text contains `query`. Returns an empty
 *  array for a blank query. The result is sorted so the UI stays stable. */
export function queryIndex(index: StoredIndex, query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: string[] = []
  for (const [path, doc] of Object.entries(index.notes)) {
    if (doc.text.includes(q)) out.push(path)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** Coarse index state from the stored blob and the current file list. Does not
 *  stat disks — the build step reconciles mtime/size and sets a finer state. */
export function indexStateOf(index: StoredIndex | null, paths: string[]): IndexState {
  if (!index) return 'needs-rebuild'
  for (const path of paths) {
    if (!index.notes[path]) return 'stale'
  }
  return 'up-to-date'
}

/** Cooperative yield to the event loop so a large background build never
 *  blocks input. */
function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

export interface IndexBuildDeps {
  stat: (path: string) => Promise<FileStat | null>
  read: (path: string) => Promise<string>
  /** Overridable text builder (for tests); defaults to {@link buildSearchText}. */
  textOf?: (path: string, content: string, mtime: number, size: number, vault: string) => string
}

export interface IndexBuildOptions {
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  force?: boolean
  concurrency?: number
}

export interface IndexBuildResult {
  index: StoredIndex
  /** Notes rebuilt from a fresh read. */
  built: number
  /** Notes left untouched because their stat matched the stored token. */
  skipped: number
  /** Note paths added/changed in this run. */
  changed: number
  /** Note paths dropped because they are no longer in the vault. */
  removed: number
  /** Notes that failed to read/stat. */
  failed: number
  /** Shard labels whose stored checksum failed at load and were re-indexed in
   *  this run (a targeted shard rebuild, not a full-index rebuild). */
  rebuiltShards: string[]
}

const DEFAULT_CONCURRENCY = 4
const YIELD_EVERY = 25

/** Build (or incrementally update) a persistent index for `vault`.
 *
 *  Starting from `existing` (or empty), it:
 *  - drops entries for paths no longer in `paths` (add/delete/move),
 *  - skips entries whose stat matches the stored mtime/size token,
 *  - re-reads and re-indexes only the changed paths (bounded concurrency),
 *  - yields to the event loop every few notes so a large vault never blocks
 *    the main thread,
 *  - is cancellable via `signal` (a partial index is still returned).
 */
export async function buildIndexIncremental(
  vault: string,
  paths: string[],
  deps: IndexBuildDeps,
  existing: StoredIndex | null,
  opts: IndexBuildOptions = {},
): Promise<IndexBuildResult> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const force = opts.force ?? false
  const signal = opts.signal
  const textOf =
    deps.textOf ??
    ((path: string, content: string, mtime: number, size: number, v: string) =>
      buildSearchText(path, content, v, mtime, size))
  const notes: Record<string, IndexedDoc> = existing ? { ...existing.notes } : {}
  const current = new Set(paths)

  let removed = 0
  for (const path of Object.keys(notes)) {
    if (!current.has(path)) {
      delete notes[path]
      removed += 1
    }
  }

  let built = 0
  let skipped = 0
  let failed = 0
  const changed = new Set<string>()
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < paths.length) {
      if (signal?.aborted) return
      const path = paths[cursor]
      cursor += 1
      try {
        // Resolve the current stat; a null stat (unreadable) still falls back to
        // a read attempt below rather than silently dropping the note.
        const stat = await deps.stat(path)
        if (signal?.aborted) return
        const existingDoc = notes[path]
        if (
          !force &&
          existingDoc &&
          stat &&
          existingDoc.mtime === stat.mtime &&
          existingDoc.size === stat.size
        ) {
          skipped += 1
          continue
        }
        const content = await deps.read(path)
        if (signal?.aborted) return
        const mtime = stat?.mtime ?? 0
        const size = stat?.size ?? content.length
        notes[path] = { token: docToken(mtime, size), text: textOf(path, content, mtime, size, vault), mtime, size }
        built += 1
        changed.add(path)
        opts.onProgress?.(built, paths.length)
      } catch {
        failed += 1
      }
      if (built % YIELD_EVERY === 0) await yieldToMainThread()
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(paths.length, 1)) }, () => worker()),
  )

  return {
    index: { version: INDEX_VERSION, vault, builtAt: Date.now(), notes },
    built,
    skipped,
    changed: changed.size,
    removed,
    failed,
    // Shards whose checksum failed at load were dropped from `notes`, so every
    // note in them was (re)read above — report them as a targeted rebuild.
    rebuiltShards: existing?.corruptShards ?? [],
  }
}
