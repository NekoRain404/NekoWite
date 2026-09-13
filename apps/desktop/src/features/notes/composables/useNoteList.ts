/**
 * The note list's own state: which notes it shows, how they are filtered and
 * sorted, and the content-search run (§13.4 — the store holds the state, the
 * pure query module derives the rows, this composable commands both).
 *
 * The store reads (documentList, vaultSession, fileTree, tabs) live here rather
 * than in the components: §10.2 keeps a feature component off the stores, and
 * each of these reads is the list's own business — the query, the sort key, the
 * index state, the vault being searched. The components take props and emit
 * events, so nothing about the list is read twice and a change to its state has
 * one place to land.
 *
 * `vault` is deliberately the tabs store's vault: it is what decides whether the
 * folders panel has something to show, and the app sets it together with the
 * session vault.
 */

import { computed, ref, watch, type ComputedRef } from 'vue'
import { splitFrontmatter } from '@nekowite/editor-core'
import { useDocumentListStore } from '../../../stores/documentList'
import type { ListView, PanelMode } from '../../../stores/documentList'
import { useFileTreeStore } from '../../../stores/fileTree'
import { useTabsStore } from '../../../stores/tabs'
import { useVaultSessionStore } from '../../../stores/vaultSession'
import { dirRelativeToVault } from '../../../services/noteMeta'
import type { MdLink, NoteSummary, SortBy } from '../../../services/noteMeta'
import { parseOutline, type OutlineItem } from '../../../services/outline'
import { baseName } from '../../../services/paths'
import {
  CONTENT_SEARCH_CONCURRENCY,
  searchWithIndex,
  type ContentMatch,
  type ContentSearchCandidate,
} from '../../../services/contentSearch'
import type { IndexState } from '../../../services/searchIndex'
import { inlinksOf, outlinksOf } from '../../vault'
import { t } from '../../../i18n'
import { filter, sort } from '../services/note-list-query'
import type { FilterOptions } from '../services/note-list-query'

const CONTENT_SEARCH_DEBOUNCE_MS = 200

/** An outlink of the open note, `path === null` when its target is not in the
 *  index (the row still renders, unopenable). */
export type NoteOutlink = MdLink & { path: string | null }

export interface NoteListLinks {
  out: NoteOutlink[]
  back: NoteSummary[]
}

export interface NoteListModel {
  /** notes / outline / links — the sub-mode of the notes view. */
  panelMode: ComputedRef<PanelMode>
  setMode(mode: PanelMode): void
  /** notes / graph / attachments / index / cloud / folders — the whole column. */
  listView: ComputedRef<ListView>
  /** The vault the panel is showing, or null when none is open. */
  vault: ComputedRef<string | null>
  /** The path of the open note, or null (an untitled tab has no path). */
  activePath: ComputedRef<string | null>
  /** Whether a note is open at all — the outline and links need one. */
  hasActiveTab: ComputedRef<boolean>
  /** The index, filtered by the query/filter and ordered by the sort key. */
  results: ComputedRef<NoteSummary[]>
  /** The favorited paths as one snapshot, so a card reads its own star. */
  favorites: ComputedRef<ReadonlySet<string>>
  query: ComputedRef<string>
  setQuery(value: string): void
  sortOrder: ComputedRef<SortBy>
  setSortOrder(sortBy: SortBy): void
  contentEnabled: ComputedRef<boolean>
  toggleContentSearch(): void
  contentResults: ComputedRef<ContentMatch[]>
  contentSearching: ComputedRef<boolean>
  contentSearched: ComputedRef<boolean>
  /** Run the content search now (the debounce timer and the toggle call it). */
  search(): Promise<void>
  indexing: ComputedRef<boolean>
  indexState: ComputedRef<IndexState>
  indexStatusLabel: ComputedRef<string>
  showIndexStatus: ComputedRef<boolean>
  /** The vault walk was capped, so the list may not be the whole vault. */
  vaultTruncated: ComputedRef<boolean>
  rebuildIndex(): void
  outlineItems: ComputedRef<OutlineItem[]>
  links: ComputedRef<NoteListLinks>
  isFavorite(path: string): boolean
  toggleFavorite(path: string): void
}

