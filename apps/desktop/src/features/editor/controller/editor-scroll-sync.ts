import { headingAnchorIds, type NekoEditor } from '@nekowite/editor-core'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { parseOutline } from '../../../services/outline'
import {
  anchorHeadingIndex,
  countDocumentLines,
  lineRatio,
} from '../../../services/scroll-sync-anchors'
import { createEditorCaret, type RenderedGeometry } from './editor-caret'

export interface EditorScrollSyncDeps {
  getScrollEl: () => HTMLElement | null
  getEditorEl: () => HTMLElement | null
  /** The rendered editor. Optional so the scroll-only callers (and the tests
   *  that drive them) keep working without one; every caret call answers "no
   *  line" rather than guessing when it is absent. */
  getEditor?: () => NekoEditor | null
  /**
   * The trailing space padding this pane's content box, in px.
   *
   * No longer read here, on purpose. The range this module reports is the
   * pane's own scrollable extent, and that extent INCLUDES the space: it is
   * padding on the content box, so it is inside the scroller, which is how the
   * last line can be raised off the bottom edge at all — it is part of what a
   * wheel reaches.
   *
   * Subtracting it back out (which is what this dep used to be for) made the
   * range the sync writes inside one tail SHORTER than the range the user can
   * scroll to. The sync clamped every write to its own range, so the pane it
   * moved could not follow the pane the user was holding into the trailing
   * space: the held pane showed the space below the last line and its
   * neighbour showed none — in whichever direction the scroll came from, which
   * is the flip the reader reported.
   *
   * Kept in the signature because `use-rendered-editor-stack` still passes it
   * (that file is outside this change); nothing in this module reads it, so a
   * caller that omits it loses nothing.
   */
  getTailSpace?: () => number
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
  /** Put the caret at the document's very end, without moving the pane. */
  setCaretAtEnd(): void
  /**
   * The model has just been given a document: record the selection it came with.
   *
   * Everything the user does afterwards is a caret they placed; the selection
   * ProseMirror chooses on load (the end of the document) is not, and a mode
   * switch must not carry it — see {@link getCaretLine}.
   */
  markDocumentLoaded(): void
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

  /**
   * The pane's scrollable extent: everything its scrollbar travels over, the
   * panel's trailing space included.
   *
   * This is the number the split sync maps through and clamps its writes to, so
   * it has to be the extent the user can reach by hand — the same range the
   * pane's own scroll event reports. A range that stopped a tail short of it
   * put every position the sync wrote above the position the user's wheel could
   * reach, and the two panes could not meet at the bottom of a document: the
   * one being dragged showed the space below the last line and the one being
   * driven could not be moved into its own.
   */
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

  /** Everything the line↔offset mapping needs, read live from the document, the
   *  DOM and the pane. Shared by the three callers so none of them can disagree
   *  with the others about which heading sits where. */
  function renderedGeometry(): RenderedGeometry {
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

  /** The caret half of "where the user is" (see `editor-caret`): a different
   *  question from the viewport's, asked against the same geometry. */
  const caret = createEditorCaret({
    getScrollEl: deps.getScrollEl,
    getEditor: deps.getEditor,
    geometry: renderedGeometry,
  })

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
    getCaretLine: caret.getCaretLine,
    setCaretLine: caret.setCaretLine,
    setCaretAtEnd: caret.setCaretAtEnd,
    markDocumentLoaded: caret.markDocumentLoaded,
    cancel,
  }
}
