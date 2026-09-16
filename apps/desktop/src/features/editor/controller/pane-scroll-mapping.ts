import {
  anchorHeadingIndex,
  clampLine,
  clampRatio,
  lineRatio,
  nearestHeadingIndex,
} from '../../../services/scroll-sync-anchors'
import type { OutlineItem } from '../../../services/outline'

/**
 * The mapping between the two split-view panes' scroll positions.
 *
 * Source text and rendered text are laid out differently, so the panes move by
 * different amounts for the same travel. Headings are the anchors in both
 * directions: the source line and the heading index map to each other, and the
 * offset is interpolated inside the heading's own block. Snapping to the
 * heading instead would park the rendered pane on a section's first heading for
 * as long as the source is anywhere inside that section — a whole section of
 * the two panes showing different text.
 *
 * Everything here is a pure function of the two panes' geometry, which arrives
 * as injected readers (`PaneGeometry`) rather than as DOM access. The mapping
 * is the part of the sync that is worth testing on its own, so it does not live
 * inside the component that happens to own the panes.
 */

/**
 * Pane edge detection tolerance, in px, inclusive.
 *
 * A scroll position this close to an end is the end. Land exactly on it: the
 * pane's own scroll event compares the offset a write kept with the one it
 * asked for, and a real engine snaps a fractional `scrollTop` to its own
 * quantum, so a position one quantum short of an end is that end — writing the
 * fraction instead would leave the engine holding a different number, and the
 * pane's echo of the write would read back as a scroll the user made.
 *
 * Deliberately not the ease's arrival tolerance (`SPLIT_SCROLL_SETTLE_PX`,
 * 0.25): that one asks "has this leg finished travelling?", and half a pixel of
 * remaining travel there is a visible creep. This one asks "is this the
 * document's end?", where the answer has to tolerate the engine's rounding. The
 * two were one constant until the ease's tolerance was tightened.
 */
export const PANE_EDGE_PX = 0.5

/** Everything the mapping needs from the two panes and the document. `from` is
 *  the pane the user is scrolling; `to` is the counterpart being driven. */
export interface PaneGeometry {
  /** Current offset of the pane being followed. */
  fromTop: number
  /** Scrollable extent of that pane. */
  fromRange: number
  /** Scrollable extent of the counterpart. */
  toRange: number
  /** The document's line count by `countDocumentLines`. */
  totalLines: number
  /** The parsed outline: the headings' 1-based line numbers, in document order.
   *  Empty when the document has none. */
  items: OutlineItem[]
  /** Every heading's top offset in the rendered pane's content space, in the
   *  same order — or null when the two are out of step. The offsets come from
   *  the DOM and the outline from the source text, so a length mismatch means a
   *  heading is mid-render and the pairing cannot be trusted; both directions
   *  fall back to the ratio instead. */
  tops: number[] | null
  /** The source pane's own offset for a 1-based line. CodeMirror measures its
   *  lines itself, so it is injected rather than computed here. */
  sourceTopOfLine: (line: number) => number
}

/** Where the counterpart pane has to be scrolled for both panes to show the
 *  same part of the document, and whether that position is the document's own
 *  end (which is written immediately: an ease there only adds latency). */
export interface PaneSyncPlan {
  top: number
  atEdge: boolean
}

/** Where `value` sits between `from` and `to`, carried onto the other pair.
 *  A degenerate range starts at its own beginning. */
function between(value: number, from: number, to: number, fromOut: number, toOut: number): number {
  if (to === from) return fromOut
  const progress = Math.max(0, Math.min((value - from) / (to - from), 1))
  return fromOut + progress * (toOut - fromOut)
}

/** Whether the document opens with body text above its first heading. That text
 *  is the first heading's own preamble, and it occupies rendered space the
 *  heading's block has to include; a document whose line 1 is a heading has
 *  none. */
function hasPreamble(items: OutlineItem[]): boolean {
  return items[0].line > 0
}

/**
 * The rendered offset of the top of the block that `index` anchors.
 *
 * The first block of a document that opens with a heading starts at the
 * document's own top, not at that heading. The heading is obviously still where
 * it is — the block simply reaches back over the rendered pane's own top
 * padding to 0, which is the only position `scrollTop` can hold for it.
 *
 * Without that, the document's top is unreachable through the anchors: the
 * pane's edge rule forces 0 for a source pane sitting at its own top, and the
 * first wheel notch goes through the anchors instead and lands on the heading's
 * offset — the pane's top padding, ~24px, in a single step. Letting the block
 * start at 0 keeps the document's top exact and makes the mapping continuous
 * through it: one source line of travel moves the rendered pane by one line of
 * the block's own scale, from the very first line.
 *
 * A document that opens with body text is different, and unchanged: lines 1 to
 * the first heading are that heading's preamble, and the block the heading
 * anchors starts at the heading — see `renderedTopFor`.
 */
