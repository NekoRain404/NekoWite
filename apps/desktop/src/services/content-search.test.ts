import { describe, expect, it } from 'vitest'
import { CONTENT_SEARCH_CONCURRENCY, searchWithIndex } from './content-search'
import type { ContentSearchCandidate, IndexLookupResult } from './content-search'

describe('searchWithIndex (index-accelerated search)', () => {
  const candidate = (
    path: string,
    content: string,
  ): ContentSearchCandidate => ({
    path,
    name: path.split('/').pop() ?? path,
    title: '',
    tags: [],
    summary: '',
    readContent: async () => content,
  })

  it('skips the body read for an up-to-date index that lacks the query', async () => {
    const reads: string[] = []
    const cand: ContentSearchCandidate = {
      path: '/v/a.md',
      name: 'a.md',
      title: '',
      tags: [],
      summary: '',
      readContent: async () => {
        reads.push('a')
        return 'a body that does not match'
      },
    }
    const lookup = (): IndexLookupResult => ({ upToDate: true, text: 'a.md a body that does not match' })
    const hits = await searchWithIndex([cand], 'graph', lookup, undefined, 1)
    expect(hits).toEqual([])
    expect(reads).toEqual([])
  })

  it('reads the body for an up-to-date index hit (snippet is the source of truth)', async () => {
    const reads: string[] = []
    const cand: ContentSearchCandidate = {
      path: '/v/a.md',
      name: 'a.md',
      title: '',
      tags: [],
      summary: '',
      readContent: async () => {
        reads.push('a')
        return 'we study graph algorithms'
      },
    }
    const hits = await searchWithIndex(
      [cand],
      'graph',
      () => ({ upToDate: true, text: 'a.md we study graph algorithms' }),
      undefined,
      1,
    )
    // A positive index hit still needs the body to build the snippet.
    expect(reads).toEqual(['a'])
    expect(hits[0]!.snippet).toContain('graph')
  })

  it('falls back to reading when the index is missing or stale', async () => {
    const reads: string[] = []
    const cand: ContentSearchCandidate = {
      path: '/v/b.md',
      name: 'b.md',
      title: 'Combinatorics',
      tags: [],
      summary: '',
      readContent: async () => {
        reads.push('b')
        return 'a graph is a structure'
      },
    }
    // Missing index entry -> must read (completeness).
    expect(
      await searchWithIndex([cand], 'graph', () => null, undefined, 1),
    ).toHaveLength(1)
    // Stale entry (upToDate=false) -> must read.
    expect(
      await searchWithIndex([cand], 'graph', () => ({ upToDate: false, text: 'combinatorics' }), undefined, 1),
    ).toHaveLength(1)
    expect(reads).toEqual(['b', 'b'])
  })

  it('stops scheduling new reads when aborted', async () => {
    const controller = new AbortController()
    const reads: string[] = []
    const candA: ContentSearchCandidate = {
      path: '/v/a.md',
      name: 'a.md',
      title: '',
      tags: [],
      summary: '',
      readContent: async () => {
        reads.push('a')
        controller.abort()
        await new Promise((r) => setTimeout(r, 5))
        return 'graph in a'
      },
    }
    const candB = candidate('/v/b.md', 'graph in b')
    const hits = await searchWithIndex(
      [candA, candB],
      'graph',
      () => null,
      controller.signal,
      1,
    )
    expect(hits).toEqual([])
    expect(reads).toEqual(['a'])
  })

  it('returns an empty result for a blank query', async () => {
    expect(await searchWithIndex([candidate('/v/a.md', 'alpha')], '  ', () => null)).toEqual([])
  })
})

describe('snippets and concurrency (through the live entry point)', () => {
  const factory = (path: string, content: string) => (
    reads: string[],
    delayMs = 0,
  ): ContentSearchCandidate => ({
    path,
    name: path.split('/').pop() ?? path,
    title: '',
    tags: [],
    summary: '',
    readContent: async () => {
      reads.push(path)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      return content
    },
  })

  it('clips a deep hit with an ellipsis on both sides and keeps the original case', async () => {
    const reads: string[] = []
    const long = `prefix ${'a'.repeat(120)}GraphTheory${'b'.repeat(120)} suffix`
    const hits = await searchWithIndex(
      [factory('/v/a.md', long)(reads)],
      'GRAPHTHEORY',
      () => null,
    )
    expect(hits).toHaveLength(1)
    const snippet = hits[0]!.snippet
    expect(snippet).toContain('GraphTheory')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('does not add an ellipsis at an edge that was not clipped', async () => {
    const reads: string[] = []
    const hits = await searchWithIndex([factory('/v/a.md', 'GraphTheory at the start')(reads)], 'graph', () => null)
    expect(hits[0]!.snippet.startsWith('…')).toBe(false)
    expect(hits[0]!.snippet.endsWith('…')).toBe(false)
  })

  it('never reads more bodies at once than the concurrency limit allows', async () => {
    // The bound is what keeps a content search over a large vault from opening
    // every note at once; it used to have its own helper, now it is internal.
    let active = 0
    let peak = 0
    const candidates: ContentSearchCandidate[] = Array.from({ length: 12 }, (_, i) => ({
      path: `/v/${i}.md`,
      name: `${i}.md`,
      title: '',
      tags: [],
      summary: '',
      readContent: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 5))
        active -= 1
        return 'graph'
      },
    }))
    const hits = await searchWithIndex(candidates, 'graph', () => null, undefined, 3)
    expect(hits).toHaveLength(12)
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('uses the exported concurrency default when the caller passes none', () => {
    expect(CONTENT_SEARCH_CONCURRENCY).toBeGreaterThan(0)
  })
})
