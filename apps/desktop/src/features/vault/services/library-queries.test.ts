import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '../../../services/note-meta'
import {
  inlinksOf,
  outlinksOf,
  queryCounts,
  queryTagCounts,
  queryVisibleNotes,
  resolveLinkPath,
} from './library-queries'

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

const VAULT = '/vault'

describe('libraryQueries (pure selectors)', () => {
  it('queryVisibleNotes filters and sorts deterministically', () => {
    const notes = [
      note('/vault/alpha.md', { title: 'Alpha', mtime: 100 }),
      note('/vault/sub/beta.md', { title: 'Beta', tags: ['t1'], mtime: 300, dir: 'sub' }),
      note('/vault/gamma.md', { title: 'gamma', mtime: 200 }),
    ]
    expect(
      queryVisibleNotes(notes, { filter: 'all', query: '', favorites: new Set(), recents: [], sortBy: 'mtime' }).map((n) => n.name),
    ).toEqual(['beta.md', 'gamma.md', 'alpha.md'])
    expect(
      queryVisibleNotes(notes, { filter: 'tag:t1', query: '', favorites: new Set(), recents: [], sortBy: 'mtime' }).map((n) => n.name),
    ).toEqual(['beta.md'])
    expect(
      queryVisibleNotes(notes, { filter: 'all', query: '', favorites: new Set(), recents: [], sortBy: 'title' }).map((n) => n.title),
    ).toEqual(['Alpha', 'Beta', 'gamma'])
  })

  it('queryTagCounts and queryCounts aggregate', () => {
    const notes = [note('/vault/a.md', { tags: ['x'] }), note('/vault/b.md', { tags: ['x', 'y'] }), note('/vault/sub/c.md', { dir: 'sub' })]
    expect(queryTagCounts(notes)).toEqual([
      { tag: 'x', count: 2 },
      { tag: 'y', count: 1 },
    ])
    expect(queryCounts(notes, ['/vault/a.md'], ['/vault/b.md'])).toEqual({
      all: 3,
      recent: 1,
      favorites: 1,
      uncategorized: 2,
    })
  })

  it('resolveLinkPath / outlinksOf / inlinksOf resolve against the index', () => {
    const notes = [
      note('/vault/notes/main.md', { title: '主页', dir: 'notes', name: 'main.md', links: ['notes/child.md'] }),
      note('/vault/notes/child.md', { title: '子页', dir: 'notes', name: 'child.md' }),
    ]
    expect(resolveLinkPath(notes, VAULT, 'notes', 'child.md')).toBe('/vault/notes/child.md')
    expect(resolveLinkPath(notes, VAULT, 'notes', 'missing.md')).toBeNull()
    expect(resolveLinkPath(notes, null, 'notes', 'child.md')).toBeNull()

    const out = outlinksOf(notes, VAULT, 'notes', '看 [子页](./child.md) 与 [外部](https://x.com/a.md)')
    expect(out).toEqual([
      { text: '子页', target: './child.md', path: '/vault/notes/child.md' },
    ])

    expect(inlinksOf(notes, 'notes/child.md').map((n) => n.title)).toEqual(['主页'])
    expect(inlinksOf(notes, null)).toEqual([])
  })
})

describe('link resolution on native paths', () => {
  // Note paths are native (backslash-separated on Windows), while link targets
  // are written with '/'. The suffix fallback compared a raw path against a
  // '/'-prefixed candidate, so it never matched on Windows — the platform this
  // app ships to — and links that needed the fallback resolved to nothing.
  const notes = [
    { path: 'C:\\vault\\notes\\deep\\idea.md', name: 'idea.md', dir: 'notes/deep' },
    { path: 'C:\\vault\\plain.md', name: 'plain.md', dir: '' },
  ] as unknown as Parameters<typeof resolveLinkPath>[0]

  it('resolves a link whose target only matches as a suffix', () => {
    // From the vault root, `deep/idea` needs the suffix pass to find the note.
    expect(resolveLinkPath(notes, 'C:\\vault', '', 'deep/idea')).toBe('C:\\vault\\notes\\deep\\idea.md')
  })

  it('still resolves the obvious vault-relative neighbour', () => {
    expect(resolveLinkPath(notes, 'C:\\vault', 'notes/deep', 'idea')).toBe('C:\\vault\\notes\\deep\\idea.md')
  })

  it('returns null for a target no note matches', () => {
    expect(resolveLinkPath(notes, 'C:\\vault', '', 'nowhere/nothing')).toBeNull()
  })
})
