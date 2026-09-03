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

  constructor(private list: ListFn) {}

  get(vault: string): Promise<string[]> {
    const cached = this.cache.get(vault)
    if (cached) return Promise.resolve(cached)
    const pending = this.inflight.get(vault)
    if (pending) return pending
    const walk = collectVaultFiles(vault, this.list)
    this.inflight.set(vault, walk)
    return walk.then(
      (files) => {
        this.cache.set(vault, files)
        return files
      },
      () => [],
    ).finally(() => {
      this.inflight.delete(vault)
    })
  }

  invalidate(vault?: string): void {
    if (vault === undefined) this.cache.clear()
    else this.cache.delete(vault)
  }
}

export const vaultFileIndex = new VaultFileIndex((vault, dir) => fsService.list(vault, dir))
