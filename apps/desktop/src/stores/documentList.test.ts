import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { NoteSummary } from '../services/noteMeta'
import { useDocumentListStore } from './documentList'

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
    store.toggleFavorite('/vault/a.md')
    store.touchRecent('/vault/b.md')
    expect(store.isFavorite('/vault/a.md')).toBe(true)
    const saved = JSON.parse(localStorage.getItem('nekowite.library') ?? '{}')
    expect(saved.favorites).toEqual(['/vault/a.md'])
    expect(saved.recents).toEqual(['/vault/b.md'])
    // Prune a vanished file via the coordinator callback.
    store.setFavoritesRecents([], ['/vault/b.md'])
    expect(store.favorites).toEqual([])
    expect(JSON.parse(localStorage.getItem('nekowite.library') ?? '{}').favorites).toEqual([])
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
