import { fsService } from './fs'
import type { FileEntry } from './fs'

const SKIP_DIRS = new Set(['node_modules'])
const MAX_DIRS = 512

export type ListFn = (vault: string, dir: string) => Promise<FileEntry[]>

/** Recursively collect every markdown/MDX file under the vault. Mirrors the
 * file tree's traversal rules: skip node_modules and generated/hidden dirs,
 * keep files flagged openable (`is_mdx`). Bounded so a pathological tree
 * cannot walk forever. */
export async function collectVaultFiles(vault: string, list: ListFn): Promise<string[]> {
  const files: string[] = []
  const seen = new Set<string>()
  let queue: string[] = [vault]
  let visited = 0
  while (queue.length && visited < MAX_DIRS) {
    const next: string[] = []
    for (const dir of queue) {
      if (visited >= MAX_DIRS) break
      visited += 1
      let entries: FileEntry[]
      try {
        entries = await list(vault, dir)
      } catch {
        continue
      }
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
  return files.sort((a, b) => a.localeCompare(b))
}

/**
 * Cache of vault → markdown file list. Listing is lazy (first `get`) and
 * deduplicated: concurrent `get` calls share one in-flight walk. `invalidate`
 * drops the cache so the next `get` re-lists (fs-change hook).
 */
export class VaultFileIndex {
  private cache = new Map<string, string[]>()
  private inflight = new Map<string, Promise<string[]>>()
  /** Per-vault generation token: bumped on every `invalidate` so an in-flight
   * walk superseded by a fs-change cannot backfill the cache with stale data. */
  private generation = new Map<string, number>()

  constructor(private list: ListFn) {}

  get(vault: string): Promise<string[]> {
    const cached = this.cache.get(vault)
    if (cached) return Promise.resolve(cached)
    const pending = this.inflight.get(vault)
    if (pending) return pending
    const gen = this.generation.get(vault) ?? 0
    const walk = collectVaultFiles(vault, this.list)
    const wrapped = walk.then(
      (files) => {
        // Only a walk that is still the current generation may populate the
        // cache; one invalidated mid-flight is discarded (returned to its
        // caller, but not cached).
        if ((this.generation.get(vault) ?? 0) === gen) this.cache.set(vault, files)
        return files
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

  invalidate(vault?: string): void {
    if (vault === undefined) {
      this.cache.clear()
      this.inflight.clear()
      for (const v of this.generation.keys()) {
        this.generation.set(v, (this.generation.get(v) ?? 0) + 1)
      }
    } else {
      this.cache.delete(vault)
      this.inflight.delete(vault)
      this.generation.set(vault, (this.generation.get(vault) ?? 0) + 1)
    }
  }
}

export const vaultFileIndex = new VaultFileIndex((vault, dir) => fsService.list(vault, dir))
