import { describe, expect, it } from 'vitest'
import {
  buildIndexIncremental,
  buildSearchText,
  checksumOf,
  clearIndex,
  docToken,
  INDEX_VERSION,
  indexMetaKey,
  indexShardKey,
  indexStateOf,
  loadIndex,
  queryIndex,
  saveIndex,
  searchableText,
  shardLabelForPath,
  type AsyncIndexStorage,
  type StoredIndex,
} from '../features/search'

function memoryStorage(): AsyncIndexStorage & { keys(): string[] } {
  const m = new Map<string, string>()
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, String(v))
    },
    removeItem: async (k) => {
      m.delete(k)
    },
    keys: () => [...m.keys()],
  }
}

function storeKeys(store: AsyncIndexStorage & { keys(): string[] }): string[] {
  return store.keys()
}

/** A tiny harness that hands out stats/reads from an in-memory file map and
 *  records which files were actually read. */
interface FileState {
  content: string
  mtime: number
  size: number
}

function harness(files: Map<string, FileState>) {
  const readCalls: string[] = []
  const statCalls: string[] = []
  const read = async (path: string): Promise<string> => {
    readCalls.push(path)
    const f = files.get(path)
    if (!f) throw new Error(`missing ${path}`)
    return f.content
  }
  const stat = async (path: string) => {
    statCalls.push(path)
    const f = files.get(path)
    if (!f) return null
    return { mtime: f.mtime, size: f.size }
  }
  return { readCalls, statCalls, read, stat }
}

function file(_path: string, content: string, mtime: number): FileState {
  return { content, mtime, size: content.length }
}

describe('searchableText / buildSearchText', () => {
  it('folds every searchable field, including the full body', () => {
    const text = buildSearchText(
      '/vault/notes/graph.md',
      '---\ntitle: Graph Theory\ntags: [math, graph]\n---\nA deep body note about 图论.',
      '/vault',
      100,
      200,
    )
    // filename + path + title + tags + summary + body all present and lowercased.
    expect(text).toContain('graph.md')
    expect(text).toContain('/vault/notes/graph.md')
    expect(text).toContain('graph theory')
    expect(text).toContain('math')
    expect(text).toContain('图论')
    expect(text).toContain('deep body note')
    expect(text).toBe(text.toLowerCase())
  })

  it('searchableText includes the raw content (frontmatter + body) verbatim-folded', () => {
    const text = searchableText('a.md', 'Title X\n\nBody [[wiki]]', {
      title: 'hi',
      tags: ['t'],
      summary: 's',
      name: 'a.md',
      dir: '',
    })
    expect(text).toContain('title x')
    expect(text).toContain('[[wiki]]')
    expect(text).toContain('hi')
  })
})

describe('docToken', () => {
  it('uses mtime and size to detect change', () => {
    expect(docToken(1, 2)).toBe('1:2')
    expect(docToken(1, 3)).not.toBe(docToken(1, 2))
  })
})

describe('persistence (sharded)', () => {
  it('round-trips a stored index and clears it', async () => {
    const store = memoryStorage()
    const index: StoredIndex = { version: INDEX_VERSION, vault: '/v', builtAt: 1, notes: {} }
    await saveIndex(index, store)
    expect(await loadIndex('/v', store)).toEqual(index)
    await clearIndex('/v', store)
    expect(await loadIndex('/v', store)).toBeNull()
    // clearIndex also removes every possible shard key + any residual .tmp.
    expect([...storeKeys(store)].some((k) => k.includes('.meta'))).toBe(false)
  })

  it('rejects corrupt / wrong-version metadata, and a missing shard is flagged corrupt', async () => {
    const store = memoryStorage()
    await store.setItem(indexMetaKey('/v'), 'not json')
    expect(await loadIndex('/v', store)).toBeNull()
    await store.setItem(
      indexMetaKey('/v'),
      JSON.stringify({ version: 99, vault: '/v', noteCount: 0, shards: {} }),
    )
    expect(await loadIndex('/v', store)).toBeNull()

    // A meta that lists a shard whose key is missing must report it corrupt and
    // leave that note out of memory (so a targeted rebuild re-reads it).
    const label = shardLabelForPath('/v/a.md')
    const payload = JSON.stringify({
      notes: { '/v/a.md': { token: '1:1', text: 'alpha', mtime: 1, size: 1 } },
    })
    await store.setItem(indexShardKey('/v', label), payload)
    await store.setItem(
      indexMetaKey('/v'),
      JSON.stringify({
        version: INDEX_VERSION,
        vault: '/v',
        builtAt: 1,
        noteCount: 1,
        shards: { [label]: { count: 1, checksum: checksumOf(payload) } },
      }),
    )
    const loaded = await loadIndex('/v', store)
    expect(loaded?.notes['/v/a.md']?.text).toBe('alpha')
    expect(loaded?.corruptShards).toBeUndefined()

    // Drop the shard byte (simulate corruption) -> checksum mismatch.
    await store.setItem(indexShardKey('/v', label), payload + 'x')
    const corrupt = await loadIndex('/v', store)
    expect(corrupt?.notes['/v/a.md']).toBeUndefined()
    expect(corrupt?.corruptShards).toEqual([label])
  })
})

