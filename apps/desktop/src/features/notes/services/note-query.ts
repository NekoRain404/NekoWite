/**
 * The pure read side over a set of note summaries: what the filter and the
 * query select, the order they come back in, and the counts derived from them.
 *
 * These are the rules the library list, the tag rail and the tag aggregate all
 * have to agree on, which is why they are stated once, here, and not per
 * surface: a tag the filter accepts but the count ignores is a tag whose count
 * lies. Nothing here reads a store, a gateway or the DOM — a caller hands in
 * the summaries and the filter state and gets back a plain array.
 *
 * The list's own projection (`features/notes/services/note-list-query.ts`)
 * builds on this module; so does the vault index, which produces the summaries
 * in the first place.
 */

import type { NoteSummary } from './note-summary'
import { relPathOf } from './note-paths'

export type LibraryFilter = 'all' | 'recent' | 'favorites' | 'uncategorized' | `tag:${string}`
export type SortBy = 'mtime' | 'title' | 'name'

export interface LibraryCounts {
  all: number
  recent: number
  favorites: number
  uncategorized: number
}

export interface FilterOptions {
  filter: LibraryFilter
  query: string
  favorites: ReadonlySet<string>
  recents: readonly string[]
  sortBy: SortBy
}

export function matchesQuery(note: NoteSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${note.title} ${note.name} ${note.summary} ${relPathOf(note)} ${note.tags.join(' ')}`
    .toLowerCase()
    .includes(q)
}

export function filterNotes(notes: NoteSummary[], opts: FilterOptions): NoteSummary[] {
  const recentSet = new Set(opts.recents)
  const tagFilter = opts.filter.startsWith('tag:') ? opts.filter.slice(4) : null
  return notes.filter((note) => {
    if (opts.filter === 'favorites' && !opts.favorites.has(note.path)) return false
    if (opts.filter === 'recent' && !recentSet.has(note.path)) return false
    if (opts.filter === 'uncategorized' && note.dir !== '') return false
    if (tagFilter && !note.tags.includes(tagFilter)) return false
    return matchesQuery(note, opts.query)
  })
}

export function sortNotes(notes: NoteSummary[], sortBy: SortBy): NoteSummary[] {
  const next = [...notes]
  const byName = (a: NoteSummary, b: NoteSummary): number =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  next.sort((a, b) => {
    let c: number
    if (sortBy === 'mtime') c = b.mtime - a.mtime
    else if (sortBy === 'title') c = a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true })
    else c = byName(a, b)
    if (c === 0) c = byName(a, b)
    return c
  })
  return next
}

export function filterAndSortNotes(notes: NoteSummary[], opts: FilterOptions): NoteSummary[] {
  return sortNotes(filterNotes(notes, opts), opts.sortBy)
}

export function aggregateTagCounts(
  notes: NoteSummary[],
  limit = 8,
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const note of notes) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'))
    .slice(0, limit)
}

export function computeLibraryCounts(
  notes: NoteSummary[],
  favorites: readonly string[],
  recents: readonly string[],
): LibraryCounts {
  const paths = new Set(notes.map((n) => n.path))
  let uncategorized = 0
  for (const note of notes) {
    if (note.dir === '') uncategorized += 1
  }
  return {
    all: notes.length,
    recent: recents.filter((p) => paths.has(p)).length,
    favorites: favorites.filter((p) => paths.has(p)).length,
    uncategorized,
  }
}
