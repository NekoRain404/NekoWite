import { describe, expect, it, vi } from 'vitest'
import { createMemoryFsGateway } from '../../../platform/gateways/memory'
import { ATTACHMENTS_DIR } from '../../attachments'
import { ContentCache } from '../../../services/content-cache'
import { clearIndex, loadIndex, saveIndex, type AsyncIndexStorage } from '../../../services/search-index'
import { searchWithIndex } from '../../../services/content-search'
import type { NoteSummary } from '../../../services/note-meta'
import type { FsChangeEvent } from '../../../platform/gateways/contracts'
import { createVaultIndexCoordinator } from './vault-index-coordinator'
import { createVaultNoteIndex } from './vault-note-index'

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
  /** Every `onFsWatch` report, in order. */
  watchReports: string[]
  /** How many full note-index runs have STARTED. `onIndexing(true)` is published
   *  once per `runIndex`, so this counts runs rather than observable reads (a
   *  re-index of an unchanged vault reads nothing). */
  indexRuns: number
}

interface CoordinatorHarness {
  coordinator: ReturnType<typeof createVaultIndexCoordinator>
  gateway: ReturnType<typeof createMemoryFsGateway>
  state: CoState
  emit: (e: FsChangeEvent) => void
  readCount: () => number
  /** How many times the coordinator asked for an fs-change subscription: what a
   *  detached coordinator must stop doing for the vault it left. */
  fsCalls: () => number
}

