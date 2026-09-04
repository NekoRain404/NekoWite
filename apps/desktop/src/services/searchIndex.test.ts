import { describe, expect, it } from 'vitest'
import {
  buildIndexIncremental,
  buildSearchText,
  clearIndex,
  docToken,
  indexStateOf,
  loadIndex,
  queryIndex,
  saveIndex,
  searchableText,
  type IndexStorage,
  type StoredIndex,
} from './searchIndex'

function memoryStorage(): IndexStorage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, String(v))
    },
    removeItem: (k) => {
      m.delete(k)
    },
  }
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

describe('persistence', () => {
  it('round-trips a stored index and clears it', () => {
    const store = memoryStorage()
    const index: StoredIndex = { version: 1, vault: '/v', builtAt: 1, notes: {} }
    saveIndex(index, store)
    expect(loadIndex('/v', store)).toEqual(index)
    clearIndex('/v', store)
    expect(loadIndex('/v', store)).toBeNull()
  })

  it('rejects corrupt / wrong-version payloads', () => {
    const store = memoryStorage()
    store.setItem('nekowite.searchIndex.v1./v', 'not json')
    expect(loadIndex('/v', store)).toBeNull()
    store.setItem('nekowite.searchIndex.v1./v', JSON.stringify({ version: 99, vault: '/v', notes: {} }))
    expect(loadIndex('/v', store)).toBeNull()
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
})
