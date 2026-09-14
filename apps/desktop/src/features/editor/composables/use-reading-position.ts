import { nextTick, watch } from 'vue'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { countDocumentLines } from '../../../services/scroll-sync-anchors'
import { parseOutline } from '../../../services/outline'
import { getFocusedPane } from '../../../services/editor-ownership'
import { renderedLineOrRatio } from '../controller/pane-scroll-mapping'
import {
  armReadingRestore,
  claimReadingLine,
  forgetReadingLines,
  rememberReadingLine,
} from '../model/reading-position'

/**
 * Switching notes must not throw the reader back to the top.
 *
 * The panes keep ONE editor between them and re-key it on every tab change, so
 * the position they were showing belongs to the note being left and is gone by
 * the time the new one is on screen — the store's per-pane memory is dropped as
 * part of the same switch on purpose (one note's coordinates must never be
 * carried into another). So the position is recorded here, per note, and put
 * back when that note is activated again; `model/reading-position` owns the
 * memory and what it means for it to be stale.
 *
 * This is the note-side half of the same contract `usePaneHandoff` keeps for
 * MODE switches: there the position crosses from one pane to the other, here it
 * crosses between two visits to the same note. Both speak in source lines,
 * because that is the only unit the two panes share.
 *
 * The panes are the only things that can measure themselves, so they are the
 * ones asked — and each takes the armed line itself, when it is holding the
 * note: the source pane's text is set the moment the tab changes (after that
 * flush), while the rendered pane's model is rebuilt when its parse resolves.
 * In split mode both take it, which is what leaves the two panes on one line.
 *
 * The shapes below are the slice of each pane this module uses, declared here
 * rather than imported from `usePaneHandoff` so this module does not point back
 * at its caller. The panes satisfy them structurally, the same way they satisfy
 * the handoff's own contracts.
 */
export interface SourceReadingPane {
  /** 1-based (fractional) line at the top of the viewport. */
  getVisibleLine(): number
  /** The offset that puts that line at the top of the viewport. */
  scrollTopForLine(line: number): number
  setScrollTop(top: number, token: number): void
  /** Put `line` at the top of the viewport, measured rather than estimated
   *  (the note's text has only just been handed to the pane). */
  setScrollTopForLine(line: number, token: number): void
}

export interface RenderedReadingPane {
  /** How many documents this pane's model has been given; see the pane. */
  getDocumentVersion(): number
  /** Content-space top offsets of the rendered headings, in document order. */
  getHeadingTops(): number[]
  /** Scrollable extent: what a rendered offset is measured against. */
  getScrollRange(): number
  getScrollTop(): number
  setScrollToLine(line: number, token: number): void
}

export interface ReadingPositionOptions {
  getSourcePane: () => SourceReadingPane | null
  getRenderedPane: () => RenderedReadingPane | null
  /** Identifies each programmatic write so the pane that receives it can
   *  recognise its own echo (see the panes' `setScrollTop`). */
  nextToken: () => number
}

export function useReadingPosition(options: ReadingPositionOptions): void {
  const tabs = useTabsStore()
  const view = useViewStore()

  /**
   * The line the pane on screen is showing, read while it still holds the note
   * being LEFT.
   *
   * The note's text comes from the tab being left rather than from
   * `activeTab`, which has already moved on: the offsets are read from the DOM
   * of the document still on screen, so the outline they are mapped through has
   * to be that document's.
   */
  function leavingLine(tabId: string): number | null {
    // The pane the user was reading: the one on screen, and in split the one
    // they were last working in — the split sync keeps the two in step, so
    // either answers the same question.
    if (view.mode !== 'rendered' && getFocusedPane() !== 'rendered') {
      const source = options.getSourcePane()
      if (source) return source.getVisibleLine()
    }
    const rendered = options.getRenderedPane()
    if (!rendered) return null
    const content = tabs.tabs.find((tab) => tab.id === tabId)?.content ?? ''
    const items = parseOutline(content)
    const tops = rendered.getHeadingTops()
    return renderedLineOrRatio(rendered.getScrollTop(), {
      items,
      // The offsets come from the DOM and the outline from the text, so a
      // length mismatch means a heading is mid-render: the anchors cannot be
      // paired, and the ratio is the honest fallback.
      tops: items.length > 0 && tops.length === items.length ? tops : null,
      totalLines: countDocumentLines(content),
      renderedRange: rendered.getScrollRange(),
    })
  }

  /**
   * Put the source pane back where the note was left, when it is one of the
   * panes on screen.
   *
   * After the flush, because that is when the pane holds the new note's text —
   * its own watcher on the active tab runs in the same flush as this one — and
   * the line can only be turned into an offset against the text being restored
   * to. A pane that cannot take it (no view yet) leaves the claim unspent for
   * the pane that can.
   */
  function restoreSourcePane(tabId: string): void {
    if (view.mode === 'rendered') return
    const source = options.getSourcePane()
    if (!source) return
    const line = claimReadingLine(tabId, 'source')
    if (line === null) return
    source.setScrollTopForLine(line, options.nextToken())
  }

  watch(
    () => tabs.activeId,
    (id, prevId) => {
      // Where the reader was, recorded before the panes are handed the new
      // note: this is the last moment they hold the one being left.
      if (prevId && prevId !== id) {
        const line = leavingLine(prevId)
        if (line !== null) rememberReadingLine(prevId, line)
      }
      if (id) armReadingRestore(id)
      void nextTick(() => {
        if (id) restoreSourcePane(id)
      })
    },
  )

  // A note that is no longer open keeps no position: tab ids are numbered per
  // session, so a recycled id would otherwise inherit a closed note's line.
  watch(
    () => tabs.tabs.map((tab) => tab.id),
    (ids) => forgetReadingLines(ids),
  )

  /**
   * The rendered pane has been given a document — the moment a line can be
   * turned into an offset in it, because the offsets come from the rendered
   * headings and before the model holds the note there is nothing to measure.
   */
  watch(
    () => options.getRenderedPane()?.getDocumentVersion() ?? 0,
    () => {
      const id = tabs.activeId
      const rendered = options.getRenderedPane()
      if (!id || !rendered) return
      const line = claimReadingLine(id, 'rendered')
      if (line === null) return
      rendered.setScrollToLine(line, options.nextToken())
    },
  )
}
