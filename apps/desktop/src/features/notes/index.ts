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
 */

export { default as NoteListPanel } from './components/NoteListPanel.vue'

export { useNoteList } from './composables/useNoteList'
export type { NoteListLinks, NoteListModel, NoteOutlink } from './composables/useNoteList'

export { useNoteActions } from './composables/useNoteActions'
export type { NoteActionsModel } from './composables/useNoteActions'

export { count, filter, sort } from './services/note-list-query'
export type { FilterOptions } from './services/note-list-query'
