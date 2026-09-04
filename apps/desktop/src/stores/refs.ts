import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fsService } from '../services/fs'
import { detectFormat, parseRefs, type Reference } from '../services/refs'

export const useRefsStore = defineStore('refs', () => {
  const refs = ref<Map<string, Reference>>(new Map())
  const refFiles = ref<string[]>([])

  /** Load the vault's reference files. An optional `signal` lets a vault switch
   *  cancel an in-flight load so a superseded vault's refs never populate after a
   *  newer vault claimed the session (latest-wins). */
  async function loadVault(vault: string, opts?: { signal?: AbortSignal }): Promise<void> {
    if (opts?.signal?.aborted) return
    refs.value = new Map()
    refFiles.value = []
    const entries = await fsService.list(vault, '.')
    if (opts?.signal?.aborted) return
    const candidates = entries.filter((e) => detectFormat(e.name) !== null)
    for (const entry of candidates) {
      if (opts?.signal?.aborted) return
      const format = detectFormat(entry.name)
      if (!format) continue
      try {
        const text = await fsService.read(vault, entry.path)
        if (opts?.signal?.aborted) return
        const parsed = parseRefs(text, format)
        refFiles.value.push(entry.name)
        for (const r of parsed) {
          if (r.key) refs.value.set(r.key, r)
        }
      } catch {
        // single file failure does not abort others
      }
    }
  }

  function search(query: string): Reference[] {
    const q = query.trim().toLowerCase()
    if (!q) return [...refs.value.values()]
    return [...refs.value.values()].filter((r) =>
      [r.key, r.title, ...r.authors, r.year]
        .filter(Boolean)
        .some((f) => f.toLowerCase().includes(q)),
    )
  }

  function get(key: string): Reference | undefined {
    return refs.value.get(key)
  }

  function clear(): void {
    refs.value = new Map()
    refFiles.value = []
  }

  return { refs, refFiles, loadVault, search, get, clear }
})