import type { NekoEditor } from '@nekowite/editor-core'

/**
 * The mutable, non-reactive per-document state shared by the rendered-pane
 * controllers. Everything here is either the live editor instance or a
 * coordination flag; it is NOT template-reactive (the one template-bound
 * handle, `editorForPanel`, lives in the view as a shallowRef). Bundling it in a
 * session keeps the controllers from juggling a dozen disconnected module-level
 * variables and makes the "open → edit → save → external-sync" flow explicit.
 *
 * `gen` is the staleness guard: it is bumped whenever an external content write
 * arrives so an in-flight serialization from an older generation can never win.
 */
export interface DocumentSession {
  /** The active Milkdown/ProseMirror editor, once mounted. */
  editor: NekoEditor | null
  /** Monotonic generation counter for content writes. */
  gen: number
  /** Markdown last produced by (or applied to) the editor. */
  lastLocalMarkdown: string | null
  /** The exact content currently loaded into the editor. Used to make
   *  external-sync re-open idempotent so a watcher echo or a duplicate open
   *  never replaces the live model (which resets caret/undo/scroll). */
  appliedContent: string | null
  /** True while an `open()` is applying externally-supplied content. */
  applyingExternal: boolean
  /** True when the last `open()` threw (unknown MDX), so the source view is used. */
  parseFailed: boolean
  /** Content that arrived while an `applyContent` was in flight. */
  pendingExternal: string | null
  /** Whether the callout plugin's editor view was already installed. */
  calloutViewSet: boolean
  /** Pending `onDocChange` emit timer. */
  docChangeTimer: ReturnType<typeof setTimeout> | null
  /** Last markdown serialized, so `onDocChange` can emit the doc once. */
  lastDoc: string
}

export function createDocumentSession(): DocumentSession {
  return {
    editor: null,
    gen: 0,
    lastLocalMarkdown: null,
    appliedContent: null,
    applyingExternal: false,
    parseFailed: false,
    pendingExternal: null,
    calloutViewSet: false,
    docChangeTimer: null,
    lastDoc: '',
  }
}