describe('sharding', () => {
  it('splits a large set across more than one shard', async () => {
    const store = memoryStorage()
    const notes: Record<string, { token: string; text: string; mtime: number; size: number }> = {}
    for (let i = 0; i < 200; i += 1) {
      notes[`/v/n${i}.md`] = { token: '1:1', text: `note ${i}`, mtime: 1, size: 1 }
    }
    await saveIndex({ version: INDEX_VERSION, vault: '/v', builtAt: 1, notes }, store)
    const shardKeys = [...storeKeys(store)].filter((k) => k.includes('.2048-shard-'))
    expect(shardKeys.length).toBeGreaterThan(1)
    // Every note is retrievable after a round-trip.
    const loaded = await loadIndex('/v', store)
    expect(Object.keys(loaded?.notes ?? {})).toHaveLength(200)
  })

  it('a corrupted shard checksum triggers a targeted rebuild of just that shard', async () => {
    const store = memoryStorage()
    const files = new Map<string, FileState>()
    for (let i = 0; i < 40; i += 1) {
      files.set(`n${i}.md`, file(`n${i}.md`, `body ${i}`, i + 1))
    }
    const h = harness(files)
    const result1 = await buildIndexIncremental(
      '/v',
      [...files.keys()],
      { stat: h.stat, read: h.read },
      null,
    )
    await saveIndex(result1.index, store)
    expect(((await loadIndex('/v', store))?.corruptShards ?? []).length).toBe(0)

    // Corrupt ONE shard by overwriting its stored payload.
    const label = shardLabelForPath('n0.md')
    await store.setItem(indexShardKey('/v', label), 'torn-{ garbage')
    const corrupt = await loadIndex('/v', store)
    expect(corrupt?.corruptShards).toContain(label)

    // Build from the corrupted index: the corrupt shard's notes are re-read, the
    // rest are skipped -> a targeted rebuild (not a full one).
    h.readCalls.length = 0
    const rebuild = await buildIndexIncremental(
      '/v',
      [...files.keys()],
      { stat: h.stat, read: h.read },
      corrupt,
    )
    expect(rebuild.rebuiltShards).toContain(label)
    expect(rebuild.built).toBeGreaterThan(0)
    expect(rebuild.skipped).toBeGreaterThan(0)
    await saveIndex(rebuild.index, store)
    // After re-save the corrupt shard is healed and no shard is flagged.
    expect(((await loadIndex('/v', store))?.corruptShards ?? []).length).toBe(0)
    expect(((await loadIndex('/v', store))?.notes ?? {})['n0.md']).toBeDefined()
  })

  it('atomic write leaves no torn shard: the temp is staged before the swap', async () => {
    const store = memoryStorage()
    const label = shardLabelForPath('/v/a.md')
    const key = indexShardKey('/v', label)
    // Commit an initial valid value.
    await store.setItem(key, '{"old":true}')
    // A write that crashes AFTER staging the temp but BEFORE the swap leaves the
    // committed value untouched (no torn/partial JSON under the real key).
    const flaky: AsyncIndexStorage = {
      getItem: async (k) => store.getItem(k),
      setItem: async (k, v) => {
        if (k === key) throw new Error('interrupted before swap')
        await store.setItem(k, v)
      },
      removeItem: async (k) => store.removeItem(k),
    }
    await expect(
      saveIndex(
        { version: INDEX_VERSION, vault: '/v', builtAt: 1, notes: { '/v/a.md': { token: '1:1', text: 'x', mtime: 1, size: 1 } } },
        flaky,
      ),
    ).rejects.toThrow()
    // The real key still holds the old, valid JSON; a reload parses it fine.
    const committed = await store.getItem(key)
    expect(committed).toBe('{"old":true}')
    expect(() => JSON.parse(committed!)).not.toThrow()
    // A stale temp key from the interrupted write is harmless/cleaned on load.
    expect(await store.getItem(`${key}.tmp`)).toBeDefined()
  })
})

describe('queryIndex', () => {
  it('finds a deep-body-only match (metadata lacks the term)', () => {
    const index: StoredIndex = {
      version: 1,
      vault: '/v',
      builtAt: 0,
      notes: {
        '/v/b.md': {
          token: '1:5',
          // Title/tags/summary all miss the query, but the full body (index
          // text includes the body) contains it — so it is never dropped.
          text: buildSearchText('/v/b.md', 'Combinatorics\n\nwe study graph algorithms', '/v', 1, 40),
          mtime: 1,
          size: 40,
        },
      },
    }
    expect(queryIndex(index, 'graph')).toEqual(['/v/b.md'])
  })

  it('returns empty for blank queries and sorts results', () => {
    const index: StoredIndex = {
      version: 1,
      vault: '/v',
      builtAt: 0,
      notes: {
        '/v/z.md': { token: '1:1', text: 'zeta', mtime: 1, size: 1 },
        '/v/a.md': { token: '1:1', text: 'alpha zeta', mtime: 1, size: 1 },
      },
    }
    expect(queryIndex(index, '  ')).toEqual([])
    expect(queryIndex(index, 'zeta')).toEqual(['/v/a.md', '/v/z.md'])
  })
})