export function useNoteList(): NoteListModel {
  const documentList = useDocumentListStore()
  const vaultSession = useVaultSessionStore()
  const fileTree = useFileTreeStore()
  const tabs = useTabsStore()

  const contentEnabled = ref(false)
  const contentResults = ref<ContentMatch[]>([])
  const contentSearching = ref(false)
  const contentSearched = ref(false)
  let contentSearchTimer: ReturnType<typeof setTimeout> | null = null
  let contentSearchAbort: AbortController | null = null

  function clearContentResults(): void {
    contentSearchAbort?.abort()
    contentSearchAbort = null
    if (contentSearchTimer) {
      clearTimeout(contentSearchTimer)
      contentSearchTimer = null
    }
    contentResults.value = []
    contentSearching.value = false
    contentSearched.value = false
  }

  /** Short label for the persistent search-index state, shown in the note-list
   *  meta row. While building it shows an incremental progress count. */
  const indexStatusLabel = computed(() => {
    const s = documentList.indexState
    const progress = documentList.indexProgress
    if (s === 'building' && progress) {
      return t('notelist.indexBuildingProgress', { done: progress.done, total: progress.total })
    }
    switch (s) {
      case 'building':
        return t('notelist.indexBuilding')
      case 'up-to-date':
        return t('notelist.indexUpToDate')
      case 'stale':
        return t('notelist.indexStale')
      case 'needs-rebuild':
        return t('notelist.indexNeedsRebuild')
      default:
        return ''
    }
  })

  /** Whether the index state deserves a visible chip (not the idle "no vault"). */
  const showIndexStatus = computed(
    () => documentList.indexState !== 'idle' && indexStatusLabel.value !== '',
  )

  function toggleContentSearch(): void {
    contentEnabled.value = !contentEnabled.value
  }

  function scheduleContentSearch(): void {
    if (contentSearchTimer) clearTimeout(contentSearchTimer)
    contentSearchTimer = setTimeout(() => {
      contentSearchTimer = null
      void search()
    }, CONTENT_SEARCH_DEBOUNCE_MS)
  }

  async function search(): Promise<void> {
    // Supersede any in-flight search, even when the query clears below: a real
    // AbortController stops the previous run's reads/matches instead of only
    // discarding its stale results.
    contentSearchAbort?.abort()
    contentSearchAbort = null
    const vault = vaultSession.vault
    const q = documentList.query.trim()
    if (!vault || !q) {
      contentResults.value = []
      contentSearched.value = false
      contentSearching.value = false
      return
    }
    const controller = new AbortController()
    contentSearchAbort = controller
    contentSearching.value = true
    const candidates: ContentSearchCandidate[] = documentList.notes.map((n) => ({
      path: n.path,
      name: n.name,
      title: n.title,
      tags: n.tags,
      summary: n.summary,
      readContent: () => vaultSession.noteContent(n.path),
    }))
    const hits = await searchWithIndex(
      candidates,
      q,
      (path) => vaultSession.indexEntryFor(path),
      controller.signal,
      CONTENT_SEARCH_CONCURRENCY,
    )
    if (controller.signal.aborted) return
    contentResults.value = hits
    contentSearching.value = false
    contentSearched.value = true
  }

  watch(() => vaultSession.vault, () => {
    contentEnabled.value = false
    clearContentResults()
  })

  watch(() => documentList.notes, () => {
    if (contentEnabled.value) scheduleContentSearch()
  })

  watch([() => documentList.query, contentEnabled], () => {
    if (!contentEnabled.value) {
      clearContentResults()
      return
    }
    scheduleContentSearch()
  })

  const activeTab = computed(() => tabs.activeTab)
  const activePath = computed(() => activeTab.value?.path ?? null)

  const relDir = computed(() => {
    const path = activePath.value
    if (!path || !vaultSession.vault) return ''
    return dirRelativeToVault(path, vaultSession.vault)
  })

  const outlineItems = computed(() => {
    const tab = activeTab.value
    if (!tab) return []
    const { body } = splitFrontmatter(tab.content)
    return parseOutline(body)
  })

  function relPath(path: string): string | null {
    if (!vaultSession.vault) return null
    const dir = dirRelativeToVault(path, vaultSession.vault)
    // The name must be derived with either separator in mind; on Windows this
    // produced the full absolute path and the backlink highlight never matched.
    const name = baseName(path)
    return dir ? `${dir}/${name}` : name
  }

  const links = computed((): NoteListLinks => {
    const tab = activeTab.value
    if (!tab || !tab.path) return { out: [], back: [] }
    return {
      out: outlinksOf(documentList.notes, vaultSession.vault, relDir.value, tab.content),
      back: inlinksOf(documentList.notes, relPath(tab.path)),
    }
  })

  /** The favorites as a Set: the card list asks it per card, and a Set is the
   *  snapshot `note-list-query` filters by, so the two cannot disagree. */
  const favorites = computed<ReadonlySet<string>>(() => new Set(documentList.favorites))

  const filterOptions = computed((): FilterOptions => ({
    filter: documentList.filter,
    query: documentList.query,
    favorites: favorites.value,
    recents: documentList.recents,
    sortBy: documentList.sortBy,
  }))

  const results = computed(() =>
    sort(filter(documentList.notes, filterOptions.value), documentList.sortBy),
  )

  return {
    panelMode: computed(() => documentList.panelMode),
    setMode: (mode: PanelMode) => documentList.setPanelMode(mode),
    listView: computed(() => documentList.listView),
    vault: computed(() => tabs.vault),
    activePath,
    hasActiveTab: computed(() => activeTab.value !== null),

    results,
    favorites,
    query: computed(() => documentList.query),
    setQuery: (value: string) => documentList.setQuery(value),
    sortOrder: computed(() => documentList.sortBy),
    setSortOrder: (sortBy: SortBy) => documentList.setSortBy(sortBy),

    contentEnabled: computed(() => contentEnabled.value),
    toggleContentSearch,
    contentResults: computed(() => contentResults.value),
    contentSearching: computed(() => contentSearching.value),
    contentSearched: computed(() => contentSearched.value),
    search,

    indexing: computed(() => documentList.indexing),
    indexState: computed(() => documentList.indexState),
    indexStatusLabel,
    showIndexStatus,
    vaultTruncated: computed(() => fileTree.vaultTruncated),
    rebuildIndex: () => {
      void vaultSession.rebuildIndex()
    },

    outlineItems,
    links,

    isFavorite: (path: string) => documentList.isFavorite(path),
    toggleFavorite: (path: string) => documentList.toggleFavorite(path),
  }
}
