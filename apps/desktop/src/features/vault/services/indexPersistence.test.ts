import { beforeEach, describe, expect, it } from 'vitest'
import { clearIndex, loadIndex, saveIndex, type AsyncIndexStorage } from '../../../services/searchIndex'
import { createMemoryFsGateway } from '../../../platform/gateways/memory'
import { createIndexPersistence } from './indexPersistence'

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

const VAULT = 'memoir://demo'

describe('createIndexPersistence', () => {
  let storage: AsyncIndexStorage
  let stateLog: Array<{ state: string; progress: unknown }>

  function makePersistence(gateway: ReturnType<typeof createMemoryFsGateway>) {
    stateLog = []
    return createIndexPersistence({
      load: (v) => loadIndex(v, storage),
      save: (i) => saveIndex(i, storage),
      clear: (v) => clearIndex(v, storage),
      stat: (path) => gateway.stat(VAULT, path).catch(() => null),
      read: (path) => gateway.read(VAULT, path),
      getStat: () => undefined,
      onState: (state, progress) => stateLog.push({ state, progress }),
    })
  }

  beforeEach(() => {
    storage = memStorage()
  })

  it('builds an index and answers candidate queries including deep-body matches', async () => {
    const gateway = createMemoryFsGateway({
      'a.md': '# Alpha\n\n关于图论与算法',
      'sub/b.md': '---\ntitle: Beta\n---\n与图论无关的内容',
    })
    const persistence = makePersistence(gateway)
    await persistence.build(VAULT, ['a.md', 'sub/b.md'])
    expect(persistence.candidatePaths('图论')).toEqual(['a.md', 'sub/b.md'])
    expect(persistence.candidatePaths('无关')).toEqual(['sub/b.md'])
    expect(persistence.candidatePaths('  ')).toEqual([])
    expect(persistence.state()).toBe('up-to-date')
  })

  it('incrementally updates a changed note and drops a removed one via upsert/remove', async () => {
    const gateway = createMemoryFsGateway({ 'a.md': '旧内容' })
    const persistence = makePersistence(gateway)
    await persistence.build(VAULT, ['a.md'])
    expect(persistence.candidatePaths('旧内容')).toEqual(['a.md'])

    // Simulate an incremental upload after a save: direct upsert on the mirror.
    await persistence.upsert(VAULT, 'a.md', '新内容', 999, 3)
    expect(persistence.candidatePaths('新内容')).toEqual(['a.md'])
    expect(persistence.candidatePaths('旧内容')).toEqual([])

    await persistence.remove('a.md')
    expect(persistence.candidatePaths('新内容')).toEqual([])
  })

  it('rebuild clears the persisted blob and re-builds from scratch', async () => {
    const gateway = createMemoryFsGateway({ 'a.md': '# Alpha\n\n关于图论' })
    const persistence = makePersistence(gateway)
    await persistence.build(VAULT, ['a.md'])
    expect(persistence.candidatePaths('图论')).toEqual(['a.md'])
    // Rebuild forces a re-read and reconciles against the (now-empty) blob.
    await persistence.rebuild(VAULT, ['a.md'])
    expect(persistence.candidatePaths('图论')).toEqual(['a.md'])
    expect(persistence.state()).toBe('up-to-date')
  })

  it('latest-wins: a superseded build never overwrites a newer build', async () => {
    const gateway = createMemoryFsGateway({ 'a.md': 'AAA', 'b.md': 'BBB' })
    // Slow the FIRST path's read so the second build lands while it is in flight.
    const slowPersistence = createIndexPersistence({
      load: (v) => loadIndex(v, storage),
      save: (i) => saveIndex(i, storage),
      clear: (v) => clearIndex(v, storage),
      stat: () => Promise.resolve(null),
      read: async (path) => {
        if (path === 'a.md') await new Promise((r) => setTimeout(r, 30))
        return gateway.read(VAULT, path)
      },
      getStat: () => undefined,
      onState: () => {},
    })

    const p1 = slowPersistence.build(VAULT, ['a.md']) // stale/slow build
    const p2 = slowPersistence.build(VAULT, ['b.md']) // lands second, must win
    await p2
    expect(slowPersistence.candidatePaths('BBB')).toEqual(['b.md'])

    // The stale build's late result must be discarded (latest-wins guard).
    await p1
    expect(slowPersistence.candidatePaths('BBB')).toEqual(['b.md'])
    expect(slowPersistence.candidatePaths('AAA')).toEqual([])
  })

  it('vault switch (detach) cancels a superseded async load/save', async () => {
    const storage = memStorage()
    let saveCalled = false
    let releaseLoad!: () => void
    const persistence = createIndexPersistence({
      load: () =>
        new Promise((resolve) => {
          releaseLoad = () => {
            resolve(loadIndex(VAULT, storage))
          }
        }),
      save: async () => {
        saveCalled = true
      },
      clear: async () => {},
      stat: () => Promise.resolve({ size: 1, mtime: 1 }),
      read: () => Promise.resolve('x'),
      getStat: () => undefined,
      onState: () => {},
    })
    const p = persistence.build(VAULT, ['a.md']) // starts, awaits load
    persistence.detach() // vault switch bumps seq
    releaseLoad() // the stale load resolves now
    await p
    // The superseded build must never persist (save) or touch the mirror.
    expect(saveCalled).toBe(false)
    expect(persistence.state()).toBe('idle')
    expect(persistence.candidatePaths('x')).toEqual([])
  })

  it('detach cancels in-flight work and clears the mirror', async () => {
    let aborted = false
    const persistence = createIndexPersistence({
      load: async () => null,
      save: async () => {},
      clear: async () => {},
      stat: () => Promise.resolve({ size: 1, mtime: 1 }),
      read: () => Promise.resolve('x'),
      getStat: () => undefined,
      onState: (state) => {
        if (state === 'building') aborted = true
      },
    })
    await persistence.build(VAULT, ['a.md'])
    expect(aborted).toBe(true)
    persistence.detach()
    expect(persistence.state()).toBe('idle')
    expect(persistence.candidatePaths('x')).toEqual([])
  })
})
