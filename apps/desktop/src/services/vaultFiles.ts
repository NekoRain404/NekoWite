import { fsService } from './fs'
import type { FileEntry } from './fs'

const SKIP_DIRS = new Set(['node_modules'])
/** Upper bound on directories listed during one walk. This is a pathological-tree
 * guard, NOT a vault-size cap: the default is deliberately far larger than any
 * realistic vault (100k dirs ≈ a vault with tens of thousands of nested folders),
 * so a 10k-file vault can never hit it. When the cap IS hit (a truly pathological
 * tree) the caller is told via `truncated` instead of silently returning a partial
 * list — that signal is surfaced by the note list so it is never silent.
 *
 * Overridable per-walk via `walkVault(vault, list, { maxDirs })` and per-index via
 * `new VaultFileIndex(list, maxDirs)`, which is what the tests use to exercise the
 * truncated path without materializing 100k directories. */
export const MAX_DIRS = 100_000
/** Number of directory listings fetched concurrently within one BFS level. */
const LIST_CONCURRENCY = 8

export type ListFn = (vault: string, dir: string) => Promise<FileEntry[]>

export interface VaultWalkResult {
  files: string[]
  truncated: boolean
}

/** Recursively collect every markdown/MDX file under the vault. Mirrors the
 * file tree's traversal rules: skip node_modules and generated/hidden dirs,
 * keep files flagged openable (`is_mdx`). Bounded so a pathological tree
 * cannot walk forever. Directory listings within a level are fetched with a
 * small bounded pool so deep/large trees don't cost linearly. The result is
 * sorted deterministically so the UI stays stable. */
export async function collectVaultFiles(vault: string, list: ListFn): Promise<string[]> {
  return (await walkVault(vault, list)).files
}

export interface WalkOptions {
  /** Directory cap for this walk. Defaults to {@link MAX_DIRS} (generous). */
  maxDirs?: number
}

/** Like {@link collectVaultFiles} but also reports whether the directory cap
 * was hit, so the caller can warn the user the vault was truncated. */
export async function walkVault(
  vault: string,
  list: ListFn,
  opts?: WalkOptions,
): Promise<VaultWalkResult> {
  const maxDirs = opts?.maxDirs ?? MAX_DIRS
  const files: string[] = []
  const seen = new Set<string>()
  let queue: string[] = [vault]
  let visited = 0
  let truncated = false

  while (queue.length) {
    const remaining = maxDirs - visited
    if (remaining <= 0) {
      truncated = true
      break
    }
    // Reserve this level's directory slots up to the cap, in queue order, so the
    // set of dirs visited is deterministic even when the cap is hit mid-level.
    let level = queue
    if (level.length > remaining) {
      level = level.slice(0, remaining)
      truncated = true
    }
    visited += level.length

    const listed = await runPool(level, LIST_CONCURRENCY, async (dir) => {
      try {
        return { entries: await list(vault, dir) }
      } catch {
        return { entries: null }
      }
    })

    const next: string[] = []
    for (const { entries } of listed) {
      if (!entries) continue
      for (const entry of entries) {
        if (entry.is_dir) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          if (!seen.has(entry.path)) {
            seen.add(entry.path)
            next.push(entry.path)
          }
        } else if (entry.is_mdx) {
          files.push(entry.path)
        }
      }
    }
    queue = next
  }
  return { files: files.sort((a, b) => a.localeCompare(b)), truncated }
}

/** Run `fn` over `items` with at most `limit` concurrent invocations,
 * preserving input order in the returned array. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, Math.max(items.length, 1)) },
    async () => {
      while (cursor < items.length) {
        const i = cursor
        cursor += 1
        results[i] = await fn(items[i])
      }
    },
  )
  await Promise.all(workers)
  return results
}

/**
 * Cache of vault → markdown file list. Listing is lazy (first `get`) and
 * deduplicated: concurrent `get` calls share one in-flight walk. `invalidate`
 * drops the cache so the next `get` re-lists (fs-change hook). `isTruncated`
 * reports whether the most recent walk for a vault hit the directory cap.
 */
export class VaultFileIndex {
  private cache = new Map<string, string[]>()
  private inflight = new Map<string, Promise<string[]>>()
  /** Per-vault generation token: bumped on every `invalidate` so an in-flight
   * walk superseded by a fs-change cannot backfill the cache with stale data. */
  private generation = new Map<string, number>()
  private truncated = new Map<string, boolean>()

  constructor(private list: ListFn, private readonly maxDirs: number = MAX_DIRS) {}

  get(vault: string): Promise<string[]> {
    const cached = this.cache.get(vault)
    if (cached) return Promise.resolve(cached)
    const pending = this.inflight.get(vault)
    if (pending) return pending
    const gen = this.generation.get(vault) ?? 0
    const walk = walkVault(vault, this.list, { maxDirs: this.maxDirs })
    const wrapped = walk.then(
      (result) => {
        // Only a walk that is still the current generation may populate the
        // cache; one invalidated mid-flight is discarded (returned to its
        // caller, but not cached).
        if ((this.generation.get(vault) ?? 0) === gen) {
          this.cache.set(vault, result.files)
          this.truncated.set(vault, result.truncated)
        }
        return result.files
      },
      () => [],
    )
    this.inflight.set(vault, wrapped)
    // Drop the in-flight slot only if it still belongs to this walk: an
    // invalidate() during the walk may have replaced it with a newer one.
    void wrapped.finally(() => {
      if (this.inflight.get(vault) === wrapped) this.inflight.delete(vault)
    })
    return wrapped
  }

  /** Whether the last successful walk for `vault` hit the directory cap and
   * therefore returned a truncated file list. */
  isTruncated(vault: string): boolean {
    return this.truncated.get(vault) ?? false
  }

  invalidate(vault?: string): void {
    if (vault === undefined) {
      this.cache.clear()
      this.inflight.clear()
      this.truncated.clear()
      for (const v of this.generation.keys()) {
        this.generation.set(v, (this.generation.get(v) ?? 0) + 1)
      }
    } else {
      this.cache.delete(vault)
      this.inflight.delete(vault)
      this.truncated.delete(vault)
      this.generation.set(vault, (this.generation.get(vault) ?? 0) + 1)
    }
  }
}

export const vaultFileIndex = new VaultFileIndex((vault, dir) => fsService.list(vault, dir))
