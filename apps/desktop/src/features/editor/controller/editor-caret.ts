import { TextSelection } from '@milkdown/prose/state'
import type { NekoEditor } from '@nekowite/editor-core'
import { renderedModelRefused } from '../../../services/editor-ownership'
import { renderedLineOrRatio, renderedTopFor } from './pane-scroll-mapping'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

/**
 * Where the caret is in the rendered pane, and how to put it somewhere else.
 *
 * Split out of `editorScrollSync` because it is the other half of the same
 * question that module asks: the scroll box knows where the VIEWPORT is, this
 * knows where the CARET is, and a mode switch carries both — as two different
 * positions, which is why neither can be derived from the other (the caret is a
 * point and a viewport is a range).
 *
 * What it needs from the scroll half arrives as `geometry`: the line↔offset
 * mapping's inputs (the outline, the measured heading offsets, the pane's
 * content range) are read live, so both halves must work from the same reading
 * rather than each assembling their own.
 */
export interface EditorCaretDeps {
  getScrollEl: () => HTMLElement | null
  /** The rendered editor. Optional so the scroll-only callers (and the tests
   *  that drive them) keep working without one: every caret call answers "no
   *  line" rather than guessing when it is absent. */
  getEditor?: () => NekoEditor | null
  /** The live geometry, read at call time (see `editorScrollSync`). */
  geometry: () => RenderedGeometry
}

/** Everything the line↔offset mapping needs, for one reading of the document. */
export interface RenderedGeometry {
  items: ReturnType<typeof import('../../../services/outline').parseOutline>
  tops: number[] | null
  totalLines: number
  renderedRange: number
}

export interface EditorCaret {
  /**
   * The 1-based (fractional) source line the caret sits on, or null when the
   * pane cannot say — no editor, no view yet, a caret with no measurable
   * position, or a caret the user has not moved since the document was loaded.
   */
  getCaretLine(): number | null
  /** Put the caret on `line` (1-based) without moving the pane. */
  setCaretLine(line: number): void
  /** Put the caret at the document's very end, without moving the pane. */
  setCaretAtEnd(): void
  /** The model has just been given a document: record the selection it came
   *  with, which is not a caret anybody placed (see `getCaretLine`). */
  markDocumentLoaded(): void
}