describe('buildIndexIncremental', () => {
  it('only re-reads notes whose stat changed (incremental update)', async () => {
    const files = new Map<string, FileState>([
      ['a.md', file('a.md', 'alpha', 1)],
      ['b.md', file('b.md', 'beta', 2)],
    ])
    const h = harness(files)
    const result1 = await buildIndexIncremental(
      '/v',
      ['a.md', 'b.md'],
      { stat: h.stat, read: h.read },
      null,
    )
    expect(result1.built).toBe(2)
    expect(h.readCalls).toEqual(['a.md', 'b.md'])

    // Second build: nothing changed -> no reads.
    h.readCalls.length = 0
    const result2 = await buildIndexIncremental(
      '/v',
      ['a.md', 'b.md'],
      { stat: h.stat, read: h.read },
      result1.index,
    )
    expect(result2.built).toBe(0)
    expect(result2.skipped).toBe(2)
    expect(h.readCalls).toEqual([])
    expect(result2.index.notes['a.md']!.text).toBe(result1.index.notes['a.md']!.text)

    // Change one note's mtime/size -> only that note is re-read.
    files.set('b.md', file('b.md', 'beta v2', 99))
    h.readCalls.length = 0
    const result3 = await buildIndexIncremental(
      '/v',
      ['a.md', 'b.md'],
      { stat: h.stat, read: h.read },
      result2.index,
    )
    expect(result3.built).toBe(1)
    expect(result3.changed).toBe(1)
    expect(h.readCalls).toEqual(['b.md'])
    expect(result3.index.notes['b.md']!.text).toContain('beta v2')
    expect(result3.index.notes['a.md']!.text).toBe(result1.index.notes['a.md']!.text)
  })

  it('drops notes that are no longer in the vault (delete/move)', async () => {
    const files = new Map<string, FileState>([
      ['a.md', file('a.md', 'alpha', 1)],
      ['b.md', file('b.md', 'beta', 2)],
    ])
    const h = harness(files)
    const result1 = await buildIndexIncremental(
      '/v',
      ['a.md', 'b.md'],
      { stat: h.stat, read: h.read },
      null,
    )
    // b.md disappears from the vault.
    files.delete('b.md')
    const result2 = await buildIndexIncremental(
      '/v',
      ['a.md'],
      { stat: h.stat, read: h.read },
      result1.index,
    )
    expect(result2.removed).toBe(1)
    expect(result2.index.notes['b.md']).toBeUndefined()
    expect(result2.index.notes['a.md']).toBeDefined()
  })

  it('force rebuild re-reads everything even when stat is unchanged', async () => {
    const files = new Map<string, FileState>([['a.md', file('a.md', 'alpha', 1)]])
    const h = harness(files)
    const result1 = await buildIndexIncremental(
      '/v',
      ['a.md'],
      { stat: h.stat, read: h.read },
      null,
    )
    h.readCalls.length = 0
    const result2 = await buildIndexIncremental(
      '/v',
      ['a.md'],
      { stat: h.stat, read: h.read },
      result1.index,
      { force: true },
    )
    expect(result2.built).toBe(1)
    expect(h.readCalls).toEqual(['a.md'])
  })

  it('honours the abort signal and stops scheduling new work', async () => {
    const files = new Map<string, FileState>([
      ['a.md', file('a.md', 'alpha', 1)],
      ['b.md', file('b.md', 'beta', 2)],
    ])
    const h = harness(files)
    const controller = new AbortController()
    controller.abort()
    const result = await buildIndexIncremental(
      '/v',
      ['a.md', 'b.md'],
      { stat: async () => ({ mtime: 1, size: 1 }), read: h.read },
      null,
      { signal: controller.signal },
    )
    expect(result.built).toBe(0)
    expect(h.readCalls).toEqual([])
  })
})

describe('indexStateOf', () => {
  const index: StoredIndex = {
    version: 1,
    vault: '/v',
    builtAt: 0,
    notes: { a: { token: '1:1', text: 'a', mtime: 1, size: 1 } },
  }

  it('reports needs-rebuild when there is no index', () => {
    expect(indexStateOf(null, ['a'])).toBe('needs-rebuild')
  })

  it('reports up-to-date when every path is covered', () => {
    expect(indexStateOf(index, ['a'])).toBe('up-to-date')
  })

  it('reports stale when a path has no entry', () => {
    expect(indexStateOf(index, ['a', 'b'])).toBe('stale')
  })

  it('reports stale when the index holds a path the vault no longer has', () => {
    // A deleted or renamed note keeps its entry until the next build. A caller
    // that treats 'up-to-date' as "the index describes this vault" would keep
    // answering searches with a note that is not there any more — and the click
    // on the result then fails. Being stale is what schedules the reconcile.
    expect(indexStateOf(index, [])).toBe('stale')
    expect(indexStateOf(index, ['b'])).toBe('stale')
  })
})
