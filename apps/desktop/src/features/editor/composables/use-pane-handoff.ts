import { nextTick, watch } from 'vue'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { countDocumentLines } from '../../../services/scroll-sync-anchors'
import { parseOutline } from '../../../services/outline'
import { renderedLineFor, renderedTopFor } from '../controller/pane-scroll-mapping'

/**
 * What a pane has to be able to tell the handoff: where in the document it is,
 * and how to be put somewhere else.
 *
 * Structural types rather than the components' exposed types, so what this
 * depends on is visible in one place — and so it is testable without a live
 * CodeMirror or Milkdown.
 */
export interface SourcePaneHandoff {
  /** 1-based (fractional) line at the top of the viewport. */
  getVisibleLine(): number
  /** The offset that puts that line at the top of the viewport. */
  scrollTopForLine(line: number): number
  setScrollTop(top: number, token: number): void
  setCaretLine(line: number): void
  focus(): void
}

export interface RenderedPaneHandoff {
  /** Content-space top offsets of the rendered headings, in document order. */
  getHeadingTops(): number[]
  /** Scrollable extent: what a rendered offset is measured against. */
  getScrollRange(): number
  /**
   * The pane's current scroll offset, in content space.
   *
   * Paired with `setScrollTop`: the split-view sync reads both panes to decide
   * which one the user actually scrolled, so it needs to read as well as write.
   * Both were exposed by the component before they were declared here, which is
   * why the split sync compiled against a narrower type than it used — the
   * declaration had simply not kept up.
   */
  getScrollTop(): number
  setScrollTop(top: number, token: number): void
  /** Put `line` at the top of the pane. `token` marks the write as the
   *  program's, so the echo does not come back as a user scroll. */
  setScrollToLine(line: number, token: number): void
  focus(): void
}

export interface PaneHandoffOptions {
  /** The source pane, or null while it is not mounted (it is loaded on demand). */
  getSourcePane: () => SourcePaneHandoff | null
  getRenderedPane: () => RenderedPaneHandoff | null
  /** The element both panes live in: focus inside it is the editor's already. */
  getPanesEl: () => HTMLElement | null
  /** Identifies each programmatic write, so the pane that receives it can
   *  recognise its own echo (see the panes' `setScrollTop`). */
  nextToken: () => number
}

/** A control that switches which pane is shown. The keyboard follows it: the
 *  user has just asked for that pane, and the button otherwise keeps the focus
 *  the click gave it, so the first keystrokes go nowhere. */
const SWITCH_CONTROL = '[data-view-switch]'

/**
 * Hand a mode switch over: the keyboard moves to the pane now shown, and the
 * place the user was reading moves with it.
 *
 * A mode switch changes the surface, not the document, so the two panes have to
 * agree on one point in it. They cannot agree in pixels — source and rendered
 * text lay out at different heights, which is why the split sync maps through
 * the document's own lines — so the position is carried as a source line and
 * re-planted by whichever pane is arriving.
 *
 * The pane being LEFT is the authority on where the user was, and it is read
 * while it is still there: the mode change is what unmounts the source pane,
 * and the rendered pane's heading offsets stop being measurable the moment it
 * is hidden. The view store's per-pane memory is the same position recorded by
 * the panes themselves as they scroll (see `PaneScrollState`), which is what a
 * restore that has to wait for the source pane's chunk can still read.
 */
