import { TextSelection } from '@milkdown/prose/state'
import type { NekoEditor } from '@nekowite/editor-core'
import { useTabsStore } from '../../../stores/tabs'
import { renderedModelRefused } from '../../../services/editor-ownership'
import { documentLineFor, documentPositionFor } from './document-caret'
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
 *
 * A caret is placed by one of two routes, and which one is not a preference: a
 * document with headings has real anchors and goes through the line↔offset
 * mapping, and a document without them has none — the mapping falls back to a
 * fraction of the pane's SCROLLABLE extent, which is the wrong instrument for a
 * point in a document (nothing to scroll, and every line is at the top). That
 * case goes through the note's own blocks instead; see `document-caret`.
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

/**
 * Whether the line↔offset mapping has anchors to work with: headings in the
 * outline AND measured offsets for them.
 *
 * When it has not — a note with no headings at all, or one whose headings are
 * mid-render — `renderedTopFor` and `renderedLineFor` answer from the pane's
 * scrollable extent instead. Two of them must answer with the same line for the
 * same offset (that is why the fallback lives in one place, see
 * `renderedLineOrRatio`), and they do; but a VIEWPORT position is the only thing
 * that ratio can carry. A caret is a point in the document, and a document
 * shorter than its pane has no scrollable extent to be a fraction of.
 */
function hasAnchors(geometry: RenderedGeometry): boolean {
  return geometry.items.length > 0 && geometry.tops !== null
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
  // The note's text, read the same way `editorScrollSync`'s geometry reads it:
  // the block mapping and the outline's line numbers have to come from one
  // reading of the open document, or the two disagree about which block a line
  // is in.
  const tabs = useTabsStore()

  /** The note's own text — or the empty string, which no block pairing survives,
   *  when the model is holding another document's. That is the same refusal
   *  `caretTop` makes below, stated once for both directions: a caret in another
   *  note's text is not a position in this one. */
  function noteText(): string {
    if (renderedModelRefused()) return ''
    return tabs.activeTab?.content ?? ''
  }

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
    const geometry = deps.geometry()
    // The mirror of `setCaretLine`'s routing, and for the same reason: with no
    // anchors the ratio would be a fraction of the pane's scrollable extent,
    // which is nothing at all for a note shorter than the pane. Asked before
    // `caretTop` on purpose — the blocks need no measurement, and the flush that
    // carries a caret out of this pane is the one that hides it, where nothing
    // can be measured at all.
    if (view && !hasAnchors(geometry)) {
      const line = documentLineFor(view, noteText())
      if (line !== null) return line
    }
    const top = caretTop()
    if (top === null) return null
    return renderedLineOrRatio(top, geometry)
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

  /**
   * Where the rendered content actually ends, in the space the heading offsets
   * and `posForOffset`'s block tops are measured in: the LAST block's own
   * bottom, measured the way this file measures `tops` rather than deriving it.
   *
   * Neither number the pane already has is that end. `renderedRange` is a
   * quantity of the pane's SCROLLING (`scrollHeight - clientHeight`), which is 0
   * for a note shorter than its pane; and the content box is not it either,
   * because the pane keeps a tail of empty space below the note (80% of the
   * panel's height, so the last line can be scrolled up) inside that box. What
   * cannot be measured falls back to the box — a node mid-render, a pane no
   * engine has laid out — and the mapping keeps the pane's travel when that is 0
   * too.
   */
  function contentEnd(view: EditorView, el: HTMLElement): number {
    const last = view.state.doc.lastChild
    const element = last ? view.nodeDOM(view.state.doc.content.size - last.nodeSize) : null
    if (!(element instanceof HTMLElement)) return el.scrollHeight
    const rect = element.getBoundingClientRect()
    if (rect.height <= 0) return el.scrollHeight
    return rect.bottom - (el.getBoundingClientRect().top - el.scrollTop)
  }

  function setCaretLine(line: number): void {
    const el = deps.getScrollEl()
    const view = editorView()
    if (!el || !view) return
    const geometry = deps.geometry()
    // A note WITH headings keeps the anchored route. Without them the line is
    // placed through the note's own blocks, whose answer does not depend on how
    // much of the pane the note fills; the pixel route stays as the fallback for
    // the case the two readings of the note are out of step (see
    // `document-caret`).
    const byBlock = hasAnchors(geometry) ? null : documentPositionFor(view, noteText(), line)
    const pos =
      byBlock ??
      posForOffset(
        view,
        el,
        renderedTopFor(
          line,
          geometry.items,
          geometry.tops,
          geometry.totalLines,
          geometry.renderedRange,
          // The anchor path's last block ends in DOCUMENT space, which is where a
          // caret's offset lives — not at the pane's travel, which is 0 for a
          // note that fits its pane and runs the span back onto its own heading.
          contentEnd(view, el),
        ),
      )
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
