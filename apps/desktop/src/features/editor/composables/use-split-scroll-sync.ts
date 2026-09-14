import { computed, nextTick, onBeforeUnmount, watch, type ComputedRef } from 'vue'
import { useAppearanceStore } from '../../../stores/appearance'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { parseOutline, type OutlineItem } from '../../../services/outline'
import { createSplitScrollCoordinator } from '../../../services/split-scroll-coordinator'
import { countDocumentLines } from '../../../services/scroll-sync-anchors'
import { getFocusedPane } from '../../../services/editor-ownership'
import { planPaneSync, type PaneGeometry, type PaneSyncPlan } from '../controller/pane-scroll-mapping'
import { usePaneHandoff, type RenderedPaneHandoff } from './use-pane-handoff'
import type { SourcePaneExpose } from './use-source-pane-slot'

/**
 * The split view: how the two panes stay on the same place in the document, and
 * the geometry the divider between them moves.
 *
 * This is one unit because the three parts are one contract. The panes report
 * only the scrolls the user made; the coordinator below turns that into a move
 * of the *other* pane, tagged with a token so the resulting scroll event is
 * recognised as this program's own echo rather than a fresh request; and a
 * divider drag invalidates both panes' offsets at once, which is why resizing
 * speaks the same vocabulary (`cancel`, then one unanimated re-align) instead of
 * having its own. Split apart, each piece needs to know the others' internal
 * state — which is what this module exists to keep out of the pane.
 *
 * The pane keeps what is genuinely its own: the DOM refs it hands in here, the
 * float toolbar's store subscription, and the template.
 */

type PaneId = 'source' | 'rendered'

export interface SplitScrollSyncOptions {
  /** The source pane, or null while its chunk is still resolving. */
  getSourcePane: () => SourcePaneExpose | null
  /** The rendered pane's scroll surface, or null before it mounts. */
  getRenderedPane: () => RenderedPaneHandoff | null
  /** The element both panes live in. */
  getPanesEl: () => HTMLElement | null
}

export interface SplitScrollSync {
  sourceStyle: ComputedRef<Record<string, string>>
  renderedStyle: ComputedRef<Record<string, string>>
  /** A scroll the user made in one of the panes. */
  onUserScroll: (from: PaneId) => void
  onSplitResizeStart: () => void
  onSplitResize: (value: number) => void
  onSplitResizeEnd: () => void
  /** Drop the drag state without re-aligning — the window lost focus mid-drag,
   *  so there is no release to act on. */
  clearResizing: () => void
}