export function usePaneHandoff(options: PaneHandoffOptions): void {
  const view = useViewStore()
  const tabs = useTabsStore()

  /** The line a source pane that does not exist yet has to be planted on. */
  let pendingSourceLine: number | null = null
  /** The source pane still owes the handoff its keyboard (it mounts late). */
  let pendingSourceFocus = false

  /** True while this flush is a document switch. A mode change that arrives
   *  with one is an OPEN, not a pane switch: App.vue puts the live mode back to
   *  its default on every newly opened document, and the coordinates being
   *  carried were measured in the note being left. */
  let documentSwitched = false
  watch(
    () => tabs.activeId,
    () => {
      documentSwitched = true
      view.forgetPaneScroll()
      // Cleared once this flush's watchers have all run — which is where the
      // mode change driven by the same event lands.
      void nextTick(() => {
        documentSwitched = false
      })
    },
  )

  /** The document position a pane's own scroll state corresponds to, for a
   *  document with no headings to anchor on. */
  function ratioLine(top: number, range: number, totalLines: number): number {
    const ratio = range > 0 ? Math.max(0, Math.min(top / range, 1)) : 0
    return 1 + ratio * Math.max(0, totalLines - 1)
  }

  /** The line the rendered pane is showing, or null when nothing can place it. */
  function renderedLine(): number | null {
    const rendered = options.getRenderedPane()
    const { top, range } = view.renderedScroll
    const content = tabs.activeTab?.content ?? ''
    const items = parseOutline(content)
    const totalLines = countDocumentLines(content)
    const tops = rendered?.getHeadingTops() ?? []
    const line = renderedLineFor(top, {
      items,
      // The offsets come from the DOM and the outline from the text, so a
      // length mismatch means a heading is mid-render: the anchors cannot be
      // paired, and the ratio is the honest fallback.
      tops: items.length > 0 && tops.length === items.length ? tops : null,
      totalLines,
      renderedRange: range,
    })
    if (line !== null) return line
    if (!rendered) return null
    return ratioLine(top, range, totalLines)
  }

  /** The line the source pane is showing: the pane's own measurement when it is
   *  mounted (only CodeMirror can turn its offsets into line positions), and its
   *  last reported position otherwise. */
  function sourceLine(): number | null {
    const source = options.getSourcePane()
    if (source) return source.getVisibleLine()
    const { top, range } = view.sourceScroll
    if (range <= 0) return null
    return ratioLine(top, range, countDocumentLines(tabs.activeTab?.content ?? ''))
  }

  /** Whether the keyboard should follow a mode change into the pane now shown. */
  function shouldTakeFocus(): boolean {
    const active = document.activeElement as HTMLElement | null
    if (!active || active === document.body) return false
    if (active.closest(SWITCH_CONTROL)) return true
    const panes = options.getPanesEl()
    return panes !== null && panes.contains(active)
  }

  /** Plant the source pane on `line`: the offset that shows it at the top of the
   *  viewport, and the caret there so the next keystroke continues where the
   *  user was — which is the whole complaint: it used to land at offset 0. */
  function plantSource(line: number, source: SourcePaneHandoff): void {
    source.setScrollTop(source.scrollTopForLine(line), options.nextToken())
    source.setCaretLine(line)
  }

  function handOffFocus(pane: 'source' | 'rendered' | 'split'): void {
    if (pane === 'split' || !shouldTakeFocus()) return
    // After the flush, for the same reason as the scroll: the pane being opened
    // is still hidden while the mode watcher runs, and a hidden element cannot
    // take the keyboard.
    void nextTick(() => {
      if (pane === 'rendered') {
        options.getRenderedPane()?.focus()
        return
      }
      const source = options.getSourcePane()
      if (source) source.focus()
      else pendingSourceFocus = true
    })
  }

  watch(
    () => view.mode,
    (mode, prev) => {
      if (mode === prev || documentSwitched) return
      // The pane the user was working in — which in split mode is the one they
      // were last in, not the mode they asked for (both are on screen there, so
      // it is also the pane the handoff must not move).
      const target = mode === 'split' ? prev : mode

      // A pane is only ever moved when it was NOT on screen. Coming from split
      // both panes are already where the user left them (and the split sync
      // keeps them in step), so re-placing either one would throw away the
      // position they were working in.
      if (mode === 'source') {
        if (prev === 'rendered') {
          const line = renderedLine()
          if (line !== null) {
            const source = options.getSourcePane()
            if (source) plantSource(line, source)
            else pendingSourceLine = line
          }
        }
      } else if (mode === 'rendered' && prev === 'source') {
        // Two opposite timings in one move: the position has to be READ now —
        // this flush unmounts the source pane, and only CodeMirror can say
        // which line it was showing — but WRITTEN after it, because until the
        // flush's DOM update runs the rendered pane is still hidden behind
        // `v-show`, and a hidden element has no scroll box to write to and no
        // measurable heading offsets to map through.
        const line = sourceLine()
        const rendered = options.getRenderedPane()
        if (line !== null && rendered) {
          void nextTick(() => {
            const content = tabs.activeTab?.content ?? ''
            const items = parseOutline(content)
            const tops = rendered.getHeadingTops()
            rendered.setScrollTop(
              renderedTopFor(
                line,
                items,
                // The offsets come from the DOM and the outline from the text,
                // so a length mismatch means a heading is mid-render.
                items.length > 0 && tops.length === items.length ? tops : null,
                countDocumentLines(content),
                rendered.getScrollRange(),
              ),
              options.nextToken(),
            )
          })
        }
      } else {
        // The mode is no longer the one that wanted the source pane placed:
        // a handoff still waiting for it belongs to a switch the user has
        // already left behind.
        pendingSourceLine = null
        pendingSourceFocus = false
      }

      handOffFocus(target)
    },
  )

  // The source pane is an async component, so a handoff into it finishes as soon
  // as the component exists. One tick after it does: the pane's own mount is
  // what creates its CodeMirror view, and a scroll or a caret written before
  // that lands nowhere (the component instance exists when this watcher fires;
  // the editor inside it does not yet).
  watch(
    () => options.getSourcePane(),
    (source) => {
      if (!source) return
      const line = pendingSourceLine
      const wantsFocus = pendingSourceFocus
      pendingSourceLine = null
      pendingSourceFocus = false
      if (line === null && !wantsFocus) return
      void nextTick(() => {
        if (line !== null) plantSource(line, source)
        if (wantsFocus) source.focus()
      })
    },
  )
}