function blockTop(items: OutlineItem[], tops: number[], index: number): number {
  if (index > 0 || hasPreamble(items)) return tops[index]
  return 0
}

/** The rendered offset that puts `line` (possibly fractional, 1-based) at the top
 *  of the rendered pane, or — for a caret — at the position in the document its
 *  line names.
 *
 *  The last block has no heading below it to be bounded by, so its span ends at
 *  the end the caller supplies. Two callers want two different ends there, and
 *  they are not the same quantity: a pane being scrolled wants the furthest
 *  position it can REACH (`range`) so a document whose panes are laid out at
 *  different heights still lines up when it runs out, and a caret wants where
 *  the CONTENT actually stops. `range` is `scrollHeight - clientHeight`, which
 *  is the content's end only while the content overflows the pane: on a note
 *  shorter than its pane it is 0, above the last heading's own top, and the span
 *  runs the line BACKWARDS — every line from that heading collapses onto the
 *  heading, which is where a caret in the final section used to land. */
export function renderedTopFor(
  line: number,
  items: OutlineItem[],
  tops: number[] | null,
  totalLines: number,
  range: number,
  /** Where the rendered content actually ends, in the same space as `tops`. The
   *  span never ends below `range` — a pane cannot travel past its own content,
   *  so a caller whose pane reports no end (hidden, not laid out, or a scroll
   *  caller with no document measurement to offer) keeps the travel it always
   *  had. */
  contentEnd?: number,
): number {
  if (items.length === 0 || !tops) return clampRatio(lineRatio(line, totalLines)) * range
  const firstLine = items[0].line + 1
  if (line < firstLine) {
    // Above the first heading: those lines are its preamble, and they occupy
    // the rendered pane's own top through to that heading.
    return between(line, 1, firstLine, 0, tops[0])
  }
  // `?? 0` cannot fire — the empty outline was already sent down the ratio
  // path above — but the helper types a null for that case.
  const index = anchorHeadingIndex(items, line) ?? 0
  const startLine = items[index].line + 1
  const startTop = blockTop(items, tops, index)
  const next = items[index + 1]
  if (!next) {
    return between(line, startLine, totalLines + 1, startTop, Math.max(range, contentEnd ?? 0))
  }
  return between(line, startLine, next.line + 1, startTop, tops[index + 1])
}

/** The source offset for a (possibly fractional) 1-based line. One past the
 *  last line is the document's end, which is where the pane runs out. */
function sourceOffsetForLine(
  line: number,
  totalLines: number,
  range: number,
  sourceTopOfLine: (line: number) => number,
): number {
  if (line >= totalLines + 1) return range
  const start = clampLine(line, totalLines)
  const progress = Math.max(0, Math.min(line - start, 1))
  const startTop = sourceTopOfLine(start)
  const nextTop = start < totalLines ? sourceTopOfLine(start + 1) : range
  return Math.max(0, Math.min(startTop + progress * (nextTop - startTop), range))
}

/** What the inverse mapping needs. The two ranges are named for the pane they
 *  belong to: `renderedRange` is the pane `offset` is measured in (the one that
 *  was scrolled, and the one the anchors' `tops` live in), and `sourceRange` is
 *  the pane the result is written to. */
export interface SourceMapping {
  items: OutlineItem[]
  tops: number[] | null
  totalLines: number
  /** Scrollable extent of the rendered pane — the space `offset` is in. */
  renderedRange: number
  /** Scrollable extent of the source pane — the space the result is in. */
  sourceRange: number
  sourceTopOfLine: (line: number) => number
}

/** What the rendered-offset → source-line mapping needs: where the rendered
 *  pane's headings are, in the space the offset is measured in. */
export interface RenderedPosition {
  items: OutlineItem[]
  tops: number[] | null
  totalLines: number
  /** Scrollable extent of the rendered pane — the space `offset` is in. */
  renderedRange: number
}

/**
 * The 1-based source line (fractional) whose text the rendered pane has at the
 * top of its viewport, or null when the document has no headings to anchor on
 * (or the offsets and the outline are out of step, which the caller signals
 * with a null `tops`).
 *
 * The inverse of `renderedTopFor`, and the half of `sourceTopFor` that does not
 * depend on the source pane's own measurements. A caller that only needs to
 * know WHERE in the document the rendered pane is — the mode handoff, which has
 * to name a position that survives the switch while the rendered pane is
 * hidden and unmeasurable — must not have to mount a source pane to find out.
 *
 * Both directions go through this one function so the pane a mode switch
 * restores to is the same one the split sync would have scrolled to: a second
 * copy of the anchor arithmetic is exactly where the two drift apart.
 */
