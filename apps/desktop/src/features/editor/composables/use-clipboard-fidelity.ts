import { onBeforeUnmount, watch } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { selectionTextOf } from '../model/selection-text'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

/**
 * Make Copy and Cut carry what the reader is actually looking at.
 *
 * The app had no copy handler at all: the clipboard got whatever the engine
 * serialised out of the DOM selection, and the rendered pane's node views
 * (maths, code blocks, tables, wiki-links) are `contenteditable="false"`, whose
 * text the engine's serialiser drops. Measured before this: `Inline maths  sits
 * here.` for a paragraph with a formula, and the empty string for a formula, a
 * code block or a table on its own. **Cut did the same and deleted the
 * paragraph** — so this handler covers both; they are one road.
 *
 * Three things it deliberately does NOT do:
 *
 * - **It never touches the source pane.** CodeMirror writes its own payload
 *   through its own handling, and that pane's copy was measured byte-exact.
 *   A document-level listener with `preventDefault` would silently break the
 *   pane that works, so this is bound to the rendered pane's container and
 *   returns before writing anything unless the SELECTION's own DOM is inside it.
 * - **It never prevents the default.** `setData('text/plain', …)` replaces just
 *   that type; the engine's `text/html` — which carries the node views' markup
 *   and was never the broken half — still goes out, and a rich destination keeps
 *   getting formatting.
 * - **It never edits the document.** Cut's deletion stays ProseMirror's own
 *   transaction (undo works, the caret lands where the editor puts it); this
 *   only fixes the payload that leaves.
 */
export interface ClipboardFidelityOptions {
  /** The element both panes live in — the listener's scope. */
  getPanesEl: () => HTMLElement | null
  /** The rendered editor, or null before it exists. */
  getEditor: () => NekoEditor | null
}

/** True when the current selection lives inside the rendered pane's editor. */
function selectionIsRendered(view: EditorView, panes: HTMLElement): boolean {
  const selection = view.dom.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return false
  const node = selection.getRangeAt(0).commonAncestorContainer
  const element = node instanceof Element ? node : node.parentElement
  if (!element) return false
  // Inside THIS editor, and inside the shared panes container: a selection in
  // the source pane is inside the container too, which is why both checks are
  // needed.
  return view.dom.contains(element) && panes.contains(element)
}

export function useClipboardFidelity(options: ClipboardFidelityOptions): void {
  /** The payload read BEFORE the editor gets the event — see `onCapture`. */
  let captured: string | null = null

  function viewOrNull(): EditorView | null {
    try {
      return options.getEditor()?.getView() ?? null
    } catch {
      return null
    }
  }

  function payloadOf(view: EditorView): string | null {
    const { from, to, empty } = view.state.selection
    if (empty) return null
    return selectionTextOf(view.state.doc, from, to) || null
  }

  /**
   * Read the payload on the way IN.
   *
   * For `cut` this is the only moment it exists: ProseMirror's own handler
   * deletes the selection, and by the time a listener on an ancestor runs, the
   * selection is already gone — which is why Cut kept shipping the broken text
   * (`Inline maths  sits here.`) after the copy path was fixed, with the
   * paragraph destroyed alongside it.
   */
  function onCapture(event: Event): void {
    captured = null
    const panes = options.getPanesEl()
    const view = viewOrNull()
    if (!panes || !view || !selectionIsRendered(view, panes)) return
    captured = payloadOf(view)
    void event
  }

  function onCopyOrCut(event: ClipboardEvent): void {
    const panes = options.getPanesEl()
    const view = viewOrNull()
    if (!panes || !view) return
    if (!selectionIsRendered(view, panes)) {
      captured = null
      return
    }
    // The captured payload wins when there is one (the cut case); otherwise the
    // selection is still live and is read now.
    const text = captured ?? payloadOf(view)
    captured = null
    if (!text) return
    // Written late (the listener is bound in the bubble phase on an ancestor):
    // ProseMirror's own handler has already written its payload by now, and this
    // replaces the plain-text half of it. Preventing the default is what would
    // break the second payload the engine adds.
    event.clipboardData?.setData('text/plain', text)
  }

  // Bound through a watcher, not once at setup: the container is a template ref,
  // which is null until the component mounts — a listener registered from setup
  // silently never existed (observed: the fix landed, and the clipboard did not
  // change). The same reading is what `useEditorTailSpace` had to learn.
  let bound: HTMLElement | null = null
  watch(
    () => options.getPanesEl(),
    (panes) => {
      if (bound === panes) return
      bound?.removeEventListener('copy', onCapture, true)
      bound?.removeEventListener('cut', onCapture, true)
      bound?.removeEventListener('copy', onCopyOrCut)
      bound?.removeEventListener('cut', onCopyOrCut)
      bound = panes
      // Capture first (the payload), bubble second (the write): writing in the
      // capture phase would be overwritten by ProseMirror's own handler.
      bound?.addEventListener('copy', onCapture, true)
      bound?.addEventListener('cut', onCapture, true)
      bound?.addEventListener('copy', onCopyOrCut)
      bound?.addEventListener('cut', onCopyOrCut)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    bound?.removeEventListener('copy', onCapture, true)
    bound?.removeEventListener('cut', onCapture, true)
    bound?.removeEventListener('copy', onCopyOrCut)
    bound?.removeEventListener('cut', onCopyOrCut)
    bound = null
  })
}
