import { describe, expect, it, vi } from 'vitest'
import { createMemoryFsGateway } from '../../../platform/gateways/memory'
import { ContentCache } from '../../../services/contentCache'
import { clearIndex, loadIndex, saveIndex, type AsyncIndexStorage } from '../../../services/searchIndex'
import type { NoteSummary } from '../../../services/noteMeta'
import type { FsChangeEvent } from '../../../platform/gateways/contracts'
import { createVaultIndexCoordinator } from './vaultIndexCoordinator'

function memStorage(): AsyncIndexStorage {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, String(v))
    },
    removeItem: async (k) => {
      m.delete(k)
    },
  }
}

interface CoState {
  notes: NoteSummary[]
  indexing: boolean
  truncated: boolean
  attachmentCount: number
  indexState: string
  favorites: string[]
  recents: string[]
}

interface CoordinatorHarness {
  coordinator: ReturnType<typeof createVaultIndexCoordinator>
  gateway: ReturnType<typeof createMemoryFsGateway>
  state: CoState
  emit: (e: FsChangeEvent) => void
  readCount: () => number
}

function makeCoordinator(opts: {
  seed: Record<string, string>
  fileIndex: { get: (v: string) => Promise<string[]>; isTruncated: (v: string) => boolean; invalidate: (v: string) => void }
  holdFirstFsChange?: () => Promise<() => void>
}): CoordinatorHarness {
  const gateway = createMemoryFsGateway(opts.seed)
  const cache = new ContentCache()
  const storage = memStorage()
  const handlers = new Set<(e: FsChangeEvent) => void>()
  let fsCalls = 0
  let reads = 0
  const state: CoState = {
    notes: [],
    indexing: false,
    truncated: false,
    attachmentCount: 0,
    indexState: 'idle',
    favorites: [],
    recents: [],
  }
  const read = (v: string, p: string): Promise<string> => {
    reads += 1
    return gateway.read(v, p)
  }
  const coordinator = createVaultIndexCoordinator({
    read,
    stat: (v, p) => gateway.stat(v, p),
    list: (v, d) => gateway.list(v, d),
    onFsChange: (cb) => {
      fsCalls += 1
      if (opts.holdFirstFsChange && fsCalls === 1) return opts.holdFirstFsChange()
      handlers.add(cb)
      return Promise.resolve(() => {
        handlers.delete(cb)
      })
    },
    fileIndex: opts.fileIndex,
    cache,
    loadIndex: (v) => loadIndex(v, storage),
    saveIndex: (i) => saveIndex(i, storage),
    clearIndex: (v) => clearIndex(v, storage),
    onNotes: (n) => {
      state.notes = n
    },
    onIndexing: (v) => {
      state.indexing = v
    },
    onTruncated: (v) => {
      state.truncated = v
    },
    onAttachmentCount: (n) => {
      state.attachmentCount = n
    },
    onNotesPruned: (favs, recents) => {
      state.favorites = favs
      state.recents = recents
    },
    onIndexState: (s) => {
      state.indexState = s
    },
    getFavorites: () => state.favorites,
    getRecents: () => state.recents,
  })
  return {
    coordinator,
    gateway,
    state,
    readCount: () => reads,
    emit: (e) => {
      for (const h of handlers) h(e)
    },
  }
}

const SAME_FILES = {
  get: (v: string) => Promise.resolve([`${v}/根.md`, `${v}/sub/图论.md`]),
  isTruncated: () => false,
  invalidate: () => {},
}

