import { headingAnchorIds, type NekoEditor } from '@nekowite/editor-core'
import { TextSelection } from '@milkdown/prose/state'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { parseOutline } from '../../../services/outline'
import { renderedModelRefused } from '../../../services/editor-ownership'
import {
  anchorHeadingIndex,
  countDocumentLines,
  lineRatio,
} from '../../../services/scroll-sync-anchors'
import { renderedLineOrRatio, renderedTopFor } from './pane-scroll-mapping'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

export interface EditorScrollSyncDeps {
  getScrollEl: () => HTMLElement | null
  getEditorEl: () => HTMLElement | null
  /** The rendered editor. Optional so the scroll-only callers (and the tests
   *  that drive them) keep working without one; every caret call answers "no
   *  line" rather than guessing when it is absent. */
  getEditor?: () => NekoEditor | null
}

export interface EditorScrollSync {
  /** Scroll handler. Returns whether the user made this scroll: a programmatic
   *  write's own echo reports it, so it is not one. */
  onScroll(): boolean
  getScrollTop(): number
  /** The pane's scrollable extent: 0 when the whole document fits. */
  getScrollRange(): number
  /** Write an offset from outside, tagged with the sync token that caused it. */
  setScrollTop(top: number, token: number): void
  /** Content-space top offsets of the rendered headings, in document order. */
  getHeadingTops(): number[]
  /** Scroll so the block containing the given 1-based source line is top-most,
   *  anchored on the nearest heading; falls back to a line-proportional ratio. */
  setScrollToLine(line: number, token: number): void
  /** Scroll the heading whose anchor slug is `slug` into view. */
  scrollToHeading(slug: string): void
  /**
   * The 1-based (fractional) source line the caret sits on, or null when the
   * pane cannot say — no editor, no view yet, or a caret with no measurable
   * position. The inverse of {@link setCaretLine}, and what a mode switch
   * carries out of the pane so typing continues where the user was.
   */
  getCaretLine(): number | null
  /**
   * Put the caret on `line` (1-based) without moving the pane: the scroll is
   * written separately by whoever is placing the pane, and letting this one move
   * it too would fight that.
   */
  setCaretLine(line: number): void
  /** Drop any pending write record (used on teardown). */
  cancel(): void
}

/**
 * Source/rendered scroll synchronization.
 *
 * Keeps the source-line → heading → DOM scroll mapping in one place. A
 * programmatic write records what it wrote, and the scroll event the browser
 * delivers for it later is swallowed on that record: a write that never fired
 * an event (a no-op, a clamped-away offset, a hidden pane) leaves a record the
 * next event cannot match, so the user's next scroll is still their own. An
 * unconditional "swallow the next event" flag cannot do that — it eats whatever
 * arrives next, which is how a pane gets stuck.
 */