export function useSplitScrollSync(options: SplitScrollSyncOptions): SplitScrollSync {
  const view = useViewStore()
  const tabs = useTabsStore()
  const appearance = useAppearanceStore()

  // ---------------------------------------------------------------------------
  // Split-view scroll sync
  //
  // Both panes report the user's own scrolls here; everything else is the
  // coordinator below. It keeps one pending destination per tick and eases toward
  // the newest target, re-anchoring where the pane actually is, so a wheel burst
  // stays responsive instead of queueing one sync per event.
  //
  // The panes' exposed positions are still mirrored into the view store as the
  // current scroll state, but the store is no longer the transport: it used to
  // carry a programmatic write into the other pane, where the resulting scroll
  // event came back as a fresh user-originated sync request and the two panes
  // fought. Instead each pane reports only the scrolls the user made (see its
  // `user-scroll` event) and swallows the echo of a programmatic write, which
  // carries the sync token that caused it.
  // ---------------------------------------------------------------------------

  /** The pane the coordinator is currently moving. A user scroll switches it: the
   *  pane being scrolled becomes the origin and stops being driven, which is what
   *  makes a leg in flight interruptible. */
  let destination: PaneId = 'rendered'
  /** Identifies each programmatic write, and handed to the pane that receives it:
   *  a program's scroll event arrives later with nothing else to say where it came
   *  from, so the write carries its token and the pane keeps it (see the panes'
   *  `setScrollTop`). */
  let syncToken = 0

  function nextToken(): number {
    syncToken += 1
    return syncToken
  }

  function paneScrollTop(id: PaneId): number {
    if (id === 'source') return options.getSourcePane()?.getScrollTop() ?? 0
    return options.getRenderedPane()?.getScrollTop() ?? 0
  }

  function paneScrollRange(id: PaneId): number {
    if (id === 'source') return options.getSourcePane()?.getScrollRange() ?? 0
    return options.getRenderedPane()?.getScrollRange() ?? 0
  }

  // Switching modes changes the surface, not the document: the keyboard follows
  // into the pane now shown, and the place the user was reading is carried across
  // as a source line (a pixel offset from one pane means nothing in the other).
  usePaneHandoff({
    getSourcePane: () => options.getSourcePane(),
    getRenderedPane: () => options.getRenderedPane(),
    getPanesEl: () => options.getPanesEl(),
    nextToken,
    getSourceCaretLine: sourceCaretLine,
  })

  /** The 1-based line the source pane's caret is on, or null when the pane — or
   *  its CodeMirror view — is not there yet.
   *
   *  Only CodeMirror can answer this, and the pane publishes its view rather
   *  than a caret accessor (`SourcePaneExpose.getSourceView`), which is why the
   *  handoff takes this as a callback: the rendered pane answers the same
   *  question itself, through its own line↔offset mapping. */
  function sourceCaretLine(): number | null {
    const cm = options.getSourcePane()?.getSourceView()
    if (!cm) return null
    try {
      return cm.state.doc.lineAt(cm.state.selection.main.head).number
    } catch {
      return null
    }
  }

  function writeDestination(top: number): void {
    const token = nextToken()
    if (destination === 'source') options.getSourcePane()?.setScrollTop(top, token)
    else options.getRenderedPane()?.setScrollTop(top, token)
  }

  /** Parsed outline and line count of the document on screen. Every scroll event
   *  maps through these, so they are kept for the content string they were parsed
   *  from: re-parsing the whole document per wheel event would be O(document) per
   *  frame of a burst. */
  let outlineSource = ''
  let outlineItems: OutlineItem[] = []
  let outlineLines = 1

  function outlineForSync(): { items: OutlineItem[]; totalLines: number } {
    const content = tabs.activeTab?.content ?? ''
    if (content !== outlineSource) {
      outlineSource = content
      outlineItems = parseOutline(content)
      outlineLines = countDocumentLines(content)
    }
    return { items: outlineItems, totalLines: outlineLines }
  }

  /** The geometry the mapping works from: the panes' live offsets. The rendered
   *  headings' offsets collapse to null when they and the parsed outline are out
   *  of step (a heading mid-render), and the source pane's own line offsets come
   *  from the pane, which is the only thing that can measure them. */
  function paneGeometry(from: PaneId, to: PaneId): PaneGeometry {
    const { items, totalLines } = outlineForSync()
    const tops = options.getRenderedPane()?.getHeadingTops() ?? []
    return {
      fromTop: paneScrollTop(from),
      fromRange: paneScrollRange(from),
      toRange: paneScrollRange(to),
      totalLines,
      items,
      tops: items.length > 0 && tops.length === items.length ? tops : null,
      sourceTopOfLine: (line) => options.getSourcePane()?.scrollTopForLine(line) ?? 0,
    }
  }

  /** Where the counterpart pane has to be to show what `from` is showing, or null
   *  while either pane is missing (the source pane is an async component). */
  function planSync(from: PaneId, to: PaneId): PaneSyncPlan | null {
    const source = options.getSourcePane()
    if (!source || !options.getRenderedPane()) return null
    return planPaneSync(from, paneGeometry(from, to), source.getVisibleUnit() ?? 1)
  }

  /** The OS-level "reduce motion" preference — the same check the command palette
   *  makes. Scroll sync has to land immediately when the user asked for that. */
  function prefersReducedMotion(): boolean {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  }

  const scrollCoordinator = createSplitScrollCoordinator({
    // requestAnimationFrame is already shaped the way the coordinator wants it.
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    readScroll: () => paneScrollTop(destination),
    writeScroll: (top) => writeDestination(top),
    clampScroll: (top) => {
      const range = paneScrollRange(destination)
      if (!Number.isFinite(top)) return top > 0 ? range : 0
      return Math.max(0, Math.min(top, range))
    },
  })

  /**
   * Bring the counterpart of `from` onto the position `from` is showing.
   *
   * `animated` is the caller's answer to "may this glide?": user scrolling does,
   * the discrete moves (entering split, the end of a divider drag, an outline
   * jump) do not, and a document end never does — the ease would spend its last
   * frames creeping up on a position the user has already reached.
   */
  function align(from: PaneId, animated: boolean): void {
    const to: PaneId = from === 'source' ? 'rendered' : 'source'
    const plan = planSync(from, to)
    if (!plan) return
    // The destination has to be selected before the coordinator is asked to move:
    // it reads and writes through the adapter, which follows this.
    destination = to
    scrollCoordinator.schedule(plan.top, animated && !plan.atEdge && !prefersReducedMotion())
  }

  let resizing = false

  /** A scroll the user made in one of the panes. */
  function onUserScroll(from: PaneId): void {
    if (view.mode !== 'split' || resizing || !appearance.autoSyncScroll) return
    align(from, true)
  }

  // The source pane is loaded on demand (CodeMirror is async). Entering split
  // mode from the rendered view can happen before that chunk has resolved, so we
  // remember the pane that was visible before the switch and re-align once the
  // source pane's ref populates. The pane that was visible before entering split
  // is the reference: align the other pane to its scroll position once layout is
  // done. Both entries do nothing until both panes actually exist.
  let pendingSplitAlignFrom: PaneId | null = null

  function alignSplitPanes(prev: PaneId): void {
    // A layout move, not a scroll: the panes are put where they belong at once.
    align(prev, false)
  }

  watch(
    () => view.mode,
    (mode, prev) => {
      // Whatever the coordinator was moving belongs to the layout being left.
      scrollCoordinator.cancel()
      if (mode !== 'split' || prev === 'split') return
      pendingSplitAlignFrom = prev
      void nextTick(() => {
        if (view.mode !== 'split') return
        // The source pane may still be resolving its async chunk — the ref
        // watcher below retries once it mounts.
        if (!options.getSourcePane() || !options.getRenderedPane()) return
        pendingSplitAlignFrom = null
        alignSplitPanes(prev)
      })
    },
  )

  watch(
    () => options.getSourcePane(),
    () => {
      if (view.mode !== 'split') return
      if (!pendingSplitAlignFrom || !options.getSourcePane() || !options.getRenderedPane()) return
      const prev = pendingSplitAlignFrom
      pendingSplitAlignFrom = null
      alignSplitPanes(prev)
    },
  )

  function onSplitResizeStart(): void {
    resizing = true
    // The panes are being resized under the animation: stop it where it is and
    // re-align once the drag is over.
    scrollCoordinator.cancel()
    options.getSourcePane()?.setMeasureSuppressed(true)
  }

  function onSplitResize(value: number): void {
    view.setSplitRatio(value)
  }

  function clearResizing(): void {
    if (!resizing) return
    resizing = false
    options.getSourcePane()?.setMeasureSuppressed(false)
  }

  function onSplitResizeEnd(): void {
    if (!resizing) return
    clearResizing()
    if (view.mode !== 'split') return
    // Widths changed under both panes, so their scroll offsets are stale:
    // re-align once from the source pane (document flow reference), then let
    // normal scroll sync take over.
    align('source', false)
  }

  const sourceStyle = computed((): Record<string, string> => {
    if (view.mode !== 'split') return {}
    return { width: `${view.splitRatio * 100}%` }
  })
  const renderedStyle = computed((): Record<string, string> => {
    if (view.mode !== 'split') return {}
    return { width: `${(1 - view.splitRatio) * 100}%` }
  })

  /** Put a 1-based source line at a third of the way down the source pane.
   *  Deliberately not the top: a heading read as the first line of the viewport
   *  has nothing above it to say what section it belongs to. */
  function scrollToLine(line: number): void {
    const pane = options.getSourcePane()
    if (!pane) return
    const cm = pane.getSourceView()
    if (!cm) return
    const doc = cm.state.doc
    const clamped = Math.max(1, Math.min(line, doc.lines))
    const info = cm.lineBlockAt(doc.line(clamped).from)
    cm.scrollDOM.scrollTop = Math.max(0, info.top - cm.scrollDOM.clientHeight / 3)
  }

  /**
   * Give the pane the jump was made in its caret and its keyboard.
   *
   * A jump is a navigation the user asked for, and half of it was missing: the
   * viewport moved and nothing else did, so the keyboard stayed on the outline
   * button (typing after a jump did nothing at all) and the caret stayed where
   * it was (the first keystroke that did land would have dragged the viewport
   * back to it). Both panes' caret writes are `scrollIntoView: false`, so the
   * jump's own placement is not disturbed.
   *
   * Split shows both panes and the jump moves both, so the caret goes to the one
   * the user was working in — the pane the app already tracks for exactly this
   * question (see `services/editor-ownership`).
   */
  function landOn(line: number): void {
    const wantsSource =
      view.mode === 'source' || (view.mode === 'split' && getFocusedPane() === 'source')
    if (wantsSource) {
      const source = options.getSourcePane()
      source?.setCaretLine(line)
      source?.focus()
      return
    }
    const rendered = options.getRenderedPane()
    rendered?.setCaretLine(line)
    rendered?.focus()
  }

  watch(
    () => view.pendingOutlineTarget,
    async (target) => {
      if (!target) return
      view.consumeOutlineTarget()
      await nextTick()
      // The outline numbers a line the way `parseOutline` finds it in the
      // document's text — an index, so the first line is 0 — while every pane
      // API and the whole scroll mapping speak 1-based source lines. Convert
      // once, here, at the only place the store's outline target is read.
      // Skipping it for the rendered pane is what made a jump land on the
      // heading ABOVE the one that was clicked: the index was read as the count
      // of lines before the target, so the block it resolved to was the previous
      // heading's.
      const line = target.line + 1
      if (view.mode === 'source') {
        scrollToLine(line)
        landOn(line)
        return
      }
      // A jump is discrete: the rendered pane snaps onto the block that holds the
      // line and the source follows it without easing. Both writes are the
      // program's, so neither comes back as a user scroll.
      destination = 'rendered'
      options.getRenderedPane()?.setScrollToLine(line, nextToken())
      if (view.mode === 'split') align('rendered', false)
      landOn(line)
    },
  )

  onBeforeUnmount(() => {
    scrollCoordinator.dispose()
    // A drag interrupted by the pane going away would otherwise leave the
    // CodeMirror measure gate shut for the next pane that mounts.
    clearResizing()
  })

  return {
    sourceStyle,
    renderedStyle,
    onUserScroll,
    onSplitResizeStart,
    onSplitResize,
    onSplitResizeEnd,
    clearResizing,
  }
}
