/**
 * Compatibility surface, ONE stage only (§10.1.5).
 *
 * The note-metadata implementation moved into the notes feature — the
 * frontmatter scan to `frontmatter-scan.ts`, the property panel's editable model
 * to `frontmatter-panel.ts`, the summary projection to `note-summary.ts` and the
 * path helpers, the pure query rules and the mtime formatter beside them. This
 * file keeps the old `services/noteMeta` path resolving so an import this change
 * did not reach cannot break, and is deleted with the rest of the compatibility
 * layer once nothing imports it.
 *
 * The names are listed explicitly rather than `export *`ing a module. Two
 * reasons, both structural:
 *
 * - `export * from '../features/notes'` is not available here. That entry point
 *   exports the panel component and its composables, and `useNoteList` imports
 *   this very file — a blanket re-export would close a cycle through the Vue
 *   layer and drag it into `searchIndex.ts`, which only ever wanted a string
 *   parser.
 * - An explicit list is the compatibility contract, not a copy of it. A helper
 *   added later for internal sharing between the new modules (the YAML scalar
 *   reader they both need, say) cannot leak into this surface by accident, and
 *   a name dropped here is a failing typecheck rather than a silent absence.
 *
 * Nothing outside the notes feature should import its internals directly: new
 * callers go through `features/notes`, which re-exports the same names.
 */

/* Finding the frontmatter block, and the lightweight scan of it (`frontmatter-scan.ts`). */
export {
  hasFrontmatter,
  parseFrontmatterBlock,
  splitFrontmatterRaw,
  splitNoteForSummary,
} from '../features/notes/services/frontmatter-scan'

/* The frontmatter property panel's editable model (`frontmatter-panel.ts`). */
export {
  emptyFrontmatterFields,
  frontmatterBlock,
  parseFrontmatterForPanel,
  replaceFrontmatter,
  serializeFrontmatter,
} from '../features/notes/services/frontmatter-panel'
export type {
  FrontmatterFields,
  FrontmatterSegment,
} from '../features/notes/services/frontmatter-panel'

/* The note summary projection (`note-summary.ts`). */
export {
  extractH1,
  extractOutlinks,
  extractSummary,
  fileNameTitle,
  parseNoteMeta,
} from '../features/notes/services/note-summary'
export type { MdLink, NoteSummary } from '../features/notes/services/note-summary'

/* Vault-relative path helpers (`note-paths.ts`). */
export {
  dirRelativeToVault,
  notePathRelativeToVault,
  relPathOf,
  resolveLinkTarget,
} from '../features/notes/services/note-paths'

/* The pure filter / sort / count rules over a set of summaries (`note-query.ts`). */
export {
  aggregateTagCounts,
  computeLibraryCounts,
  filterAndSortNotes,
  filterNotes,
  matchesQuery,
  sortNotes,
} from '../features/notes/services/note-query'
export type {
  FilterOptions,
  LibraryCounts,
  LibraryFilter,
  SortBy,
} from '../features/notes/services/note-query'

/* mtime rendering (`relative-time.ts`). */
export { formatRelativeTime } from '../features/notes/services/relative-time'
