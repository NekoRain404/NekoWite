/**
 * The notes feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout
 * (components / composables / services) can change without touching a call
 * site, and two features cannot reach into each other's internals.
 *
 * Only what a caller genuinely uses is exported. The section components
 * (`NoteListToolbar`, `NoteSearch`, `NoteListContent`, `OutlineList`,
 * `LinkList`) are deliberately absent: they are parts of `NoteListPanel`, not
 * an API, and their props are wired by the panel that composes them.
 *
 * The note-metadata services are exported as a whole rather than as a curated
 * subset: they are the shared note domain — frontmatter parsing, the summary
 * projection, the path helpers, the list rules — and their callers sit all over
 * the app, so the names have to be reachable from here as a whole, not only the
 * handful this feature uses itself.
 *
 * Six of those callers cannot come through this entry point. This file exports
 * the panel, which reaches the vault, the stores and the search index, so a
 * caller already inside that runtime closure — the search index build, the graph
 * filters, the export renderer, the vault's link queries and note index, and
 * `ui/NoteCard.vue` — would close a cycle by importing here. Each of those reads
 * the owning service module directly and says why at the import.
 */

export { default as NoteListPanel } from './components/NoteListPanel.vue'

export { useNoteList } from './composables/use-note-list'
export type { NoteListLinks, NoteListModel, NoteOutlink } from './composables/use-note-list'

export { useNoteActions } from './composables/use-note-actions'
export type { NoteActionsModel } from './composables/use-note-actions'

export { count, filter, sort } from './services/note-list-query'

/* Finding the frontmatter block, and the lightweight scan of it: the title and
 * the tags the list, the tag rail and the search index share. */
export {
  hasFrontmatter,
  parseFrontmatterBlock,
  splitFrontmatterRaw,
  splitNoteForSummary,
} from './services/frontmatter-scan'

/* The frontmatter property panel's editable model: the fields it edits, the
 * read-only view of every other key, and the raw segments that let an unknown
 * key survive a round trip byte for byte. */
export {
  emptyFrontmatterFields,
  frontmatterBlock,
  parseFrontmatterForPanel,
  replaceFrontmatter,
  serializeFrontmatter,
} from './services/frontmatter-panel'
export type { FrontmatterFields, FrontmatterSegment } from './services/frontmatter-panel'

/* The note summary projection: what a card, the library list and the search
 * index know about one note, including the references its body makes. */
export {
  extractH1,
  extractOutlinks,
  extractSummary,
  fileNameTitle,
  parseNoteMeta,
} from './services/note-summary'
export type { MdLink, NoteSummary } from './services/note-summary'

/* Vault-relative path helpers for a note path and a link target. */
export {
  dirRelativeToVault,
  notePathRelativeToVault,
  relPathOf,
  resolveLinkTarget,
} from './services/note-paths'

/* The pure filter / query / sort / count rules over a set of summaries. */
export {
  aggregateTagCounts,
  computeLibraryCounts,
  filterAndSortNotes,
  filterNotes,
  matchesQuery,
  sortNotes,
} from './services/note-query'
export type { FilterOptions, LibraryCounts, LibraryFilter, SortBy } from './services/note-query'

/* A note's mtime, rendered for display. */
export { formatRelativeTime } from './services/relative-time'
