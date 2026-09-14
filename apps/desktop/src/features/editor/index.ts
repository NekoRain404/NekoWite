/**
 * The editor feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): the
 * app shell, the services that write into the active editor, the panels that
 * read its selection and the two panes themselves all come through here, so the
 * internal layout — the controllers the rendered pane composes, the scroll
 * mapping, the per-pane composables — stays free to change without touching a
 * call site.
 *
 * What is exported is what a caller actually uses: the session registry (which
 * tab owns which editor, and which of them is active), the id the bridge shim
 * registers its editor under, and the six composables the two panes mount. The
 * controllers in `controller/`, the document session in `model/`, and
 * `useEditorFocus` / `usePaneHandoff` are deliberately absent: each has a
 * single caller inside this feature, and §13.11 promotes shared code only once
 * a second real caller exists. The panes themselves are not here either — they
 * are `ui/EditorPane.vue` and `view/RenderedPane.vue`, mounted by the shell at
 * those paths, and they consume this API like any other caller.
 *
 * Two paths deliberately stay deep, and neither can be routed through here:
 *
 * - The stylesheets (`styles/editorPane.css`, `styles/renderedPane.css`) are
 *   reached by `<style scoped src>`. That is a CSS reference rather than a
 *   module import, so there is no entry point to substitute for it.
 * - `services/editorInsert.ts`, `services/renderSearch.ts` and `stores/float.ts`
 *   still import `session-manager` directly. Each of them is used *by* this
 *   feature's composables — `useImageIntake` calls `insertMarkdownAtCursor`,
 *   and `editorSearchOverlay` / `editorSelection` read the float store — so
 *   importing this file from them would close a cycle through the very modules
 *   re-exported below (here → `useImageIntake` → `editorInsert` → here). They
 *   move here when the edge that closes the cycle does, not before.
 *
 * A test that doubles a module with `vi.mock` still names the module it
 * replaces (`…/editor/session-manager`), not this entry point: a mock is an
 * address for the module being stubbed, and mocking this file instead would
 * swap out the whole surface — the composables included — for every consumer in
 * that test's graph. The double still takes effect, because the re-exports
 * below resolve the same modules.
 */

/* ------------------------------ the session ------------------------------ */

/** One editor per tab, plus which of them is active. The bridge shim's reserved
 *  tab id is exported beside it because registering under that id is what the
 *  shim does with it. */
export { editorSessionManager, EDITOR_BRIDGE_LEGACY_TAB } from './session-manager'
export type { EditorSessionManager } from './session-manager'

/* ------------------------------- the panes ------------------------------- */

/** The rendered editor's stack: the Milkdown session, its persistence, and the
 *  sync, search and focus wiring around it. */
export { useRenderedEditorStack } from './composables/use-rendered-editor-stack'
export type { RenderedEditorStackOptions } from './composables/use-rendered-editor-stack'

// The panes' trailing space: measured from the panel's own height, applied to
// the pane's content box by the pane, and excluded from the scroll range the
// split sync reads. Mounted by both panes, so it is part of this API.
export { useEditorTailSpace, TAIL_SPACE_RATIO } from './composables/use-editor-tail-space'
export type { EditorTailSpace, EditorTailSpaceOptions } from './composables/use-editor-tail-space'

/** The writing surface's right-click menu, items and dispatch. */
export { useEditorContextMenu } from './composables/editor-context-menu'
export type {
  EditorContextMenuModel,
  EditorContextMenuOptions,
  EditorMenuTarget,
} from './composables/editor-context-menu'

/** The source pane's input handoff, and the slot it leaves behind while its
 *  chunk is in flight (`SourcePaneExpose` is what a caller holding that ref
 *  drives). */
export { usePaneInput } from './composables/use-pane-input'
export type { PaneInputHandlers } from './composables/use-pane-input'

export { useSourcePaneSlot } from './composables/use-source-pane-slot'
export type { SourcePaneExpose, SourcePaneSlot } from './composables/use-source-pane-slot'

/** Dropped and pasted files: the intake that stores them and inserts their
 *  markdown at the cursor. */
export { useImageIntake } from './composables/use-image-intake'

/* ------------------------------- the split ------------------------------- */

/** The two halves' scroll pairing: which line of one sits opposite the other. */
export { useSplitScrollSync } from './composables/use-split-scroll-sync'
export type { SplitScrollSync, SplitScrollSyncOptions } from './composables/use-split-scroll-sync'
