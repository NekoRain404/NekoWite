import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { LibraryCounts, LibraryFilter, NoteSummary, SortBy } from '../features/notes'
import type { IndexState } from '../features/search'
import { queryCounts, queryTagCounts, queryVisibleNotes } from '../features/vault'
import { persistence } from '../services/persistence'

/** 列表栏整体视图：notes 模式下列表内容 = filter + query（notes/outline/links 子模式）。 */
export type ListView = 'notes' | 'graph' | 'attachments' | 'index' | 'cloud' | 'folders'

/** notes 视图下的列表子模式。图谱 / 附件 / 索引 / 云同步由 listView 承载。 */
export type PanelMode = 'notes' | 'outline' | 'links'

const LS_KEY = 'nekowite.library'
const RECENTS_MAX = 20

/** Parking bucket for the pre-C2 single-bucket blob: it belongs to exactly one
 *  vault, but which one is only knowable once a vault opens (see `activateBucket`). */
const ADOPTED_BUCKET = '__adopted__'

/** The vault root recorded at startup (owned by app/appBootstrap.ts). Read here
 *  only to attribute a legacy blob — or a mutation made before the index reports —
 *  to the vault the user actually had open. */
const VAULT_LS_KEY = 'nekowite.vault'

interface VaultLibrary {
  favorites: string[]
  recents: string[]
}

/** Vault root → that vault's favorites/recents. */
type LibraryBuckets = Record<string, VaultLibrary>

interface LegacyLibrary {
  favorites?: unknown
  recents?: unknown
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
}

function emptyBucket(bucket: VaultLibrary | undefined): boolean {
  return !bucket || (bucket.favorites.length === 0 && bucket.recents.length === 0)
}

/**
 * Read every vault's bucket, migrating the pre-C2 single-bucket blob.
 *
 * Older builds kept ONE `{ favorites, recents }` pair for the whole app. Those
 * entries cannot be attributed to a vault at read time (the store is built before
 * the index runs), so they are parked under {@link ADOPTED_BUCKET} and moved into
 * the vault that owns them the moment one becomes active — the user's existing
 * favorites are never dropped, and they are never copied into every vault either.
 */
function readPersisted(): LibraryBuckets {
  const raw = persistence.get(LS_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    // A bare array was never written by this store, but it is a plausible legacy
    // shape and costs nothing to accept.
    if (Array.isArray(parsed)) {
      return { [ADOPTED_BUCKET]: { favorites: stringsOf(parsed), recents: [] } }
    }
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    // Legacy single-bucket shape: the top-level keys are the fields themselves
    // rather than vault roots.
    if ('favorites' in record || 'recents' in record) {
      const legacy = record as LegacyLibrary
      return {
        [ADOPTED_BUCKET]: { favorites: stringsOf(legacy.favorites), recents: stringsOf(legacy.recents) },
      }
    }
    const buckets: LibraryBuckets = {}
    for (const [vault, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object') continue
      const bucket = value as LegacyLibrary
      buckets[vault] = { favorites: stringsOf(bucket.favorites), recents: stringsOf(bucket.recents) }
    }
    return buckets
  } catch {
    // Corrupt JSON is not an error: start empty rather than failing to boot.
    return {}
  }
}

/**
 * Note-list state and actions: the visible note summaries, the library filters /
 * search query / sort, the tag + nav counts, and the persisted favorites/recents.
 *
 * Favorites/recents are stored PER VAULT (bucket per vault root). One shared pair
 * used to be pruned against whichever vault was current, so switching vaults
 * deleted the previous vault's entries for good: the new index reported the old
 * paths as vanished files and the "prune what is gone" callback — correct within a
 * vault — dropped them from the only copy there was. Pruning now edits the active
 * bucket alone and a switch just activates another one.
 *
 * The note summaries are produced by the vault index coordinator (an application
 * service) and mirrored here via the internal `_setNotes`/`_setIndexing` setters;
 * this store never reads a file itself. Selecting (`visibleNotes`, `tagCounts`,
 * `counts`) is delegated to the pure `libraryQueries` module.
 */
export const useDocumentListStore = defineStore('documentList', () => {
  const buckets = readPersisted()
  let activeBucket: string | null = null

  const notes = ref<NoteSummary[]>([])
  const favorites = ref<string[]>([])
  const recents = ref<string[]>([])
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
    // A mutation can land before the index reported (the sidebar renders first);
    // it still belongs to the vault recorded at startup, and only falls back to
    // the adoption bucket when no vault was ever recorded.
    if (activeBucket === null) activeBucket = persistence.get(VAULT_LS_KEY) ?? ADOPTED_BUCKET
    buckets[activeBucket] = { favorites: [...favorites.value], recents: [...recents.value] }
    persistence.set(LS_KEY, JSON.stringify(buckets))
  }

  /**
   * Show `vault`'s own favorites/recents (null = no vault open, so show none).
   *
   * The previous vault's bucket is left untouched in storage — it is not this
   * vault's to prune — and the pre-C2 blob is adopted ONLY by the vault that owns
   * it (the one recorded at startup), or by the first vault to open when no vault
   * was recorded.
   */
  function activateBucket(vault: string | null): void {
    if (vault === null) {
      activeBucket = null
      favorites.value = []
      recents.value = []
      return
    }
    const legacy = buckets[ADOPTED_BUCKET]
    if (legacy) {
      const recorded = persistence.get(VAULT_LS_KEY)
      if ((recorded === null || recorded === vault) && emptyBucket(buckets[vault])) {
        buckets[vault] = legacy
        delete buckets[ADOPTED_BUCKET]
        persistence.set(LS_KEY, JSON.stringify(buckets))
      }
    }
    activeBucket = vault
    favorites.value = [...(buckets[vault]?.favorites ?? [])]
    recents.value = [...(buckets[vault]?.recents ?? [])]
  }

  // The vault recorded at startup is enough to show its entries before the index
  // coordinator reports; `resetForVault` re-activates the real one.
  activateBucket(persistence.get(VAULT_LS_KEY))

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

  function setSortBy(v: SortBy): void {
    sortBy.value = v
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

  /** Replace favorites/recents after a re-index prunes vanished files. Only the
   *  ACTIVE vault's bucket is edited: a path missing from this vault says nothing
   *  about another vault's entries. */
  function setFavoritesRecents(favs: string[], recentsNext: string[]): void {
    favorites.value = favs
    recents.value = recentsNext
    persist()
  }

  /** Reset the per-vault view/list state on a vault switch and activate `vault`'s
   *  favorites/recents bucket (null when no vault is open). */
  function resetForVault(vault: string | null = null): void {
    notes.value = []
    filter.value = 'all'
    query.value = ''
    panelMode.value = 'notes'
    listView.value = 'notes'
    indexing.value = false
    indexState.value = 'idle'
    indexProgress.value = null
    activateBucket(vault)
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