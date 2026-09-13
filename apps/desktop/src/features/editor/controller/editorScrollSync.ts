import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { parseOutline } from '../../../services/outline'
import {
  anchorHeadingIndex,
  countDocumentLines,
  lineRatio,
} from '../../../services/scrollSyncAnchors'
import { SPLIT_SCROLL_SETTLE_PX } from '../../../services/splitScrollCoordinator'

export interface EditorScrollSyncDeps {
  getScrollEl: () => HTMLElement | null
  getEditorEl: () => HTMLElement | null
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
    const written = programWrite
    programWrite = null
    if (written && Math.abs(el.scrollTop - written.top) < SPLIT_SCROLL_SETTLE_PX) return false
    view.syncScroll('rendered', el.scrollTop)
    return true
  }

  function getScrollTop(): number {
    return deps.getScrollEl()?.scrollTop ?? 0
  }

  function write(top: number, token: number): void {
    const el = deps.getScrollEl()
    if (!el) return
    const clamped = Number.isFinite(top) ? Math.max(0, Math.min(top, scrollRange())) : 0
    programWrite = { token, top: clamped }
    el.scrollTop = clamped
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

  function setScrollToLine(line: number, token: number): void {
    const el = deps.getScrollEl()
    if (!el) return
    const content = tabs.activeTab?.content ?? ''
    const items = parseOutline(content)
    const index = anchorHeadingIndex(items, line)
    const target = index === null ? null : getHeadingEls()[index]
    if (!target) {
      write(lineRatio(line, countDocumentLines(content)) * scrollRange(), token)
      return
    }
    // Content-space top of the heading, minus the same 16px scroll-margin-top
    // the editor styles use, so the heading sits just inside the viewport.
    const pos =
      target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16
    write(pos, token)
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
    cancel,
  }
}
