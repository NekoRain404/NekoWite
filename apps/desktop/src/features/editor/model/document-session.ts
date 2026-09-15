import type { NekoEditor } from '@nekowite/editor-core'

/**
 * The identity of a document this pane can hold: its vault and the tab that
 * names it.
 *
 * Text is not identity. Two notes can hold the same bytes — an empty note and
 * another empty note are the common case — and every question that reads
 * "which document is this?" through the text alone gets those two wrong: the
 * rendered model kept the previous note's undo history and caret because the
 * content watcher could not see the switch, and a pending serialization could
 * be about to land in the wrong tab for the same reason.
 *
 * The PATH is deliberately not part of it. A note saved under a new name
 * (Save-As) keeps its tab and its identity: the open document did not change,
 * and a key that moved with the path would make the model "not hold" the tab it
 * is still editing, so its serializations would stop being published.
 */
export function documentKey(vault: string | null, tabId: string): string {
  return `${vault ?? ''}\u0000${tabId}`
}

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
 * `appliedKey` is the other half of that guard and answers a question `gen`
 * cannot: whether the text in flight still belongs to the document the model is
 * holding (see `documentKey`).
 */
export interface DocumentSession {
  /** The active Milkdown/ProseMirror editor, once mounted. */
  editor: NekoEditor | null
  /** Monotonic generation counter for content writes. */
  gen: number
  /** Markdown last produced by (or applied to) the editor. */
  lastLocalMarkdown: string | null
  /** The exact content the editor is HOLDING, null while it holds none: a
   *  failed `open()` disowns the document it was asked for, and this claim has
   *  to be dropped with it. Used to make external-sync re-open idempotent so a
   *  watcher echo or a duplicate open never replaces the live model (which
   *  resets caret/undo/scroll) — so it must never outlive the load it
   *  describes, or the guard that reads it skips the very re-open that makes
   *  the editor hold a document again (C1, brief 58). */
  appliedContent: string | null
  /** WHICH document `appliedContent` is about — `documentKey` of the tab the
   *  model was loaded from. Committed with the load and dropped with it, so
   *  "the model holds this document" is one fact, not a guess made from the
   *  text. Null while the model holds no document. */
  appliedKey: string | null
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
    appliedKey: null,
    applyingExternal: false,
    parseFailed: false,
    pendingExternal: null,
    calloutViewSet: false,
    docChangeTimer: null,
    lastDoc: '',
  }
}