export function createEditorCaret(deps: EditorCaretDeps): EditorCaret {
  /** The live ProseMirror view, or null before the editor is ready — the
   *  editor's own `getView()` throws until then (`editor-controller.getView`
   *  guards the same way). */
  function editorView(): EditorView | null {
    try {
      return deps.getEditor?.()?.getView() ?? null
    } catch {
      return null
    }
  }

  /** The selection head the model was given with the document, or null while no
   *  document has been loaded into it. */
  let loadedHead: number | null = null

  function markDocumentLoaded(): void {
    loadedHead = editorView()?.state.selection.head ?? null
  }

  /** Content-space top of the caret, or null when it cannot be measured. */
  function caretTop(): number | null {
    const el = deps.getScrollEl()
    const view = editorView()
    if (!el || !view) return null
    // The model holds no document of the open tab: its caret is a position in
    // whatever it was holding before, and every line this could be converted to
    // belongs to that other document. The automatic switch to source after a
    // failed parse is exactly when that is true, and it is the moment this is
    // read.
    //
    // A READ of `renderedModelRefused` and nothing more. The publish gate that
    // decides whether a serialization may reach `tab.content` is
    // `editor-persistence`'s, and this must stay a consumer of that fact rather
    // than a second place that acts on it — if the flag is stale it costs
    // precision here (the handoff falls back to the viewport line) and must not
    // cost anything else.
    if (renderedModelRefused()) return null
    try {
      const coords = view.coordsAtPos(view.state.selection.head)
      if (!coords) return null
      return coords.top - el.getBoundingClientRect().top + el.scrollTop
    } catch {
      // A selection with no position in this document (a model swap caught
      // mid-flight) is not a line, and guessing one would move the caret.
      return null
    }
  }

  function getCaretLine(): number | null {
    const view = editorView()
    // The caret the model was LOADED with is not a place the user was: ProseMirror
    // selects the end of a document it has just been given, and every note opens
    // that way. Carrying it would put the next keystroke at the end of the note
    // while the viewport a mode switch just restored sits somewhere else — the
    // text would arrive off-screen. So the answer is "no caret to carry" until
    // the user has moved it, and the handoff falls back to the viewport line.
    if (view && loadedHead !== null && view.state.selection.head === loadedHead) return null
    const top = caretTop()
    if (top === null) return null
    return renderedLineOrRatio(top, deps.geometry())
  }

  /**
   * The document position of the text `offset` px down the rendered content, at
   * block granularity and interpolated across the block's own text.
   *
   * A binary search over the top-level blocks rather than `posAtCoords`: that
   * one hit-tests the viewport, so a position outside it answers null — and the
   * whole point of carrying a caret is the case where the caret is NOT where the
   * viewport is (`coordsAtPos` reports layout coordinates for any position,
   * on-screen or not). Each probe is one measurement of one block, so the walk
   * costs log(blocks) rather than a layout read per paragraph in the note.
   *
   * The interpolation is the same model the line↔offset mapping uses — a
   * block's rendered height against its text — so a caret restored from a line
   * lands within the paragraph that line names rather than at its start.
   */
  function posForOffset(view: EditorView, el: HTMLElement, offset: number): number | null {
    const doc = view.state.doc
    const count = doc.childCount
    if (count === 0) return null

    const starts: number[] = new Array<number>(count)
    let at = 0
    for (let i = 0; i < count; i += 1) {
      starts[i] = at
      at += doc.child(i).nodeSize
    }
    const origin = el.getBoundingClientRect().top - el.scrollTop
    const topOf = (index: number): number | null => {
      try {
        const coords = view.coordsAtPos(starts[index])
        return coords ? coords.top - origin : null
      } catch {
        return null
      }
    }

    let low = 0
    let high = count - 1
    let found = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      const top = topOf(mid)
      if (top === null) return null
      if (top <= offset) {
        found = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    // Above the first block (the pane's own top padding): the document starts
    // there, and the first block is the nearest position to it.
    const index = found >= 0 ? found : 0
    const start = starts[index]
    const node = doc.child(index)
    const element = view.nodeDOM(start)
    if (!(element instanceof HTMLElement) || node.content.size === 0) return start + 1
    const rect = element.getBoundingClientRect()
    const textLength = node.textContent.length
    if (textLength === 0 || rect.height <= 0) return start + 1
    const progress = Math.max(0, Math.min((offset - (rect.top - origin)) / rect.height, 1))
    return start + 1 + Math.round(progress * textLength)
  }

  /**
   * Put the caret at the very END of the document, without moving the pane.
   *
   * What a click in the panel's trailing space means: the space is the note's
   * own continuation as far as the reader is concerned, so the caret goes where
   * the text stops. The line↔offset mapping is the wrong instrument for it — a
   * section's lines are spread over its rendered height, so the last line's own
   * end is not one of its anchors (measured: a click in the space put the caret
   * at paragraph 56 of 60).
   */
  function setCaretAtEnd(): void {
    const view = editorView()
    if (!view) return
    const end = view.state.doc.content.size
    dispatchCaret(view, end)
  }

  function setCaretLine(line: number): void {
    const el = deps.getScrollEl()
    const view = editorView()
    if (!el || !view) return
    const geometry = deps.geometry()
    const offset = renderedTopFor(
      line,
      geometry.items,
      geometry.tops,
      geometry.totalLines,
      geometry.renderedRange,
    )
    const pos = posForOffset(view, el, offset)
    if (pos === null) return
    dispatchCaret(view, pos)
  }

  /** Move the selection, without making it an undo step.
   *
   *  Placing the caret is not an edit — it must not be a step the user presses
   *  Ctrl+Z through (the source pane's `setCaretLine` carries the same
   *  annotation). The property is named as a string on purpose, which is how
   *  proseMirror-history reads it (`tr.getMeta("addToHistory")`) and the form
   *  the docs specify: `Transaction.addToHistory` — the key the
   *  proseMirror-state helper would name — is dropped by this package's
   *  re-export, so reaching for it throws at the dispatch. */
  function dispatchCaret(view: EditorView, pos: number): void {
    const resolved = Math.max(0, Math.min(pos, view.state.doc.content.size))
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.near(view.state.doc.resolve(resolved)))
        .setMeta('addToHistory', false),
    )
  }

  return { getCaretLine, setCaretLine, setCaretAtEnd, markDocumentLoaded }
}