export function renderedLineFor(offset: number, geometry: RenderedPosition): number | null {
  const { items, tops, totalLines, renderedRange } = geometry
  const index = items.length > 0 && tops ? nearestHeadingIndex(tops, offset) : null
  if (index === null || !tops) return null
  // Above the first heading the block runs from the document's own top to that
  // heading — `nearestHeadingIndex` clamps onto the heading, but the text above
  // it is not the heading. That is a *different* span from the block the
  // heading anchors (which starts at the heading), because the preamble's lines
  // occupy the rendered space above it. A document that opens with a heading
  // has no such lines: its first block's origin is the document's own top, and
  // this is the same span either way.
  const startTop = blockTop(items, tops, index)
  if (index === 0 && offset < startTop) return between(offset, 0, startTop, 1, items[0].line + 1)
  const next = items[index + 1]
  return between(
    offset,
    startTop,
    next ? tops[index + 1] : renderedRange,
    items[index].line + 1,
    next ? next.line + 1 : totalLines + 1,
  )
}

/**
 * The 1-based source line at rendered offset `offset`, with the proportion
 * fallback folded in: a document with no headings to anchor on (or one whose
 * offsets and outline are out of step, which the caller signals with a null
 * `tops`) maps by `offset`'s fraction of the pane instead.
 *
 * The fallback lives here rather than at each caller because two of them — the
 * mode handoff reading the pane's scroll memory when the pane is hidden, and the
 * pane reading its own caret — must answer with the same line for the same
 * offset. A second copy is how the two would drift apart.
 */
export function renderedLineOrRatio(offset: number, geometry: RenderedPosition): number {
  const line = renderedLineFor(offset, geometry)
  if (line !== null) return line
  const { renderedRange, totalLines } = geometry
  const ratio = renderedRange > 0 ? Math.max(0, Math.min(offset / renderedRange, 1)) : 0
  return 1 + ratio * Math.max(0, totalLines - 1)
}

/** The inverse of `renderedTopFor`: the source offset that puts, at the top of
 *  the source pane, the text the rendered pane has at `offset`. */
export function sourceTopFor(offset: number, geometry: SourceMapping): number {
  const { totalLines, renderedRange, sourceRange, sourceTopOfLine } = geometry
  const line = renderedLineFor(offset, geometry)
  // No headings to anchor on — or offsets and outline out of step — means the
  // panes' positions correspond by proportion: `offset`'s fraction of the pane
  // it is in, carried onto the pane the result is for.
  if (line === null) {
    return clampRatio(renderedRange > 0 ? offset / renderedRange : 0) * sourceRange
  }
  return sourceOffsetForLine(line, totalLines, sourceRange, sourceTopOfLine)
}

/** Where the counterpart pane has to be to show what `from` is showing. */
export function planPaneSync(
  from: 'source' | 'rendered',
  geometry: PaneGeometry,
  /** Required when `from` is 'source': the topmost visible source line. */
  visibleLine = 1,
): PaneSyncPlan {
  const { fromTop, fromRange, toRange, totalLines, items, tops } = geometry
  // A pane at the end of its own range is at the end of the document, and that
  // is the one position the anchors cannot express: the last block's text stops
  // where the pane does. Landing on it exactly is what makes the document's
  // ends reachable from either pane.
  if (fromTop <= PANE_EDGE_PX) return { top: 0, atEdge: true }
  if (fromRange > PANE_EDGE_PX && fromTop >= fromRange - PANE_EDGE_PX) {
    return { top: toRange, atEdge: true }
  }

  const top =
    from === 'source'
      ? renderedTopFor(visibleLine, items, tops, totalLines, toRange)
      : sourceTopFor(fromTop, {
          items,
          tops,
          totalLines,
          // The pane being followed owns both the offset and the range it is
          // measured against. `toRange` is the counterpart's, and only the
          // anchors use it — through `tops`, which are rendered offsets.
          renderedRange: fromRange,
          sourceRange: geometry.toRange,
          sourceTopOfLine: geometry.sourceTopOfLine,
        })
  // A pane with nothing to scroll cannot follow in a visible way; treating it
  // as an edge keeps the write immediate rather than easing nowhere.
  return { top, atEdge: fromRange <= PANE_EDGE_PX }
}
