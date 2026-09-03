import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

interface SeedFile {
  content: string
  mtime?: number
  size?: number
}

const seed = new Map<string, SeedFile>()
const changeHandlers = new Set<(e: { path: string; kind: string }) => void>()

vi.mock('../services/fs', () => ({
  fsService: {
    read: vi.fn(async (_v: string, path: string) => {
      const file = seed.get(path)
      if (!file) throw new Error(`missing: ${path}`)
      return file.content
    }),
    stat: vi.fn(async (_v: string, path: string) => {
      const file = seed.get(path)
      if (!file) throw new Error(`missing: ${path}`)
      return { mtime: file.mtime ?? 0, size: file.size ?? file.content.length }
    }),
    list: vi.fn(async (vault: string, dir: string) => listDir(vault, dir)),
    onFsChange: vi.fn(async (cb: (e: { path: string; kind: string }) => void) => {
      changeHandlers.add(cb)
      return () => changeHandlers.delete(cb)
    }),
    watch: vi.fn(async () => undefined),
  },
}))

import { fsService } from '../services/fs'
import { vaultFileIndex } from '../services/vaultFiles'
import { useLibraryStore } from './library'

function seedNote(path: string, content: string, mtime = 0): void {
  seed.set(path, { content, mtime })
}

function listDir(vault: string, dir: string): Array<{ name: string; path: string; is_dir: boolean; is_mdx: boolean }> {
  const v = vault.replace(/\/+$/, '')
  const base = dir.replace(/\/+$/, '')
  const relBase = base === '.' || base === '' || base === v ? '' : base.startsWith(`${v}/`) ? base.slice(v.length + 1) : base
  const prefix = relBase ? `${relBase}/` : ''
  const relOf = (p: string): string => (p === v ? '' : p.startsWith(`${v}/`) ? p.slice(v.length + 1) : p)
  const entries: Array<{ name: string; path: string; is_dir: boolean; is_mdx: boolean }> = []
  const dirs = new Set<string>()
  for (const p of seed.keys()) {
    const rel = relOf(p)
    if (!rel.startsWith(prefix)) continue
    const rest = rel.slice(prefix.length)
    if (rest === '') continue
    if (rest.includes('/')) {
      const top = rest.split('/')[0]
      if (!dirs.has(top)) {
        dirs.add(top)
        entries.push({ name: top, path: `${v}/${prefix}${top}`, is_dir: true, is_mdx: false })
      }
    } else {
      entries.push({ name: rest.split('/').pop() ?? rest, path: p, is_dir: false, is_mdx: /\.(md|mdx)$/i.test(p) })
    }
  }
  return entries
}