function makeCoordinator(opts: {
  seed: Record<string, string>
  fileIndex: { get: (v: string) => Promise<string[]>; isTruncated: (v: string) => boolean; invalidate: (v: string) => void }
  holdFirstFsChange?: () => Promise<() => void>
  /** Fail the first N subscription attempts (models a webview whose event
   *  system is unavailable). */
  failFsChangeTimes?: number
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
    watchReports: [],
    indexRuns: 0,
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
      if (opts.failFsChangeTimes && fsCalls <= opts.failFsChangeTimes) {
        return Promise.reject(new Error('events unavailable'))
      }
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
      if (v) state.indexRuns += 1
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
    onFsWatch: (ok, error) => {
      state.watchReports.push(ok ? 'ok' : `fail:${(error as Error)?.message ?? ''}`)
    },
    getFavorites: () => state.favorites,
    getRecents: () => state.recents,
  })
  return {
    coordinator,
    gateway,
    state,
    readCount: () => reads,
    fsCalls: () => fsCalls,
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

// `detach()` is the whole vault-session teardown, but the coordinator OBJECT
// survives it: every port it owns (`rebuildIndex`, `noteContent`, and the search
// index's own vault checks) reads `currentVault` as "a vault is open". Leaving
// it set meant a coordinator held past detach still read, still re-indexed and
// still re-subscribed for the vault that was left. Nothing in the app holds one
// today (the session store drops its coordinator before creating the next), so
// these are defensive: detach is the function that claims to clear vault state,
// and the next caller to keep a coordinator will not know it was unsafe.
describe('detach (a coordinator held past it outlives nothing)', () => {
  function makeDetachCase() {
    const files = ['/vault/a.md']
    return {
      h: makeCoordinator({
        seed: { '/vault/a.md': '# A', '/vault/b.md': 'B', '/vault/未索引.md': '从未被索引过' },
        fileIndex: {
          get: async () => [...files],
          isTruncated: () => false,
          invalidate: () => {},
        },
      }),
      files,
    }
  }

  it('does not re-index, re-publish or re-subscribe for the vault it left', async () => {
    const { h, files } = makeDetachCase()
    await h.coordinator.indexVault('/vault')
    await h.coordinator.buildSearchIndex('/vault')
    expect(h.coordinator.indexEntryFor('/vault/a.md')).not.toBeNull()

    h.coordinator.detach()
    const notesAtDetach = h.state.notes
    const fsCallsAtDetach = h.fsCalls()
    // A note appeared in the vault that was left. A held coordinator that
    // re-indexes would publish it into whatever list is on screen now.
    files.push('/vault/b.md')

    // `rebuildIndex` is the "refresh this list" button. On a coordinator that
    // outlived its vault it belongs to nobody, so it must not re-index the left
    // vault, rebuild that vault's persistent index, or re-establish its fs watch.
    await h.coordinator.rebuildIndex()

    expect(h.state.notes.map((n) => n.path)).toEqual(['/vault/a.md'])
    // Nothing published at all, not merely nothing new.
    expect(h.state.notes).toBe(notesAtDetach)
    expect(h.coordinator.indexEntryFor('/vault/a.md')).toBeNull()
    // The re-subscribe half: `fsWatch.stop()` clears the degraded flag, so
    // today's `rebuildIndex` would not reach its retry branch even without the
    // fix. Pinned here so the branch cannot start firing for a left vault if
    // that ordering ever changes.
    expect(h.fsCalls()).toBe(fsCallsAtDetach)
  })

  it('does not read a note body through the vault it left', async () => {
    const { h } = makeDetachCase()
    await h.coordinator.indexVault('/vault')
    h.coordinator.detach()
    const readsBefore = h.readCount()

    // A path the note index never cached: returning its body could only mean
    // reading the vault that was left. `readBody` already takes `null` to mean
    // "no vault is open"; detach is what makes that true.
    expect(await h.coordinator.noteContent('/vault/未索引.md')).toBeNull()
    expect(h.readCount()).toBe(readsBefore)
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

// A `resync` is not a change to one path: it is the watcher saying it lost
// events (an overflowing OS queue, an exhausted handle), which makes it the one
// case where the watcher KNOWS its mirror may be wrong. Dropping the file-list
// cache without re-indexing meant every change it missed stayed missed — the
// note list kept showing what it saw at index time, for good.
//
// The path it carries is the WATCH ROOT (Rust emits `watch_root`), which the
// md/attachment heuristics read as an ordinary non-structural folder event —
// which is exactly why it used to do nothing.
describe('watcher resync', () => {
  const VAULT_ROOT_RESYNC: FsChangeEvent = { path: '/vault', kind: 'resync' }

  /** A mutable vault file list, so a re-read is observable. */
  function mutableFiles(files: string[]) {
    return {
      get: async () => [...files],
      isTruncated: () => false,
      invalidate: () => {},
    }
  }

  it('re-reads the vault, so a note created while events were being lost is recovered', async () => {
    const files = ['/vault/a.md']
    const h = makeCoordinator({
      seed: { '/vault/a.md': '# A', '/vault/b.md': '---\ntitle: B\n---\nB' },
      fileIndex: mutableFiles(files),
    })
    await h.coordinator.indexVault('/vault')
    expect(h.state.notes.map((n) => n.path)).toEqual(['/vault/a.md'])

    // Created outside the app while the watcher was losing events: no per-path
    // event for it is coming, so the resync is the only notice there will be.
    files.push('/vault/b.md')
    h.emit(VAULT_ROOT_RESYNC)

    await vi.waitFor(() => {
      expect(
        h.state.notes.map((n) => n.path).sort(),
      ).toEqual(['/vault/a.md', '/vault/b.md'])
    })
  })

  it('collapses a burst of resyncs into a single re-index', async () => {
    const files = ['/vault/a.md']
    const h = makeCoordinator({
      seed: { '/vault/a.md': '# A', '/vault/b.md': 'B' },
      fileIndex: mutableFiles(files),
    })
    await h.coordinator.indexVault('/vault')
    files.push('/vault/b.md')
    const runsBefore = h.state.indexRuns

    h.emit(VAULT_ROOT_RESYNC)
    h.emit(VAULT_ROOT_RESYNC)
    h.emit({ path: '/vault', kind: 'resync' })
    await vi.waitFor(() => expect(h.state.notes).toHaveLength(2))
    // Past the debounce window: a run per event would have started two more.
    await new Promise((r) => setTimeout(r, 300))
    expect(h.state.indexRuns - runsBefore).toBe(1)
  })

  it('does not drop a resync that lands while a full re-index is in flight', async () => {
    // Supersede, not queue: this follows the rule the coordinator already
    // applies to full runs (latest-wins, one generation read when the work
    // starts). The in-flight run is neither cancelled nor allowed to swallow
    // the request — the resync replaces the ONE pending slot and a fresh run
    // follows. A "busy, ignore it" guard would lose the only notice the watcher
    // will ever give that it missed a change.
    const files = ['/vault/a.md']
    let gets = 0
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const h = makeCoordinator({
      seed: { '/vault/a.md': '# A', '/vault/b.md': 'B' },
      fileIndex: {
        get: async () => {
          gets += 1
          // Snapshot at call time, so the first (held) run reads the file list
          // as it was before b.md appeared.
          const snapshot = [...files]
          if (gets === 1) await firstHeld
          return snapshot
        },
        isTruncated: () => false,
        invalidate: () => {},
      },
    })
    const indexed = h.coordinator.indexVault('/vault')
    // Wait until the first run is actually in flight (and its fs subscription
    // armed, so the event has somewhere to land).
    await vi.waitFor(() => expect(gets).toBe(1))
    const runsBefore = h.state.indexRuns

    files.push('/vault/b.md')
    h.emit(VAULT_ROOT_RESYNC)

    // The follow-up run starts at the debounce edge, while run #1 is STILL
    // held: supersede, not queue. A queue (or a "the vault is busy, ignore it"
    // guard) would leave `gets` at 1 until the in-flight run finished, which is
    // the dropping this pins.
    await vi.waitFor(() => expect(gets).toBe(2))
    expect(h.state.indexRuns - runsBefore).toBe(1)

    await vi.waitFor(() => {
      expect(
        h.state.notes.map((n) => n.path).sort(),
      ).toEqual(['/vault/a.md', '/vault/b.md'])
    })

    // Run #1 is released last, so it publishes its own (older) file list over
    // run #2's. Nothing is asserted about the list after this point: which of
    // two OVERLAPPING full runs publishes last is the coordinator's existing
    // behaviour for full runs, not a property of the resync fix.
    releaseFirst()
    await indexed
  })
})

describe('fs-change subscription failure', () => {
  /** A one-note vault: the shared SAME_FILES index names notes this seed does
   *  not contain (they would simply not index). */
  const ONE_FILE = {
    get: (v: string) => Promise.resolve([`${v}/a.md`]),
    isTruncated: () => false,
    invalidate: () => {},
  }

  it('reports an fs-subscription failure instead of silently going deaf', async () => {
    // Without the subscription nothing tells the app that a file appeared,
    // changed or vanished: the note list, the attachment badge and the content
    // index all keep showing what they saw at index time. Swallowing the
    // failure (what this did) left the app looking healthy while quietly
    // ignoring every change made outside it.
    const h = makeCoordinator({
      seed: { '/vault/a.md': '# A' },
      fileIndex: ONE_FILE,
      failFsChangeTimes: 1,
    })
    await h.coordinator.indexVault('/vault')

    expect(h.state.watchReports).toEqual(['fail:events unavailable'])
    // The index itself still built: the list works, it just will not follow the
    // disk - which is exactly why the user has to be told.
    expect(h.state.notes).toHaveLength(1)
  })

  it('retries the subscription when the index is rebuilt, and says when it is back', async () => {
    // Rebuild is the only refresh affordance on screen, so it has to be the way
    // back to a live list; otherwise the only fix was switching vaults and back,
    // which nothing suggests.
    const h = makeCoordinator({
      seed: { '/vault/a.md': '# A' },
      fileIndex: ONE_FILE,
      failFsChangeTimes: 1,
    })
    await h.coordinator.indexVault('/vault')
    expect(h.state.watchReports).toEqual(['fail:events unavailable'])

    await h.coordinator.rebuildIndex()

    expect(h.state.watchReports).toEqual(['fail:events unavailable', 'ok'])
  })

  it('reports nothing when the first subscription works', async () => {
    const h = makeCoordinator({ seed: { '/vault/a.md': '# A' }, fileIndex: ONE_FILE })
    await h.coordinator.indexVault('/vault')
    expect(h.state.watchReports).toEqual([])
  })
})

// The persistent index is an accelerator, never a source of truth: it may only
// answer "this note cannot match" when it can prove its entry still describes
// the file. While the fs subscription is missing nothing can prove that - the
// stat snapshot and the indexed text were both taken at index time, so
// comparing them against each other is a tautology that survives the user
// editing the note in another editor.
describe('degraded fs watch (a stale index must not answer "no match")', () => {
  const FILES = (files: string[]) => ({
    get: () => Promise.resolve([...files]),
    isTruncated: () => false,
    invalidate: () => {},
  })

  it('reads the body instead of trusting an index it cannot verify', async () => {
    const h = makeCoordinator({
      seed: { '/vault/a.md': '---\ntitle: A\n---\n完全无关的开头' },
      fileIndex: FILES(['/vault/a.md']),
      failFsChangeTimes: 1,
    })
    await h.coordinator.indexVault('/vault')
    await h.coordinator.buildSearchIndex('/vault')
    // A candidate list is an exclusion, and an unverifiable mirror may not
    // exclude: while degraded every indexed note stays a candidate.
    expect(h.coordinator.indexCandidatePaths('图论')).toEqual(['/vault/a.md'])

    // The user edits the note in another editor. The watcher is deaf, so no
    // event ever arrives and both the index entry and the stat mirror still
    // hold the OLD text.
    await h.gateway.write('/vault', '/vault/a.md', '---\ntitle: A\n---\n新增图论章节')

    // The entry cannot claim to be up to date any more...
    expect(h.coordinator.indexEntryFor('/vault/a.md')?.upToDate).toBe(false)

    // ...and the search the note list runs must find the new text: a false
    // "no match" is exactly the silently-wrong result this guards against.
    const candidates = h.state.notes.map((n) => ({
      path: n.path,
      name: n.name,
      title: n.title,
      tags: n.tags,
      summary: n.summary,
      readContent: () => h.coordinator.noteContent(n.path),
    }))
    const hits = await searchWithIndex(
      candidates,
      '图论',
      (path) => h.coordinator.indexEntryFor(path),
      undefined,
      1,
    )
    expect(hits.map((m) => m.path)).toEqual(['/vault/a.md'])
  })

  it('says the index is stale while the watch is down', async () => {
    const h = makeCoordinator({
      seed: { '/vault/a.md': '# A' },
      fileIndex: FILES(['/vault/a.md']),
      failFsChangeTimes: 1,
    })
    await h.coordinator.indexVault('/vault')
    await h.coordinator.buildSearchIndex('/vault')
    // The note list turns this into a chip plus its rebuild button; reporting
    // 'up-to-date' here is what let the app look healthy while deaf.
    expect(h.state.indexState).toBe('stale')
  })

  it('still trusts the index while the watcher is healthy', async () => {
    const h = makeCoordinator({
      seed: { '/vault/a.md': '关于图论' },
      fileIndex: FILES(['/vault/a.md']),
    })
    await h.coordinator.indexVault('/vault')
    await h.coordinator.buildSearchIndex('/vault')
    // The acceleration is the point of the index: a healthy watcher keeps it.
    expect(h.coordinator.indexEntryFor('/vault/a.md')?.upToDate).toBe(true)
    expect(h.state.indexState).toBe('up-to-date')
  })

  it('re-lists the vault on rebuild, so a file created while deaf is recovered', async () => {
    // A cached file list is modelled here the way the app's VaultFileIndex
    // caches it (until invalidate), because a rebuild that reuses a stale list
    // can never see a note that appeared while the watcher was down.
    let cached: string[] | null = null
    const files = ['/vault/a.md']
    const h = makeCoordinator({
      seed: { '/vault/a.md': 'A' },
      fileIndex: {
        get: () => {
          cached ??= [...files]
          return Promise.resolve([...cached])
        },
        isTruncated: () => false,
        invalidate: () => {
          cached = null
        },
      },
      failFsChangeTimes: 1,
    })
    await h.coordinator.indexVault('/vault')
    expect(h.state.notes.map((n) => n.path)).toEqual(['/vault/a.md'])

    // Created outside the app while the app was deaf to the disk.
    await h.gateway.write('/vault', '/vault/b.md', 'B')
    files.push('/vault/b.md')

    await h.coordinator.rebuildIndex()
    expect(h.state.notes.map((n) => n.path).sort()).toEqual(['/vault/a.md', '/vault/b.md'])
    expect(h.state.watchReports).toEqual(['fail:events unavailable', 'ok'])
    expect(h.coordinator.indexEntryFor('/vault/b.md')?.upToDate).toBe(true)
  })
})

// The note-list index is now a unit of its own (vault-note-index). Two of its
// decisions used to be reachable only through a whole coordinator + gateway
// setup: which fs changes count as structural, and which caches a note that
// stopped being readable purges (a deleted file takes everything with it, a
// failed read only takes the list entry).
describe('createVaultNoteIndex (the separated note-list index)', () => {
  function makeIndex(seed: Record<string, string>) {
    const gateway = createMemoryFsGateway(seed)
    const cache = new ContentCache()
    const published: NoteSummary[][] = []
    const index = createVaultNoteIndex({
      read: (v, p) => gateway.read(v, p),
      stat: (v, p) => gateway.stat(v, p),
      cache,
      isWatcherDown: () => false,
      onNotes: (notes) => published.push(notes),
    })
    return { cache, published, index }
  }

  it('counts a folder as structural only while a listed note lives under it', async () => {
    const h = makeIndex({ '/v/notes/a.md': '# A', '/v/attachments/2026-09/pic.png': 'x' })
    h.index.replace(await h.index.indexAll('/v', ['/v/notes/a.md']))
    expect(h.index.covers('/v', '/v/notes')).toBe(true)
    // The watcher reports a folder with a trailing separator.
    expect(h.index.covers('/v', '/v/notes/')).toBe(true)
    expect(h.index.covers('/v', '/v/notes/a.md')).toBe(true)
    // No note lives under an attachment folder, so a paste must not re-read the
    // vault.
    expect(h.index.covers('/v', '/v/attachments/2026-09')).toBe(false)
  })

  it('purges a deleted note from both caches, and only delists an unreadable one', async () => {
    const h = makeIndex({ '/v/a.md': '# A' })
    h.index.replace(await h.index.indexAll('/v', ['/v/a.md']))
    expect(h.index.statOf('/v/a.md')).toBeDefined()
    expect(h.cache.peek('/v/a.md')).toBe('# A')
    // Mutating the mirror is silent; the callers publish once their writes have
    // landed (see the note-change path).
    expect(h.published).toEqual([])

    h.index.remove('/v/a.md')
    expect(h.index.list()).toEqual([])
    expect(h.index.statOf('/v/a.md')).toBeDefined()
    expect(h.cache.peek('/v/a.md')).toBe('# A')

    // A removed file takes its cache entries with it.
    h.index.forget('/v/a.md')
    expect(h.index.statOf('/v/a.md')).toBeUndefined()
    expect(h.cache.peek('/v/a.md')).toBeUndefined()
  })
})
