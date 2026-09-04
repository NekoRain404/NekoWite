import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { parseOutline } from '../../../services/outline'
import {
  anchorHeadingIndex,
  countDocumentLines,
  lineRatio,
} from '../../../services/scrollSyncAnchors'
import type { DocumentSession } from '../model/documentSession'

export interface EditorScrollSyncDeps {
  session: DocumentSession
  getScrollEl: () => HTMLElement | null
  getEditorEl: () => HTMLElement | null
}

export interface EditorScrollSync {
  /** Scroll handler: swallow the programmatic echo, else sync to the store. */
  onScroll(): void
  getRatio(): number
  setRatio(r: number): void
  getHeadingEls(): HTMLElement[]
  /** Scroll so the block containing the given 1-based source line is top-most,
   *  anchored on the nearest heading; falls back to a line-proportional ratio. */
  setScrollToLine(line: number): void
  /** Drop any pending suppression (used on teardown). */
  cancel(): void
}

/**
 * Source/rendered scroll synchronization.
 *
 * Keeps the split-mode ratio and the source-line → heading → DOM scroll mapping
 * in one place. Programmatic scrolls set `suppressScroll` so the browser's
 * asynchronous scroll echo cannot write back to the store and re-enter the sync
 * loop (which fights the mouse wheel).
 */
export function createEditorScrollSync(deps: EditorScrollSyncDeps): EditorScrollSync {
  const view = useViewStore()
  const tabs = useTabsStore()

  function onScroll(): void {
    // A programmatic scroll (setRatio) fires its scroll event asynchronously;
    // swallow exactly that one event so it cannot write back to the store and
    // re-enter the split-mode sync loop (which fights the mouse wheel).
    if (deps.session.suppressScroll) {
      deps.session.suppressScroll = false
      return
    }
    const el = deps.getScrollEl()
    if (el) view.syncScroll('rendered', el.scrollTop)
  }

  function getRatio(): number {
    const el = deps.getScrollEl()
    if (!el) return 0
    const range = el.scrollHeight - el.clientHeight
    return range > 0 ? el.scrollTop / range : 0
  }

  function setRatio(r: number): void {
    const el = deps.getScrollEl()
    if (!el) return
    const range = el.scrollHeight - el.clientHeight
    if (range <= 0) return
    const target = r * range
    // Only arm the suppression when the position actually changes — a no-op
    // assignment fires no scroll event, so the flag must not leak.
    if (Math.abs(el.scrollTop - target) < 0.5) return
    deps.session.suppressScroll = true
    el.scrollTop = target
  }

  function getHeadingEls(): HTMLElement[] {
    const root = deps.getEditorEl()
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
  }

  function setScrollToLine(line: number): void {
    const el = deps.getScrollEl()
    if (!el) return
    const content = tabs.activeTab?.content ?? ''
    const items = parseOutline(content)
    const index = anchorHeadingIndex(items, line)
    if (index === null) {
      setRatio(lineRatio(line, countDocumentLines(content)))
      return
    }
    const target = getHeadingEls()[index]
    if (!target) {
      setRatio(lineRatio(line, countDocumentLines(content)))
      return
    }
    const range = el.scrollHeight - el.clientHeight
    if (range <= 0) return
    // Content-space top of the heading, minus the same 16px scroll-margin-top
    // the editor styles use, so the heading sits just inside the viewport.
    const pos =
      target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16
    const clamped = Math.max(0, Math.min(pos, range))
    if (Math.abs(el.scrollTop - clamped) < 0.5) return
    deps.session.suppressScroll = true
    el.scrollTop = clamped
  }

  function cancel(): void {
    deps.session.suppressScroll = false
  }

  return { onScroll, getRatio, setRatio, getHeadingEls, setScrollToLine, cancel }
}
