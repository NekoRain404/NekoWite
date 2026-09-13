/**
 * The note list's public interface.
 *
 * The panel tests cover what the feature renders; these cases pin the model
 * itself — the projection the panel draws from, the commands that write the
 * list state back, and the content-search run (which no other test reaches,
 * because it is a mode the user has to switch on).
 *
 * The composable is mounted inside a real component: its watchers and computed
 * properties need an effect scope, and mounting is how the app gives it one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useNoteList, type NoteListModel } from './useNoteList'
import { useDocumentListStore } from '../../../stores/documentList'
import { useTabsStore } from '../../../stores/tabs'
import { useVaultSessionStore } from '../../../stores/vaultSession'
import type { NoteSummary } from '../../../services/noteMeta'

const searchMocks = vi.hoisted(() => ({ searchWithIndex: vi.fn() }))

vi.mock('../../../services/contentSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/contentSearch')>()
  return { ...actual, searchWithIndex: searchMocks.searchWithIndex }
})

function note(path: string, over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    path,
    name: path.split('/').pop() ?? path,
    title: path.split('/').pop()?.replace(/\.mdx?$/i, '') ?? path,
    tags: [],
    summary: '',
    mtime: 0,
    size: 0,
    dir: '',
    links: [],
    ...over,
  }
}

const NOTES: NoteSummary[] = [
  note('/vault/alpha.md', { title: 'Alpha', mtime: 100 }),
  note('/vault/sub/beta.md', { title: 'Beta', mtime: 300, dir: 'sub' }),
  note('/vault/gamma.md', { title: 'gamma', mtime: 200 }),
]

let pinia: Pinia
let mounted: VueApp[] = []
let model: NoteListModel | null = null

function mountModel(): NoteListModel {
  let created: NoteListModel | null = null
  const app = createApp({
    setup() {
      created = useNoteList()
      return () => null
    },
  })
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)
  model = created!
  return created!
}

describe('useNoteList', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    searchMocks.searchWithIndex.mockReset()
    searchMocks.searchWithIndex.mockResolvedValue([])
  })

  afterEach(() => {
    // Turning the mode off tears the run down, so no debounce timer outlives the
    // component that scheduled it.
    if (model?.contentEnabled.value) model.toggleContentSearch()
    model = null
    for (const app of mounted) app.unmount()
    mounted = []
  })

  it('projects the indexed notes through the pure query', () => {
    useDocumentListStore().setNotes(NOTES)
    const list = mountModel()

    expect(list.results.value.map((n) => n.name)).toEqual(['beta.md', 'gamma.md', 'alpha.md'])
    list.setSortOrder('name')
    expect(list.results.value.map((n) => n.name)).toEqual(['alpha.md', 'beta.md', 'gamma.md'])
    list.setQuery('beta')
    expect(list.results.value.map((n) => n.name)).toEqual(['beta.md'])
  })

  it('writes the query, the sort key and the mode back to the list state', () => {
    const documentList = useDocumentListStore()
    const list = mountModel()

    expect(list.query.value).toBe('')
    list.setQuery('gamma')
    expect(documentList.query).toBe('gamma')
    expect(list.query.value).toBe('gamma')

    expect(list.sortOrder.value).toBe('mtime')
    list.setSortOrder('title')
    expect(documentList.sortBy).toBe('title')
    expect(list.sortOrder.value).toBe('title')

    list.setMode('links')
    expect(documentList.panelMode).toBe('links')
    expect(list.panelMode.value).toBe('links')
    expect(list.listView.value).toBe('notes')
  })

  it('reports favourites as one snapshot and toggles them by path', () => {
    const list = mountModel()

    expect(list.isFavorite('/vault/beta.md')).toBe(false)
    list.toggleFavorite('/vault/beta.md')
    expect(list.isFavorite('/vault/beta.md')).toBe(true)
    expect(list.favorites.value.has('/vault/beta.md')).toBe(true)
    list.toggleFavorite('/vault/beta.md')
    expect(list.favorites.value.has('/vault/beta.md')).toBe(false)
  })

  it('reports the vault, the open tab and the outline of its content', () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const list = mountModel()
    expect(list.vault.value).toBe('/vault')
    expect(list.hasActiveTab.value).toBe(false)
    expect(list.activePath.value).toBeNull()
    expect(list.outlineItems.value).toEqual([])

    tabs.tabs.push({
      id: 't1',
      path: '/vault/beta.md',
      content: '# Beta\n\n## Head\n',
      savedContent: '# Beta\n\n## Head\n',
      dirty: false,
      pendingAssetPaths: [],
    })
    tabs.setActive('t1')
    expect(list.hasActiveTab.value).toBe(true)
    expect(list.activePath.value).toBe('/vault/beta.md')
    expect(list.outlineItems.value).toEqual([
      { level: 1, text: 'Beta', line: 0, index: 0 },
      { level: 2, text: 'Head', line: 2, index: 1 },
    ])
  })

  it('runs the content search on demand and reports what it found', async () => {
    useDocumentListStore().setNotes(NOTES)
    useVaultSessionStore().vault = '/vault'
    searchMocks.searchWithIndex.mockResolvedValue([
      { path: '/vault/sub/beta.md', name: 'beta.md', snippet: 'a beta body' },
    ])
    const list = mountModel()

    expect(list.contentEnabled.value).toBe(false)
    list.setQuery('beta')
    list.toggleContentSearch()
    expect(list.contentEnabled.value).toBe(true)

    await list.search()
    expect(searchMocks.searchWithIndex).toHaveBeenCalledTimes(1)
    const [candidates, query, , signal] = searchMocks.searchWithIndex.mock.calls[0]
    expect(query).toBe('beta')
    expect(candidates.map((c: { path: string }) => c.path)).toEqual([
      '/vault/alpha.md',
      '/vault/sub/beta.md',
      '/vault/gamma.md',
    ])
    // Superseding a run needs a real signal, not just a discarded result.
    expect(signal).toBeInstanceOf(AbortSignal)

    expect(list.contentResults.value).toHaveLength(1)
    expect(list.contentSearched.value).toBe(true)
    expect(list.contentSearching.value).toBe(false)

    // Switching the mode back off clears the run and cancels the debounce timer.
    list.toggleContentSearch()
    await nextTick()
    expect(list.contentEnabled.value).toBe(false)
    expect(list.contentResults.value).toEqual([])
  })

  it('searches nothing without a vault or a query', async () => {
    useDocumentListStore().setNotes(NOTES)
    const list = mountModel()

    list.toggleContentSearch()
    list.setQuery('beta')
    await list.search()

    expect(searchMocks.searchWithIndex).not.toHaveBeenCalled()
    expect(list.contentResults.value).toEqual([])
    expect(list.contentSearched.value).toBe(false)
  })
})
