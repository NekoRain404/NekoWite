/**
 * The note list's pure read side: filter, sort and count over the indexed note
 * summaries.
 *
 * The split follows §13.4 — `stores/documentList.ts` holds the state (the
 * notes, the filter, the query, the sort key), this module derives the list
 * from a snapshot of it, and `useNoteList` commands both. Nothing here reads a
 * store, a gateway or the DOM, so the projection is testable on its own and the
 * list can change how it selects notes without touching the shared layer: the
 * matching and ordering rules themselves stay in `services/noteMeta`, where the
 * vault index that produces the summaries can share them.
 */

import {
  filterNotes,
  sortNotes,
  type FilterOptions,
  type NoteSummary,
  type SortBy,
} from '../../../services/noteMeta'

export type { FilterOptions }

/** The notes the filter and query select, in index order. `opts.sortBy` is
 *  ignored here — ordering is {@link sort}'s job. */
export function filter(notes: readonly NoteSummary[], opts: FilterOptions): NoteSummary[] {
  return filterNotes([...notes], opts)
}

/** The same notes, in the requested order. */
export function sort(notes: readonly NoteSummary[], sortBy: SortBy): NoteSummary[] {
  return sortNotes([...notes], sortBy)
}

/** How many notes the filter matches — the list's count, without building the
 *  rows. */
export function count(notes: readonly NoteSummary[], opts: FilterOptions): number {
  return filter(notes, opts).length
}
