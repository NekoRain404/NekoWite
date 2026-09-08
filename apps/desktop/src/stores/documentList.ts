import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { LibraryCounts, LibraryFilter, NoteSummary, SortBy } from '../services/noteMeta'
import type { IndexState } from '../services/searchIndex'
import { queryCounts, queryTagCounts, queryVisibleNotes } from '../features/vault/services/libraryQueries'

/** 列表栏整体视图：notes 模式下列表内容 = filter + query（notes/outline/links 子模式）。 */
export type ListView = 'notes' | 'graph' | 'attachments' | 'index' | 'cloud' | 'folders'

/** notes 视图下的列表子模式。图谱 / 附件 / 索引 / 云同步由 listView 承载。 */
export type PanelMode = 'notes' | 'outline' | 'links'

const LS_KEY = 'nekowite.library'
const RECENTS_MAX = 20

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

/**
 * Note-list state and actions: the visible note summaries, the library filters /
 * search query / sort, the tag + nav counts, and the persisted favorites/recents.
 *
 * The note summaries are produced by the vault index coordinator (an application
 * service) and mirrored here via the internal `_setNotes`/`_setIndexing` setters;
 * this store never reads a file itself. Selecting (`visibleNotes`, `tagCounts`,
 * `counts`) is delegated to the pure `libraryQueries` module.
 */
export const useDocumentListStore = defineStore('documentList', () => {
  const persisted = readPersisted()
  const notes = ref<NoteSummary[]>([])
  const favorites = ref<string[]>(persisted.favorites)
  const recents = ref<string[]>(persisted.recents)
  const filter = ref<LibraryFilter>('all')
  const query = ref('')
  const sortBy = ref<SortBy>('mtime')
  const panelMode = ref<PanelMode>('notes')
  const listView = ref<ListView>('notes')
  const indexing = ref(false)
  /** Persistent full-text search index state (building / up-to-date / stale). */
  const indexState = ref<IndexState>('idle')
  /** Progress of the background index build, or null when idle. */
  const indexProgress = ref<{ done: number; total: number } | null>(null)

  function persist(): void {
    localStorage.setItem(LS_KEY, JSON.stringify({ favorites: favorites.value, recents: recents.value }))
  }

  const visibleNotes = computed(() =>
    queryVisibleNotes(notes.value, {
      filter: filter.value,
      query: query.value,
      favorites: new Set(favorites.value),
      recents: recents.value,
      sortBy: sortBy.value,
    }),
  )

  const tagCounts = computed(() => queryTagCounts(notes.value, 8))

  const counts = computed<LibraryCounts>(() =>
    queryCounts(notes.value, favorites.value, recents.value),
  )

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

  // --- Internal setters mirrored from the vault index coordinator ---

  function setNotes(next: NoteSummary[]): void {
    notes.value = next
  }

  function setIndexing(v: boolean): void {
    indexing.value = v
  }

  function setIndexState(state: IndexState, progress: { done: number; total: number } | null): void {
    indexState.value = state
    indexProgress.value = progress
  }

  /** Replace favorites/recents after a re-index prunes vanished files. */
  function setFavoritesRecents(favs: string[], recentsNext: string[]): void {
    favorites.value = favs
    recents.value = recentsNext
    persist()
  }

  /** Reset the per-vault view/list state on a vault switch. */
  function resetForVault(): void {
    notes.value = []
    filter.value = 'all'
    query.value = ''
    panelMode.value = 'notes'
    listView.value = 'notes'
    indexing.value = false
    indexState.value = 'idle'
    indexProgress.value = null
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
    indexing,
    indexState,
    indexProgress,
    visibleNotes,
    tagCounts,
    counts,
    toggleFavorite,
    isFavorite,
    touchRecent,
    setFilter,
    setPanelMode,
    setListView,
    setQuery,
    setSortBy,
    setNotes,
    setIndexing,
    setIndexState,
    setFavoritesRecents,
    resetForVault,
  }
})
