/**
 * The note list's pure query surface.
 *
 * `filter`, `sort` and `count` are the only things the list projection is built
 * from, so these cases pin what the panel shows: which notes survive the filter
 * and the query, in what order, and the count the meta row reports. They are the
 * same rules the store's own `visibleNotes` was built on — both delegate to the
 * shared `note-query` primitives — which is what makes the panel's move
 * to its own projection behaviour-preserving.
 */
import { describe, expect, it } from 'vitest'
import type { FilterOptions } from './note-query'
import type { NoteSummary } from './note-summary'
import { count, filter, sort } from './note-list-query'

function note(path: string, over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    path,
    name: path.split('/').pop() ?? path,
    title: path.split('/').pop()?.replace(/\.mdx?$/i, '') ?? path,
    tags: [],
    summary: '',
    mtime: 0,
    size: 0,
    dir: '',
    links: [],
    ...over,
  }
}

const NOTES: NoteSummary[] = [
  note('/vault/alpha.md', { title: 'Alpha', mtime: 100 }),
  note('/vault/sub/beta.md', { title: 'Beta', tags: ['t1'], mtime: 300, dir: 'sub' }),
  note('/vault/gamma.md', { title: 'gamma', mtime: 200 }),
]

function options(over: Partial<FilterOptions> = {}): FilterOptions {
  return {
    filter: 'all',
    query: '',
    favorites: new Set<string>(),
    recents: [],
    sortBy: 'mtime',
    ...over,
  }
}

describe('note-list-query', () => {
  it('filter selects by library filter, tag and query', () => {
    expect(filter(NOTES, options()).map((n) => n.name)).toEqual(['alpha.md', 'beta.md', 'gamma.md'])
    expect(filter(NOTES, options({ filter: 'tag:t1' })).map((n) => n.name)).toEqual(['beta.md'])
    expect(filter(NOTES, options({ filter: 'uncategorized' })).map((n) => n.name)).toEqual(['alpha.md', 'gamma.md'])
    expect(filter(NOTES, options({ filter: 'favorites', favorites: new Set(['/vault/gamma.md']) })).map((n) => n.name)).toEqual(['gamma.md'])
    expect(filter(NOTES, options({ filter: 'recent', recents: ['/vault/sub/beta.md'] })).map((n) => n.name)).toEqual(['beta.md'])
    expect(filter(NOTES, options({ query: 'beta' })).map((n) => n.name)).toEqual(['beta.md'])
  })

  it('sort orders by the requested key, whatever order it is handed', () => {
    expect(sort(NOTES, 'mtime').map((n) => n.name)).toEqual(['beta.md', 'gamma.md', 'alpha.md'])
    expect(sort(NOTES, 'title').map((n) => n.title)).toEqual(['Alpha', 'Beta', 'gamma'])
    expect(sort(NOTES, 'name').map((n) => n.name)).toEqual(['alpha.md', 'beta.md', 'gamma.md'])
  })

  it('filter and sort compose into the list the panel renders', () => {
    const opts = options({ query: 'a', sortBy: 'title' })
    expect(sort(filter(NOTES, opts), opts.sortBy).map((n) => n.name)).toEqual([
      'alpha.md',
      'beta.md',
      'gamma.md',
    ])
  })

  it('count is the number of notes the filter matches', () => {
    expect(count(NOTES, options())).toBe(3)
    expect(count(NOTES, options({ filter: 'tag:t1' }))).toBe(1)
    expect(count(NOTES, options({ query: 'nothing matches this' }))).toBe(0)
  })

  it('never mutates the array it is given', () => {
    const notes = [note('/vault/b.md', { mtime: 1 }), note('/vault/a.md', { mtime: 2 })]
    const before = notes.map((n) => n.name)
    sort(notes, 'name')
    filter(notes, options({ query: 'a' }))
    expect(notes.map((n) => n.name)).toEqual(before)
  })
})
