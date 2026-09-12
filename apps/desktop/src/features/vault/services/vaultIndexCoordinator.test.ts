import { describe, expect, it, vi } from 'vitest'
import { createMemoryFsGateway } from '../../../platform/gateways/memory'
import { ATTACHMENTS_DIR } from '../../../services/attachments'
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
  /** Every count the coordinator published, in order — the C7 test asserts that
   *  nothing is written after the current vault's own count has landed. */
  attachmentWrites: number[]
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
  /** Lets a test hold one vault's attachment-tree read, so a switch can happen
   *  while that vault's badge count is still being computed. */
  holdAttachmentList?: (vault: string, dir: string) => Promise<void>
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
    attachmentWrites: [],
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
    list: async (v, d) => {
      if (opts.holdAttachmentList && d === ATTACHMENTS_DIR) await opts.holdAttachmentList(v, d)
      return gateway.list(v, d)
    },
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
      state.attachmentWrites.push(n)
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

// C7: the badge refresh is debounced and then reads the whole attachment tree
// (several awaits). A vault switch landing inside that window used to write the
// PREVIOUS vault's count into the new vault's badge: the debounced call passed no
// generation, and the "no generation" branch of the guard wrote unconditionally.
describe('attachment badge', () => {
  it('does not write a count computed for the previous vault after a switch', async () => {
    let hold = false
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = makeCoordinator({
      seed: {
        '/vaultA/a.md': '# A',
        '/vaultB/b.md': '# B',
        // The memory gateway keys listings by path, so the attachment tree is
        // shared here; the assertion below counts WRITES, which is what the bug
        // was about (a previous vault's count landing after the switch).
        'attachments/one.png': 'x',
      },
      fileIndex: {
        get: (v) => Promise.resolve(v === '/vaultB' ? ['/vaultB/b.md'] : ['/vaultA/a.md']),
        isTruncated: () => false,
        invalidate: () => {},
      },
      // Only the PREVIOUS vault's read is held: the new vault's own count must
      // land normally so the assertion can prove nothing follows it.
      holdAttachmentList: (v) => (hold && v === '/vaultA' ? held : Promise.resolve()),
    })
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

    await h.coordinator.indexVault('/vaultA')
    await flush()

    // A new image lands in A: the badge refresh is debounced (200ms) and then
    // starts reading A's attachment tree.
    hold = true
    h.emit({ path: '/vaultA/attachments/three.png', kind: 'created' })
    await new Promise((r) => setTimeout(r, 250))

    // The vault switches while that count is still in flight, and the new vault
    // publishes its own badge count.
    await h.coordinator.indexVault('/vaultB')
    await flush()
    const writesBefore = h.state.attachmentWrites.length

    // Only now does the previous vault's read resolve: its count belongs to the
    // vault that was left, so it must not be published into the new one.
    release()
    await flush()
    expect(h.state.attachmentWrites.slice(writesBefore)).toEqual([])
  })
})

describe('structural folder changes', () => {
  it('re-reads the note list when a folder that held notes disappears', async () => {
    // The event for a folder delete arrives for the FOLDER only — there is no
    // per-child event to rely on — so without a re-index the note list kept
    // listing notes that are gone and clicking one failed only later, at read
    // time. The file list is mutable here so the test can prove the re-read.
    const files = ['/v/notes/a.md', '/v/notes/b.md']
    const h = makeCoordinator({
      seed: { '/v/notes/a.md': '# A', '/v/notes/b.md': '# B' },
      fileIndex: {
        get: async () => [...files],
        isTruncated: () => false,
        invalidate: () => {},
      },
    })
    await h.coordinator.indexVault('/v')
    expect(h.state.notes.map((n) => n.path).sort()).toEqual(['/v/notes/a.md', '/v/notes/b.md'])

    // The folder is deleted: the vault walk no longer returns its contents.
    files.length = 0
    h.emit({ path: '/v/notes', kind: 'removed' })
    await vi.waitFor(() =>
      expect(h.state.notes.map((n) => n.path)).toEqual([]),
    )
  })

  it('does not re-read the vault for an attachment that no note references', async () => {
    const h = makeCoordinator({
      seed: { '/v/a.md': '# A' },
      fileIndex: {
        get: async () => ['/v/a.md'],
        isTruncated: () => false,
        invalidate: () => {},
      },
    })
    await h.coordinator.indexVault('/v')
    const before = h.readCount()
    h.emit({ path: '/v/attachments/2026-09/pic.png', kind: 'created' })
    await new Promise((r) => setTimeout(r, 400))
    expect(h.readCount()).toBe(before)
  })
})