export function createEditorScrollSync(deps: EditorScrollSyncDeps): EditorScrollSync {
  const view = useViewStore()
  const tabs = useTabsStore()

  // The last programmatic write: the token that caused it and the offset it
  // landed on. Its scroll event arrives asynchronously and looks exactly like a
  // user's, so the record is the only thing that tells the two apart.
  let programWrite: { token: number; top: number } | null = null

  function scrollRange(): number {
    const el = deps.getScrollEl()
    if (!el) return 0
    return Math.max(0, el.scrollHeight - el.clientHeight)
  }

  function onScroll(): boolean {
    const el = deps.getScrollEl()
    if (!el) return false
    // Where this pane is, recorded whoever moved it: a mode switch reads the
    // memory to put the pane back, and a programmatic write moved it just as
    // much as a wheel did. Written before the echo check below, which decides
    // only whether this scroll is the USER's (a sync request) — not whether it
    // counts as position.
    view.syncScroll('rendered', el.scrollTop, scrollRange())
    const written = programWrite
    programWrite = null
    // The record holds the engine's own value, so its echo matches exactly.
    // Anything else is a scroll the user made, however close it lands: a
    // tolerance here is what swallows a fractional scroll next to a write.
    if (written && el.scrollTop === written.top) return false
    return true
  }

  function getScrollTop(): number {
    return deps.getScrollEl()?.scrollTop ?? 0
  }

  function write(top: number, token: number): void {
    const el = deps.getScrollEl()
    if (!el) return
    const clamped = Number.isFinite(top) ? Math.max(0, Math.min(top, scrollRange())) : 0
    el.scrollTop = clamped
    // Record what the engine ACCEPTED, not what was asked for. An engine snaps
    // a scroll offset to its own quantum (and clamps it to the range), so the
    // requested value can sit up to half a pixel from the one the write's scroll
    // event will report — a whole pixel on an engine that truncates instead of
    // rounding, where the tolerance this used to need would have missed most
    // frames of an ease. Reading the offset back closes the gap, which is what
    // lets `onScroll` compare exactly below.
    programWrite = { token, top: el.scrollTop }
  }

  function getHeadingEls(): HTMLElement[] {
    const root = deps.getEditorEl()
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
  }

  /** Content-space top of every rendered heading. Read live: an image that
   *  finishes loading moves every heading below it. */
  function getHeadingTops(): number[] {
    const el = deps.getScrollEl()
    const root = deps.getEditorEl()
    if (!el || !root) return []
    const origin = el.getBoundingClientRect().top - el.scrollTop
    return getHeadingEls().map((heading) => heading.getBoundingClientRect().top - origin)
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

  /** Everything the line↔offset mapping needs, read live from the document, the
   *  DOM and the pane. Shared by the three callers so none of them can disagree
   *  with the others about which heading sits where. */
  function renderedGeometry(): {
    items: ReturnType<typeof parseOutline>
    tops: number[] | null
    totalLines: number
    renderedRange: number
  } {
    const content = tabs.activeTab?.content ?? ''
    const items = parseOutline(content)
    const tops = getHeadingTops()
    return {
      items,
      // The offsets come from the DOM and the outline from the text, so a length
      // mismatch means a heading is mid-render: nothing can be paired.
      tops: items.length > 0 && tops.length === items.length ? tops : null,
      totalLines: countDocumentLines(content),
      renderedRange: scrollRange(),
    }
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
    const top = caretTop()
    if (top === null) return null
    return renderedLineOrRatio(top, renderedGeometry())
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

  function setCaretLine(line: number): void {
    const el = deps.getScrollEl()
    const view = editorView()
    if (!el || !view) return
    const geometry = renderedGeometry()
    const offset = renderedTopFor(
      line,
      geometry.items,
      geometry.tops,
      geometry.totalLines,
      geometry.renderedRange,
    )
    const pos = posForOffset(view, el, offset)
    if (pos === null) return
    const resolved = Math.max(0, Math.min(pos, view.state.doc.content.size))
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.near(view.state.doc.resolve(resolved)))
        // Placing the caret is not an edit — it must not be a step the user
        // presses Ctrl+Z through (the source pane's `setCaretLine` carries the
        // same annotation). The property is named as a string on purpose, which
        // is how proseMirror-history reads it (`tr.getMeta("addToHistory")`) and
        // the form the docs specify: `Transaction.addToHistory` — the key the
        // proseMirror-state helper would name — is dropped by this package's
        // re-export, so reaching for it throws at the dispatch.
        .setMeta('addToHistory', false),
    )
  }

  function setScrollToLine(line: number, token: number): void {
    const el = deps.getScrollEl()
    if (!el) return
    const { items, totalLines } = renderedGeometry()
    const index = anchorHeadingIndex(items, line)
    const target = index === null ? null : getHeadingEls()[index]
    if (!target) {
      write(lineRatio(line, totalLines) * scrollRange(), token)
      return
    }
    // Content-space top of the heading, minus the same 16px scroll-margin-top
    // the editor styles use, so the heading sits just inside the viewport.
    const pos =
      target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16
    write(pos, token)
  }

  /**
   * Follow a heading anchor (`#slug`) to the heading it names.
   *
   * The editor's own heading anchors copy these links, so following one has to
   * land on the heading rather than fall through to the browser (which would try
   * to navigate the app window). The document-wide id list is rebuilt here the
   * same way the anchors and the export build it, and the heading is picked by
   * INDEX: comparing slugs would send `#same-1` to the first "Same" instead of
   * the second.
   */
  function scrollToHeading(slug: string): void {
    if (!slug) return
    const headings = getHeadingEls()
    if (headings.length === 0) return
    const ids = headingAnchorIds(headings.map((heading) => heading.textContent ?? ''))
    const index = ids.indexOf(slug)
    if (index >= 0) headings[index]?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }

  function cancel(): void {
    programWrite = null
  }

  return {
    onScroll,
    getScrollTop,
    getScrollRange: scrollRange,
    setScrollTop: write,
    getHeadingTops,
    setScrollToLine,
    scrollToHeading,
    getCaretLine,
    setCaretLine,
    cancel,
  }
}
