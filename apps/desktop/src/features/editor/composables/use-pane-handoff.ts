import { nextTick, watch } from 'vue'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { countDocumentLines } from '../../../services/scroll-sync-anchors'
import { parseOutline } from '../../../services/outline'
import {
  renderedLineOrRatio,
  renderedTopFor,
  type RenderedPosition,
} from '../controller/pane-scroll-mapping'
import { useReadingPosition } from './use-reading-position'
import type { SourcePaneExpose } from './use-source-pane-slot'

/**
 * What a pane has to be able to tell the handoff: where in the document it is,
 * and how to be put somewhere else.
 *
 * Structural types rather than the components' exposed types, so what this
 * depends on is visible in one place — and so it is testable without a live
 * CodeMirror or Milkdown.
 */
/**
 * What the handoff needs from the source pane: the pane's own surface, and
 * nothing else.
 *
 * Declared as an extension of `SourcePaneExpose` rather than as its own list of
 * members on purpose. The handoff and the panes it drives are wired through the
 * same ref, so two member-by-member declarations would have to be kept in step
 * by hand — and this file's history already contains the failure that shape
 * produces: the handoff compiled against a narrower declaration than the pane
 * actually implemented (`setScrollTopForLine`, added when the plant had to be
 * measured rather than estimated), which no test in this feature can see because
 * `vitest` strips types. Naming the pane's own contract makes that drift a
 * compile error at the pane instead.
 */
export type SourcePaneHandoff = SourcePaneExpose

export interface RenderedPaneHandoff {
  /**
   * How many documents this pane's model has been given.
   *
   * The pane's own record that it is holding a document, and the only signal
   * that says WHEN that happened: the model is rebuilt asynchronously (the parse
   * is awaited), so a position that has to be written into this pane cannot be
   * written on the flush that opened the note. The pane counts the documents
   * that are the ACTIVE tab's, so an apply that lost a race with a tab switch
   * never reports a document no tab is showing. Read by `useReadingPosition`.
   */
  getDocumentVersion(): number
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
  /** The 1-based (fractional) source line the pane's caret is on, or null when
   *  it cannot say (no editor yet, or a selection with no position in this
   *  document). The counterpart of the source pane's own caret, read through
   *  CodeMirror there. */
  getCaretLine(): number | null
  /** Put the caret on `line` (1-based) without moving the pane. */
  setCaretLine(line: number): void
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
  /**
   * The 1-based line the source pane's caret is on, or null when there is none
   * to report.
   *
   * A callback rather than a `SourcePaneHandoff` member because only CodeMirror
   * can answer it, and the only thing the pane publishes for that is its view
   * (`SourcePaneExpose.getSourceView`) — the rendered pane answers the same
   * question as a member, through its own mapping. Whatever answers it, the
   * handoff treats the two alike: it carries the caret the pane actually has.
   */
  getSourceCaretLine: () => number | null
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

  /** Where a source pane that does not exist yet has to be planted: the place
   *  on screen, and the caret, which are two different lines (see `plantSource`). */
  let pendingSource: { scrollLine: number; caretLine: number } | null = null
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

  // Where the reader was in each note, and putting them back on it when the
  // note is activated again. A sibling of this module rather than a part of it:
  // it is the same contract (a position crossing a change of surface) between
  // two VISITS to a note instead of between the two panes, and it needs the
  // same pane accessors.
  useReadingPosition({
    getSourcePane: options.getSourcePane,
    getRenderedPane: options.getRenderedPane,
    nextToken: options.nextToken,
  })

  /** The document position an offset corresponds to by proportion. The rendered
   *  pane's own fallback lives in the mapping module (`renderedLineOrRatio`,
   *  which the pane reads its caret with too); this is the source pane's, whose
   *  offsets are measured against its own range. */
  function ratioLine(top: number, range: number, totalLines: number): number {
    const ratio = range > 0 ? Math.max(0, Math.min(top / range, 1)) : 0
    return 1 + ratio * Math.max(0, totalLines - 1)
  }

