import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fsService } from '../services/fs'
import type { FsChangeEvent } from '../services/fs'
import { vaultFileIndex } from '../services/vaultFiles'
import { ATTACHMENTS_DIR } from '../services/attachments'
import {
  aggregateTagCounts,
  computeLibraryCounts,
  extractOutlinks,
  filterAndSortNotes,
  parseNoteMeta,
  relPathOf,
  resolveLinkTarget,
} from '../services/noteMeta'
import type { LibraryFilter, LibraryCounts, NoteSummary, SortBy, MdLink } from '../services/noteMeta'

/** 列表栏整体视图：notes 模式下列表内容 = filter + query（notes/outline/links 子模式）。 */
export type ListView = 'notes' | 'graph' | 'attachments' | 'index' | 'cloud' | 'folders'

/** notes 视图下的列表子模式。图谱 / 附件 / 索引 / 云同步由 listView 承载。 */
export type PanelMode = 'notes' | 'outline' | 'links'

const LS_KEY = 'nekowite.library'
const RECENTS_MAX = 20
const INDEX_CONCURRENCY = 8

interface PersistedLibrary {
  favorites?: unknown
  recents?: unknown
}

function readPersisted(): { favorites: string[]; recents: string[] } {
  const raw = localStorage.getItem(LS_KEY)
  if (!raw) return { favorites: [], recents: [] }
  try {
    const parsed = JSON.parse(raw) as PersistedLibrary
    const valid = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return { favorites: valid(parsed.favorites), recents: valid(parsed.recents) }
  } catch {
    return { favorites: [], recents: [] }
  }
}

function isMdPath(path: string): boolean {
  return /\.(md|mdx)$/i.test(path)
}

