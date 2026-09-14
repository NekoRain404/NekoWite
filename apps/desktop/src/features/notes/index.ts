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
 * The note-metadata services are the exception, and the whole surface is
 * exported rather than a curated subset: `services/noteMeta.ts` is a
 * compatibility shim for ONE stage (§10.1.5) whose callers — the search index,
 * the vault coordinator, the frontmatter panel, the editor controller — still
 * import it by the old path, and they migrate here one at a time until that
 * shim can be deleted. The names therefore have to be reachable from this entry
 * point as a whole, not only the handful the list happens to use today.
 */

export { default as NoteListPanel } from './components/NoteListPanel.vue'

export { useNoteList } from './composables/useNoteList'
export type { NoteListLinks, NoteListModel, NoteOutlink } from './composables/useNoteList'

export { useNoteActions } from './composables/useNoteActions'
export type { NoteActionsModel } from './composables/useNoteActions'

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