describe('useLibraryStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    seed.clear()
    changeHandlers.clear()
    vaultFileIndex.invalidate()
    vi.mocked(fsService.list).mockImplementation(async (vault: string, dir: string) => listDir(vault, dir))
  })

  it('indexes the vault with frontmatter title/tags, dirs and link extraction', async () => {
    seedNote('/vault/根.md', '# 根笔记\n\nroot body', 100)
    seedNote('/vault/sub/图论.md', '---\ntitle: 图论\ntags: [math, graph]\n---\n\n见 [根](../根.md)', 200)
    const store = useLibraryStore()
    await store.indexVault('/vault')
    expect(store.notes).toHaveLength(2)
    const root = store.notes.find((n) => n.path === '/vault/根.md')!
    const graph = store.notes.find((n) => n.path === '/vault/sub/图论.md')!
    expect(root.dir).toBe('')
    expect(root.title).toBe('根笔记')
    expect(graph.dir).toBe('sub')
    expect(graph.title).toBe('图论')
    expect(graph.tags).toEqual(['math', 'graph'])
    expect(graph.links).toEqual(['根.md'])
    expect(store.indexing).toBe(false)
  })

  it('aggregates tag counts and computes nav counts', async () => {
    seedNote('/vault/a.md', '---\ntags: [x]\n---\nA', 1)
    seedNote('/vault/b.md', '---\ntags: [x, y]\n---\nB', 2)
    seedNote('/vault/sub/c.md', 'C', 3)
    const store = useLibraryStore()
    await store.indexVault('/vault')
    expect(store.tagCounts).toEqual([
      { tag: 'x', count: 2 },
      { tag: 'y', count: 1 },
    ])
    expect(store.counts).toEqual({ all: 3, recent: 0, favorites: 0, uncategorized: 2 })
  })

  it('filters and sorts visibleNotes by filter, query and sort key', async () => {
    seedNote('/vault/alpha.md', '# Alpha\n\n包含 beta 词', 100)
    seedNote('/vault/sub/beta.md', '---\ntitle: Beta\ntags: [t1]\n---\n内容', 300)
    seedNote('/vault/gamma.md', 'Gamma', 200)
    const store = useLibraryStore()
    await store.indexVault('/vault')
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

  it('persists favorites/recents and prunes them for vanished files', async () => {
    seedNote('/vault/a.md', 'A', 1)
    seedNote('/vault/b.md', 'B', 2)
    const store = useLibraryStore()
    await store.indexVault('/vault')
    store.toggleFavorite('/vault/a.md')
    store.touchRecent('/vault/b.md')
    expect(store.isFavorite('/vault/a.md')).toBe(true)
    const saved = JSON.parse(localStorage.getItem('nekowite.library') ?? '{}')
    expect(saved.favorites).toEqual(['/vault/a.md'])
    expect(saved.recents).toEqual(['/vault/b.md'])
    seed.delete('/vault/a.md')
    await store.indexVault('/vault')
    expect(store.isFavorite('/vault/a.md')).toBe(false)
  })

  it('keeps recents as a deduplicated MRU capped at 20', () => {
    const store = useLibraryStore()
    for (let i = 0; i < 25; i++) store.touchRecent(`/vault/n${i}.md`)
    expect(store.recents).toHaveLength(20)
    expect(store.recents[0]).toBe('/vault/n24.md')
    store.touchRecent('/vault/n10.md')
    expect(store.recents[0]).toBe('/vault/n10.md')
    expect(store.recents.filter((p) => p === '/vault/n10.md')).toHaveLength(1)
  })

  it('switches list view and returns to notes on setFilter', async () => {
    seedNote('/vault/a.md', 'A', 1)
    const store = useLibraryStore()
    await store.indexVault('/vault')
    expect(store.listView).toBe('notes')
    store.setListView('graph')
    expect(store.listView).toBe('graph')
    store.setFilter('favorites')
    expect(store.listView).toBe('notes')
    expect(store.filter).toBe('favorites')
    store.setListView('attachments')
    expect(store.listView).toBe('attachments')
    await store.indexVault('/vault')
    expect(store.listView).toBe('notes')
  })

  it('re-indexes a changed file and drops removed ones from fs-change events', async () => {
    seedNote('/vault/a.md', 'A', 1)
    seedNote('/vault/b.md', 'B', 2)
    const store = useLibraryStore()
    await store.indexVault('/vault')
    expect(changeHandlers.size).toBe(1)
    const handler = [...changeHandlers][0]
    seedNote('/vault/a.md', '---\ntitle: 更新后\n---\nnew', 999)
    handler({ path: '/vault/a.md', kind: 'modify' })
    await vi.waitFor(() => {
      expect(store.notes.find((n) => n.path === '/vault/a.md')?.title).toBe('更新后')
    })
    handler({ path: '/vault/b.md', kind: 'remove' })
    await vi.waitFor(() => {
      expect(store.notes.map((n) => n.path)).toEqual(['/vault/a.md'])
    })
  })

  it('resolves link targets to indexed paths and computes outlinks/backlinks', async () => {
    seedNote('/vault/notes/main.md', '---\ntitle: 主页\n---\n[子页](./child.md) [外部](https://x.com/a.md)', 1)
    seedNote('/vault/notes/child.md', '---\ntitle: 子页\n---\n[回主](main.md)', 2)
    const store = useLibraryStore()
    await store.indexVault('/vault')
    const outlinks = store.outlinksOf('notes', '看 [子页](./child.md) 与 [失踪](nope.md)')
    expect(outlinks).toEqual([
      { text: '子页', target: './child.md', path: '/vault/notes/child.md' },
      { text: '失踪', target: 'nope.md', path: null },
    ])
    expect(store.inlinksOf('notes/child.md').map((n) => n.title)).toEqual(['主页'])
    expect(store.inlinksOf(null)).toEqual([])
    expect(store.resolveLinkPath('notes', 'missing.md')).toBeNull()
  })
})