export const useLibraryStore = defineStore('library', () => {
  const persisted = readPersisted()
  const notes = ref<NoteSummary[]>([])
  const favorites = ref<string[]>(persisted.favorites)
  const recents = ref<string[]>(persisted.recents)
  const filter = ref<LibraryFilter>('all')
  const query = ref('')
  const sortBy = ref<SortBy>('mtime')
  const panelMode = ref<PanelMode>('notes')
  const listView = ref<ListView>('notes')
  const vault = ref<string | null>(null)
  const indexing = ref(false)
  const attachmentCount = ref(0)

  let unlistenFs: (() => void) | null = null
  let indexSeq = 0
  let reindexTimer: ReturnType<typeof setTimeout> | null = null

  function persist(): void {
    localStorage.setItem(LS_KEY, JSON.stringify({ favorites: favorites.value, recents: recents.value }))
  }

  const visibleNotes = computed(() =>
    filterAndSortNotes(notes.value, {
      filter: filter.value,
      query: query.value,
      favorites: new Set(favorites.value),
      recents: recents.value,
      sortBy: sortBy.value,
    }),
  )

  const tagCounts = computed(() => aggregateTagCounts(notes.value, 8))

  const counts = computed<LibraryCounts>(() =>
    computeLibraryCounts(notes.value, favorites.value, recents.value),
  )

  async function readNoteSummary(v: string, path: string): Promise<NoteSummary | null> {
    try {
      const content = await fsService.read(v, path)
      let mtime = 0
      let size = content.length
      try {
        const stat = await fsService.stat(v, path)
        mtime = stat.mtime
        size = stat.size
      } catch {
        // stat is best-effort: memory gateway and fresh files always work,
        // exotic filesystems may not — fall back to content-derived values.
      }
      return parseNoteMeta(path, content, { mtime, size, vault: v })
    } catch {
      return null
    }
  }

  async function runIndex(v: string): Promise<void> {
    const seq = ++indexSeq
    indexing.value = true
    try {
      const files = await vaultFileIndex.get(v)
      if (seq !== indexSeq) return
      const results: NoteSummary[] = []
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < files.length) {
          const path = files[cursor]
          cursor += 1
          const summary = await readNoteSummary(v, path)
          if (summary) results.push(summary)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(INDEX_CONCURRENCY, Math.max(files.length, 1)) }, () => worker()),
      )
      if (seq !== indexSeq) return
      notes.value = results
      const alive = new Set(results.map((n) => n.path))
      if (favorites.value.some((p) => !alive.has(p)) || recents.value.some((p) => !alive.has(p))) {
        favorites.value = favorites.value.filter((p) => alive.has(p))
        recents.value = recents.value.filter((p) => alive.has(p))
        persist()
      }
    } finally {
      if (seq === indexSeq) indexing.value = false
    }
  }

  async function handleFsChange(e: FsChangeEvent): Promise<void> {
    const v = vault.value
    if (!v) return
    if (!isMdPath(e.path)) {
      vaultFileIndex.invalidate(v)
      void refreshAttachmentCount(v)
      return
    }
    vaultFileIndex.invalidate(v)
    if (e.kind === 'remove') {
      notes.value = notes.value.filter((n) => n.path !== e.path)
      return
    }
    const summary = await readNoteSummary(v, e.path)
    if (!summary) {
      notes.value = notes.value.filter((n) => n.path !== e.path)
      return
    }
    const rest = notes.value.filter((n) => n.path !== e.path)
    rest.push(summary)
    notes.value = rest
  }

  function detachVault(): void {
    indexSeq += 1
    if (reindexTimer) {
      clearTimeout(reindexTimer)
      reindexTimer = null
    }
    unlistenFs?.()
    unlistenFs = null
  }

  /** 侧栏「附件」徽标：attachments/ 顶层条目数（目录也算一个条目）。 */
  async function refreshAttachmentCount(v: string): Promise<void> {
    try {
      const entries = await fsService.list(v, ATTACHMENTS_DIR)
      attachmentCount.value = entries.length
    } catch {
      attachmentCount.value = 0
    }
  }

  async function indexVault(v: string): Promise<void> {
    detachVault()
    vault.value = v
    filter.value = 'all'
    query.value = ''
    panelMode.value = 'notes'
    listView.value = 'notes'
    try {
      unlistenFs = await fsService.onFsChange(handleFsChange)
    } catch {
      unlistenFs = null
    }
    void refreshAttachmentCount(v)
    await runIndex(v)
  }

  function toggleFavorite(path: string): void {
    const i = favorites.value.indexOf(path)
    if (i >= 0) favorites.value.splice(i, 1)
    else favorites.value.push(path)
    persist()
  }

  function isFavorite(path: string): boolean {
    return favorites.value.includes(path)
  }

  function touchRecent(path: string): void {
    const i = recents.value.indexOf(path)
    if (i === 0) return
    if (i > 0) recents.value.splice(i, 1)
    recents.value.unshift(path)
    if (recents.value.length > RECENTS_MAX) recents.value.length = RECENTS_MAX
    persist()
  }

  function setFilter(f: LibraryFilter): void {
    filter.value = f
    panelMode.value = 'notes'
    listView.value = 'notes'
  }

  function setPanelMode(m: PanelMode): void {
    panelMode.value = m
  }

  function setListView(v: ListView): void {
    listView.value = v
  }

  function setQuery(q: string): void {
    query.value = q
  }

  function setSortBy(s: SortBy): void {
    sortBy.value = s
  }

  /** Resolve a markdown link target found in a note under `fromRelDir` to the
   * indexed note's openable path (falls back to `target + '.md'`). */
  function resolveLinkPath(fromRelDir: string, target: string): string | null {
    if (!vault.value) return null
    const rel = resolveLinkTarget(fromRelDir, target)
    if (!rel) return null
    const candidates = [rel, `${rel}.md`]
    for (const note of notes.value) {
      const noteRel = relPathOf(note)
      if (candidates.includes(noteRel)) return note.path
    }
    for (const candidate of candidates) {
      const hit = notes.value.find((n) => n.path.endsWith(`/${candidate}`))
      if (hit) return hit.path
    }
    return null
  }

  /** Outlinks of the active document: parsed from its content and resolved
   * against the index. Unresolvable targets are kept with path = null. */
  function outlinksOf(fromRelDir: string, content: string): Array<MdLink & { path: string | null }> {
    const out: Array<MdLink & { path: string | null }> = []
    const seen = new Set<string>()
    for (const link of extractOutlinks(content)) {
      const key = `${link.target}\u0000${link.text}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...link, path: resolveLinkPath(fromRelDir, link.target) })
    }
    return out
  }

  /** Backlinks: indexed notes whose pre-parsed links point at `relPath`. */
  function inlinksOf(relPath: string | null): NoteSummary[] {
    if (!relPath) return []
    const withExt = /\.(md|mdx)$/i.test(relPath) ? [relPath] : [relPath, `${relPath}.md`]
    return notes.value.filter((n) => n.links.some((l) => withExt.includes(l)))
  }

  return {
    notes,
    favorites,
    recents,
    filter,
    query,
    sortBy,
    panelMode,
    listView,
    vault,
    indexing,
    attachmentCount,
    visibleNotes,
    tagCounts,
    counts,
    indexVault,
    detachVault,
    toggleFavorite,
    isFavorite,
    touchRecent,
    setFilter,
    setPanelMode,
    setListView,
    setQuery,
    setSortBy,
    resolveLinkPath,
    outlinksOf,
    inlinksOf,
  }
})
