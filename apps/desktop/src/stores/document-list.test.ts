import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { NoteSummary } from '../features/notes'
import { useDocumentListStore } from './document-list'

/**
 * Run `body` with `window.localStorage` replaced by `descriptor`, then put the
 * original property back (the suite shares one Storage instance).
 */
function withStorageDescriptor(descriptor: PropertyDescriptor, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
  if (!original) throw new Error('the test setup did not install a localStorage')
  Object.defineProperty(window, 'localStorage', descriptor)
  try {
    body()
  } finally {
    Object.defineProperty(window, 'localStorage', original)
  }
}

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

describe('useDocumentListStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('filters and sorts visibleNotes by filter, query and sort key', () => {
    const store = useDocumentListStore()
    store.setNotes([
      note('/vault/alpha.md', { title: 'Alpha', mtime: 100, summary: '包含 beta 词' }),
      note('/vault/sub/beta.md', { title: 'Beta', tags: ['t1'], mtime: 300, dir: 'sub' }),
      note('/vault/gamma.md', { title: 'gamma', mtime: 200 }),
    ])
    expect(store.visibleNotes.map((n) => n.name)).toEqual(['beta.md', 'gamma.md', 'alpha.md'])
    store.setSortBy('title')
    expect(store.visibleNotes.map((n) => n.title)).toEqual(['Alpha', 'Beta', 'gamma'])
    store.setFilter('tag:t1')
    expect(store.visibleNotes.map((n) => n.name)).toEqual(['beta.md'])
    store.setFilter('uncategorized')
    expect(store.visibleNotes.map((n) => n.name)).toEqual(['alpha.md', 'gamma.md'])
    store.setFilter('all')
    store.setQuery('beta 词')
    expect(store.visibleNotes.map((n) => n.name)).toEqual(['alpha.md'])
    store.setQuery('  ')
    expect(store.visibleNotes).toHaveLength(3)
  })

  it('aggregates tag counts and nav counts', () => {
    const store = useDocumentListStore()
    store.setNotes([
      note('/vault/a.md', { tags: ['x'] }),
      note('/vault/b.md', { tags: ['x', 'y'] }),
      note('/vault/sub/c.md', { dir: 'sub' }),
    ])
    expect(store.tagCounts).toEqual([
      { tag: 'x', count: 2 },
      { tag: 'y', count: 1 },
    ])
    expect(store.counts).toEqual({ all: 3, recent: 0, favorites: 0, uncategorized: 2 })
  })

  it('keeps recents as a deduplicated MRU capped at 20', () => {
    const store = useDocumentListStore()
    for (let i = 0; i < 25; i++) store.touchRecent(`/vault/n${i}.md`)
    expect(store.recents).toHaveLength(20)
    expect(store.recents[0]).toBe('/vault/n24.md')
    store.touchRecent('/vault/n10.md')
    expect(store.recents[0]).toBe('/vault/n10.md')
    expect(store.recents.filter((p) => p === '/vault/n10.md')).toHaveLength(1)
  })

  it('persists favorites/recents and prunes vanished files', () => {
    const store = useDocumentListStore()
    store.resetForVault('/vault')
    store.toggleFavorite('/vault/a.md')
    store.touchRecent('/vault/b.md')
    expect(store.isFavorite('/vault/a.md')).toBe(true)
    // Storage is bucketed per vault root, so one vault's list can never be
    // mistaken for another's.
    const saved = JSON.parse(localStorage.getItem('nekowite.library') ?? '{}')
    expect(saved['/vault'].favorites).toEqual(['/vault/a.md'])
    expect(saved['/vault'].recents).toEqual(['/vault/b.md'])
    // Prune a vanished file via the coordinator callback.
    store.setFavoritesRecents([], ['/vault/b.md'])
    expect(store.favorites).toEqual([])
    expect(JSON.parse(localStorage.getItem('nekowite.library') ?? '{}')['/vault'].favorites).toEqual([])
  })

  // C2: favorites/recents used to share ONE persisted pair for the whole app
  // while the "prune what is gone" callback pruned it against the CURRENT vault.
  // Switching vaults therefore deleted the previous vault's favorites for good:
  // its paths were not in the new vault's file list, so they were filtered out
  // of the only copy that existed.
  it('keeps every vault’s favorites/recents in its own bucket across a switch', () => {
    const store = useDocumentListStore()
    store.resetForVault('/vaultA')
    store.toggleFavorite('/vaultA/a.md')
    store.touchRecent('/vaultA/a.md')

    // Switch to another vault: it starts from its own (empty) list.
    store.resetForVault('/vaultB')
    expect(store.favorites).toEqual([])
    // The re-index of B finds none of its own files gone-and-favorited, and even
    // an explicit prune of the current bucket must not touch A's entries.
    store.setFavoritesRecents([], [])
    expect(store.favorites).toEqual([])

    // Back to A: its entries are still there.
    store.resetForVault('/vaultA')
    expect(store.favorites).toEqual(['/vaultA/a.md'])
    expect(store.recents).toEqual(['/vaultA/a.md'])

    // A relaunch (fresh store) reads the same buckets back.
    setActivePinia(createPinia())
    const reopened = useDocumentListStore()
    reopened.resetForVault('/vaultA')
    expect(reopened.favorites).toEqual(['/vaultA/a.md'])
    expect(reopened.recents).toEqual(['/vaultA/a.md'])
  })

  // C2 migration: the pre-bucket format stored one `{ favorites, recents }` pair
  // for the whole app. It must be moved into the vault it belongs to, not dropped.
  it('migrates the legacy single-bucket favorites into the recorded vault', () => {
    localStorage.setItem(
      'nekowite.library',
      JSON.stringify({ favorites: ['/vault/a.md'], recents: ['/vault/b.md'] }),
    )
    // The old build recorded the vault it had open (appBootstrap owns this key).
    localStorage.setItem('nekowite.vault', '/vault')
    const store = useDocumentListStore()
    // Adopted on the first read, so the user's favorites are visible again.
    expect(store.favorites).toEqual(['/vault/a.md'])
    expect(store.recents).toEqual(['/vault/b.md'])
    // ...and they survive another vault's re-index prune round-trip.
    store.resetForVault('/other')
    store.setFavoritesRecents([], [])
    store.resetForVault('/vault')
    expect(store.favorites).toEqual(['/vault/a.md'])
    // The legacy blob is gone from storage: it was moved, not duplicated.
    const saved = JSON.parse(localStorage.getItem('nekowite.library') ?? '{}')
    expect(saved['/other']).toEqual({ favorites: [], recents: [] })
    expect(saved.__adopted__).toBeUndefined()
  })

  it('adopts a legacy blob with no recorded vault into the first vault that opens', () => {
    localStorage.setItem('nekowite.library', JSON.stringify({ favorites: ['/legacy/only.md'] }))
    const store = useDocumentListStore()
    expect(store.favorites).toEqual([])
    store.resetForVault('/vaultA')
    expect(store.favorites).toEqual(['/legacy/only.md'])
    // Moved, not copied: a second vault must not inherit the first vault's list.
    store.resetForVault('/vaultB')
    expect(store.favorites).toEqual([])
  })

  // C3: the store is built while the shell mounts, so an unguarded storage access
  // is not cosmetic — it aborts the render (white screen), and a quota error on
  // the write surfaces at the click that toggled the favorite.
  it('constructs and toggles favorites when the storage getter throws', () => {
    withStorageDescriptor(
      {
        configurable: true,
        get() {
          throw new Error('storage disabled')
        },
      },
      () => {
        expect(() => useDocumentListStore()).not.toThrow()
        const store = useDocumentListStore()
        store.resetForVault('/vault')
        expect(() => store.toggleFavorite('/vault/a.md')).not.toThrow()
        expect(store.isFavorite('/vault/a.md')).toBe(true)
        expect(() => store.touchRecent('/vault/b.md')).not.toThrow()
        expect(store.recents).toEqual(['/vault/b.md'])
      },
    )
  })

  it('swallows a quota error from the write', () => {
    const store = useDocumentListStore()
    store.resetForVault('/vault')
    const storage = window.localStorage
    const originalSetItem = storage.setItem
    storage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      expect(() => store.toggleFavorite('/vault/a.md')).not.toThrow()
      expect(store.isFavorite('/vault/a.md')).toBe(true)
    } finally {
      storage.setItem = originalSetItem
    }
  })

  it('setFilter resets listView/panelMode to notes; resetForVault clears the session', () => {
    const store = useDocumentListStore()
    store.setListView('graph')
    store.setPanelMode('outline')
    store.setFilter('favorites')
    expect(store.listView).toBe('notes')
    expect(store.panelMode).toBe('notes')
    expect(store.filter).toBe('favorites')
    store.setNotes([note('/vault/a.md')])
    store.resetForVault()
    expect(store.notes).toEqual([])
    expect(store.filter).toBe('all')
    expect(store.query).toBe('')
    expect(store.listView).toBe('notes')
    expect(store.indexing).toBe(false)
  })
})
