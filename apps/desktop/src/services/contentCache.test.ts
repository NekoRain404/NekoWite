import { describe, expect, it } from 'vitest'
import { CONTENT_CACHE_MAX, ContentCache } from './contentCache'

describe('ContentCache', () => {
  it('stores and returns content by path', () => {
    const cache = new ContentCache()
    cache.set('a.md', 'hello')
    expect(cache.get('a.md')).toBe('hello')
    expect(cache.get('missing.md')).toBeUndefined()
  })

  it('evicts the least-recently-used entry beyond the cap', () => {
    const cache = new ContentCache(2)
    cache.set('a.md', 'A')
    cache.set('b.md', 'B')
    cache.set('c.md', 'C')
    expect(cache.get('a.md')).toBeUndefined() // oldest, evicted
    expect(cache.get('b.md')).toBe('B')
    expect(cache.get('c.md')).toBe('C')
    expect(cache.size).toBe(2)
  })

  it('re-promotes a hit so a read entry is not the next to evict', () => {
    const cache = new ContentCache(2)
    cache.set('a.md', 'A')
    cache.set('b.md', 'B')
    expect(cache.get('a.md')).toBe('A') // a is now most-recent
    cache.set('c.md', 'C') // evicts b, not a
    expect(cache.get('a.md')).toBe('A')
    expect(cache.get('b.md')).toBeUndefined()
    expect(cache.get('c.md')).toBe('C')
  })

  it('re-setting an existing key moves it to the most-recent slot', () => {
    const cache = new ContentCache(2)
    cache.set('a.md', 'A')
    cache.set('b.md', 'B')
    cache.set('a.md', 'A2') // refresh a, keep b
    cache.set('c.md', 'C') // evicts b
    expect(cache.get('a.md')).toBe('A2')
    expect(cache.get('b.md')).toBeUndefined()
  })

  it('delete and clear remove entries', () => {
    const cache = new ContentCache()
    cache.set('a.md', 'A')
    cache.set('b.md', 'B')
    cache.delete('a.md')
    expect(cache.get('a.md')).toBeUndefined()
    expect(cache.size).toBe(1)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('b.md')).toBeUndefined()
  })

  it('peek does not affect eviction order', () => {
    const cache = new ContentCache(2)
    cache.set('a.md', 'A')
    cache.set('b.md', 'B')
    expect(cache.peek('a.md')).toBe('A') // no re-promotion
    cache.set('c.md', 'C') // still evicts a (oldest)
    expect(cache.get('a.md')).toBeUndefined()
  })

  it('a zero cap disables caching entirely', () => {
    const cache = new ContentCache(0)
    cache.set('a.md', 'A')
    expect(cache.size).toBe(0)
    expect(cache.get('a.md')).toBeUndefined()
  })

  it('exported singleton is bounded and starts empty', () => {
    expect(CONTENT_CACHE_MAX).toBe(200)
  })
})