describe('createVaultIndexCoordinator (memory fs gateway, no Vue)', () => {
  it('indexes the vault into NoteSummary[] without Vue/Pinia', async () => {
    const h = makeCoordinator({
      seed: {
        '/vault/根.md': '# 根笔记\n\nroot body',
        '/vault/sub/图论.md': '---\ntitle: 图论\ntags: [math, graph]\n---\n\n见 [根](../根.md)',
      },
      fileIndex: SAME_FILES,
    })
    await h.coordinator.indexVault('/vault')
    expect(h.state.notes).toHaveLength(2)
    const root = h.state.notes.find((n) => n.path === '/vault/根.md')!
    const graph = h.state.notes.find((n) => n.path === '/vault/sub/图论.md')!
    expect(root.dir).toBe('')
    expect(root.title).toBe('根笔记')
    expect(graph.dir).toBe('sub')
    expect(graph.title).toBe('图论')
    expect(graph.tags).toEqual(['math', 'graph'])
    expect(graph.links).toEqual(['根.md'])
    expect(h.state.indexing).toBe(false)
  })

  it('re-indexes a changed note and drops a removed one from fs-change events', async () => {
    const h = makeCoordinator({
      seed: { '/vault/a.md': 'A', '/vault/b.md': 'B' },
      fileIndex: { get: () => Promise.resolve(['/vault/a.md', '/vault/b.md']), isTruncated: () => false, invalidate: () => {} },
    })
    await h.coordinator.indexVault('/vault')
    // Change file a.md on disk, then emit a modify event.
    await h.gateway.write('/vault', '/vault/a.md', '---\ntitle: 更新后\n---\nnew')
    h.emit({ path: '/vault/a.md', kind: 'modified' })
    await vi.waitFor(() => {
      expect(h.state.notes.find((n) => n.path === '/vault/a.md')?.title).toBe('更新后')
    })
    // Remove b.md on disk and emit remove.
    h.emit({ path: '/vault/b.md', kind: 'removed' })
    await vi.waitFor(() => {
      expect(h.state.notes.map((n) => n.path)).toEqual(['/vault/a.md'])
    })
  })

  it('coalesces a burst of markdown change events into a single re-index', async () => {
    const h = makeCoordinator({
      seed: { '/vault/a.md': 'A' },
      fileIndex: { get: () => Promise.resolve(['/vault/a.md']), isTruncated: () => false, invalidate: () => {} },
    })
    await h.coordinator.indexVault('/vault')
    const readsBefore = h.readCount()
    await h.gateway.write('/vault', '/vault/a.md', '---\ntitle: 第一版\n---\none')
    h.emit({ path: '/vault/a.md', kind: 'modified' })
    await h.gateway.write('/vault', '/vault/a.md', '---\ntitle: 最终版\n---\ntwo')
    h.emit({ path: '/vault/a.md', kind: 'modified' })
    await vi.waitFor(() => {
      expect(h.state.notes.find((n) => n.path === '/vault/a.md')?.title).toBe('最终版')
    })
    // Both events coalesce into a single fresh read of the note.
    expect(h.readCount() - readsBefore).toBe(1)
  })

  it('switching vault cancels the prior index tasks and clears its subscription (latest-wins)', async () => {
    // First onFsChange is held so the first switch is stuck mid-flight; the
    // second switch lands first and must win.
    let releaseFirst!: (unsub: () => void) => void
    const held = new Promise<() => void>((resolve) => {
      releaseFirst = resolve
    })
    const h = makeCoordinator({
      seed: {
        '/vaultA/a.md': 'AAA',
        '/vaultB/b.md': 'BBB',
      },
      fileIndex: {
        get: (v) => Promise.resolve([`${v}${v === '/vaultB' ? '/b.md' : '/a.md'}`]),
        isTruncated: () => false,
        invalidate: () => {},
      },
      holdFirstFsChange: () => held,
    })
    const pA = h.coordinator.indexVault('/vaultA') // stuck at onFsChange
    expect(h.state.notes).toEqual([]) // old notes cleared immediately

    const pB = h.coordinator.indexVault('/vaultB') // proceeds immediately
    await vi.waitFor(() => expect(h.state.notes.map((n) => n.path)).toEqual(['/vaultB/b.md']))

    // Release the stale switch: it must detect supersession and never write.
    releaseFirst(() => {})
    await pA
    expect(h.state.notes.map((n) => n.path)).toEqual(['/vaultB/b.md'])
    await pB
  })

  it('exports read helpers after a build (entryFor + candidatePaths)', async () => {
    const h = makeCoordinator({
      seed: {
        '/vault/a.md': '---\ntitle: Alpha\n---\n关于图论与算法',
        '/vault/sub/b.md': '---\ntitle: Beta\n---\n与图论无关的内容',
      },
      fileIndex: {
        get: () => Promise.resolve(['/vault/a.md', '/vault/sub/b.md']),
        isTruncated: () => false,
        invalidate: () => {},
      },
    })
    await h.coordinator.indexVault('/vault')
    await h.coordinator.buildSearchIndex('/vault')
    expect(h.coordinator.indexCandidatePaths('图论')).toEqual(['/vault/a.md', '/vault/sub/b.md'])
    expect(h.coordinator.indexCandidatePaths('无关')).toEqual(['/vault/sub/b.md'])
    const entry = h.coordinator.indexEntryFor('/vault/a.md')
    expect(entry?.text).toContain('图论')
  })
})