  /** Everything the offset→line mapping needs, read from the store's memory of
   *  where the rendered pane is (the pane itself may be hidden by now). */
  function renderedGeometry(): RenderedPosition {
    const rendered = options.getRenderedPane()
    const { range } = view.renderedScroll
    const content = tabs.activeTab?.content ?? ''
    const items = parseOutline(content)
    const tops = rendered?.getHeadingTops() ?? []
    return {
      items,
      // The offsets come from the DOM and the outline from the text, so a
      // length mismatch means a heading is mid-render: the anchors cannot be
      // paired, and the ratio is the honest fallback.
      tops: items.length > 0 && tops.length === items.length ? tops : null,
      totalLines: countDocumentLines(content),
      renderedRange: range,
    }
  }

  /** The line the rendered pane is showing, or null when nothing can place it. */
  function renderedLine(): number | null {
    if (!options.getRenderedPane()) return null
    return renderedLineOrRatio(view.renderedScroll.top, renderedGeometry())
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

  /**
   * Plant the source pane: `scrollLine` at the top of its viewport, and the
   * caret on `caretLine`.
   *
   * Two lines, because the pane is showing two things. Where the viewport is is
   * the reading position; where the caret is is the writing position, and the
   * whole complaint was that the second one used to be thrown away — a switch
   * that lands the caret at offset 0 (or at the top of the viewport, which is
   * the same guess with a better aim) puts the next keystroke somewhere the user
   * was not. Typing after a mode switch has to continue where typing before it
   * would have gone, whether or not the viewport happens to be scrolled to it.
   *
   * The caret write does not scroll (`SourcePane.setCaretLine` passes
   * `scrollIntoView: false`), so the two do not fight.
   */
  function plantSource(
    scrollLine: number,
    caretLine: number,
    source: SourcePaneHandoff,
  ): void {
    // Measured, not `setScrollTop(scrollTopForLine(...))`: the pane has just
    // mounted (a mode switch into source) or just been handed the note, and an
    // unmeasured height map turns a wrapped paragraph's line into a wildly
    // wrong offset — the browser-level handoff spec fails on exactly that,
    // roughly half the time, because the estimates are then either right
    // enough or nowhere near.
    source.setScrollTopForLine(scrollLine, options.nextToken())
    source.setCaretLine(caretLine)
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
            // Read now, while the rendered pane is still measurable and its
            // model still holds this document: the flush is what hides it.
            const caretLine = options.getRenderedPane()?.getCaretLine() ?? line
            const source = options.getSourcePane()
            if (source) plantSource(line, caretLine, source)
            else pendingSource = { scrollLine: line, caretLine }
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
          // The caret comes across too, and independently of the viewport line
          // above. Read here — outside the tick below, which is the same
          // read-before-the-flush rule as the line itself: this is the last
          // moment CodeMirror exists. A pane that cannot name its caret falls
          // back to the viewport line, which is what every switch did before
          // there was a caret to carry.
          const caretLine = options.getSourceCaretLine() ?? line
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
            // After the scroll, and deliberately not `scrollIntoView`: the
            // pane's own placement is the scroll's business, the caret's is
            // this one's, and both are true at once.
            rendered.setCaretLine(caretLine)
          })
        }
      } else {
        // The mode is no longer the one that wanted the source pane placed:
        // a handoff still waiting for it belongs to a switch the user has
        // already left behind.
        pendingSource = null
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
      const pending = pendingSource
      const wantsFocus = pendingSourceFocus
      pendingSource = null
      pendingSourceFocus = false
      if (pending === null && !wantsFocus) return
      void nextTick(() => {
        if (pending) plantSource(pending.scrollLine, pending.caretLine, source)
        if (wantsFocus) source.focus()
      })
    },
  )
}
