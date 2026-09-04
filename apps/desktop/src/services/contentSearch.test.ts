import { describe, expect, it } from 'vitest'
import {
  SNIPPET_RADIUS,
  buildSnippet,
  contentMatchOf,
  contentMetaMatch,
  mapWithConcurrency,
  matchContent,
  searchContentMatches,
} from './contentSearch'
import type { ContentSearchCandidate } from './contentSearch'

describe('matchContent', () => {
  it('matches case-insensitively and ignores whitespace around the query', () => {
    expect(matchContent('Hello World', 'world')).toBe(true)
    expect(matchContent('Hello World', 'hello')).toBe(true)
    expect(matchContent('Hello World', '  WORLD ')).toBe(true)
  })

  it('returns false when the query is absent or blank', () => {
    expect(matchContent('Hello World', 'nope')).toBe(false)
    expect(matchContent('Hello World', '  ')).toBe(false)
    expect(matchContent('', 'x')).toBe(false)
  })

  it('matches CJK substrings', () => {
    expect(matchContent('这是一段关于图论的内容', '图论')).toBe(true)
    expect(matchContent('这是一段关于图论的内容', '物理')).toBe(false)
  })
})

describe('buildSnippet', () => {
  it('returns the hit surrounded by the radius and collapses whitespace', () => {
    const content = 'alpha beta gamma delta epsilon zeta eta theta'
    const snippet = buildSnippet(content, 'gamma')
    expect(snippet).toContain('gamma')
    expect(snippet).toContain('beta')
    expect(snippet).toContain('delta')
  })

  it('ellipsises one or both edges when the hit sits near or beyond the radius', () => {
    const long = `prefix${'a'.repeat(SNIPPET_RADIUS * 2)}TARGET${'b'.repeat(SNIPPET_RADIUS * 2)}suffix`
    const mid = buildSnippet(long, 'TARGET')
    expect(mid.startsWith('…')).toBe(true)
    expect(mid.endsWith('…')).toBe(true)
    expect(mid).toContain('TARGET')

    const start = buildSnippet('TARGET at the very start', 'TARGET')
    expect(start.startsWith('…')).toBe(false)

    const end = buildSnippet('the very end TARGET', 'TARGET')
    expect(end.endsWith('…')).toBe(false)
  })

  it('returns empty string for blank or absent queries', () => {
    expect(buildSnippet('hello world', '  ')).toBe('')
    expect(buildSnippet('hello world', 'nope')).toBe('')
  })
})

describe('contentMatchOf', () => {
  it('returns a match with path/name and a snippet when the content hits', () => {
    const hit = contentMatchOf(
      { path: '/vault/notes/a.md', name: 'a.md', content: '一条关于图论与算法的笔记' },
      '图论',
    )
    expect(hit).toEqual({
      path: '/vault/notes/a.md',
      name: 'a.md',
      snippet: '一条关于图论与算法的笔记',
    })
  })

  it('returns null on a miss or a blank query', () => {
    expect(contentMatchOf({ path: '/vault/a.md', name: 'a.md', content: '正文' }, 'nope')).toBeNull()
    expect(contentMatchOf({ path: '/vault/a.md', name: 'a.md', content: '正文' }, '  ')).toBeNull()
  })
})

describe('contentMetaMatch', () => {
  it('matches case-insensitively across path/name/title/tags/summary', () => {
    const meta = {
      path: '/vault/dir/note.md',
      name: 'note.md',
      title: 'Graph Theory',
      tags: ['math', 'graph'],
      summary: 'an intro to graph algorithms',
    }
    expect(contentMetaMatch(meta, 'graph')).toBe(true)
    expect(contentMetaMatch(meta, 'MATH')).toBe(true)
    expect(contentMetaMatch(meta, 'algorithms')).toBe(true)
    expect(contentMetaMatch(meta, 'zzz')).toBe(false)
    expect(contentMetaMatch(meta, '  ')).toBe(false)
  })
})

describe('searchContentMatches (metadata-first)', () => {
  it('reads the body only for candidates whose metadata matches', async () => {
    const reads: string[] = []
    const candidates: ContentSearchCandidate[] = [
      {
        path: '/v/a.md',
        name: 'a.md',
        title: 'Graph Theory',
        tags: [],
        summary: '',
        readContent: async () => {
          reads.push('a')
          return 'we study graph algorithms'
        },
      },
      // metadata misses the query, body hits -> cheaply rejected, never read.
      {
        path: '/v/b.md',
        name: 'b.md',
        title: 'Combinatorics',
        tags: [],
        summary: '',
        readContent: async () => {
          reads.push('b')
          return 'a graph is a structure'
        },
      },
    ]
    const hits = await searchContentMatches(candidates, 'graph')
    expect(reads).toEqual(['a'])
    expect(hits.map((h) => h.path)).toEqual(['/v/a.md'])
    expect(hits[0]!.snippet).toContain('graph')
  })

  it('returns an empty result for a blank query', async () => {
    const candidates: ContentSearchCandidate[] = [
      {
        path: '/v/a.md',
        name: 'a.md',
        title: 'Alpha',
        tags: [],
        summary: '',
        readContent: async () => 'alpha graph',
      },
    ]
    expect(await searchContentMatches(candidates, '  ')).toEqual([])
  })

  it('stops reading remaining candidates once aborted', async () => {
    const controller = new AbortController()
    const reads: string[] = []
    const candidates: ContentSearchCandidate[] = [
      {
        path: '/v/a.md',
        name: 'a.md',
        title: 'Graph A',
        tags: [],
        summary: '',
        readContent: async () => {
          reads.push('a')
          // Simulate a superseding search aborting while this read is in flight.
          controller.abort()
          await new Promise((r) => setTimeout(r, 5))
          return 'graph in a'
        },
      },
      {
        path: '/v/b.md',
        name: 'b.md',
        title: 'Graph B',
        tags: [],
        summary: '',
        readContent: async () => {
          reads.push('b')
          await new Promise((r) => setTimeout(r, 1))
          return 'graph in b'
        },
      },
    ]
    const hits = await searchContentMatches(candidates, 'graph', controller.signal, 1)
    expect(hits).toEqual([])
    expect(reads).toEqual(['a'])
  })

  it('returns no matches when aborted before starting any read', async () => {
    const controller = new AbortController()
    controller.abort()
    const candidates: ContentSearchCandidate[] = [
      {
        path: '/v/a.md',
        name: 'a.md',
        title: 'Graph A',
        tags: [],
        summary: '',
        readContent: async () => {
          throw new Error('should not read')
        },
      },
    ]
    expect(await searchContentMatches(candidates, 'graph', controller.signal)).toEqual([])
  })
})

describe('mapWithConcurrency', () => {
  it('preserves input order and never exceeds the concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    const worker = async (n: number): Promise<number> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 1))
      active -= 1
      return n * 2
    }
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, worker)
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('caps workers at the item count and handles an empty input', async () => {
    let active = 0
    let maxActive = 0
    const worker = async (n: number): Promise<number> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 1))
      active -= 1
      return n
    }
    expect(await mapWithConcurrency([], 8, worker)).toEqual([])
    expect(await mapWithConcurrency([1, 2], 8, worker)).toEqual([1, 2])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('propagates a worker rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})
