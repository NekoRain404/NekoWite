import { describe, expect, it } from 'vitest'
import type { OutlineItem } from '../../../services/outline'
import {
  PANE_EDGE_PX,
  planPaneSync,
  renderedTopFor,
  sourceTopFor,
  type PaneGeometry,
  type SourceMapping,
} from './paneScrollMapping'

/** The rendered pane's own top padding: what puts a document's first heading
 *  this far below the top of the scroll container. */
const PADDING = 24

/** Headings at 1-based lines 1, 22 and 43 of a 43-line document. */
const ITEMS: OutlineItem[] = [
  { level: 1, text: 'One', line: 0, index: 0 },
  { level: 2, text: 'Two', line: 21, index: 1 },
  { level: 2, text: 'Three', line: 42, index: 2 },
]
/** Their content-space tops in the rendered pane. The first sits below the
 *  pane's own top padding — that is what `getHeadingTops` reports, and what
 *  makes "the document's top" and "the first heading" different positions. */
const TOPS = [PADDING, 700, 1300]
const TOTAL_LINES = 43
const RENDERED_RANGE = 1600
const SOURCE_RANGE = 588 // 43 lines at CodeMirror's 14px, in a 400px viewport

/** A 10-line document that opens with a three-line preamble: `# Only` on line
 *  4 and `## Last` on line 7. The preamble is the first heading's own block,
 *  measured from that heading — which is what makes this document different
 *  from one whose line 1 is a heading. */
const PREAMBLE_ITEMS: OutlineItem[] = [
  { level: 1, text: 'Only', line: 3, index: 0 },
  { level: 2, text: 'Last', line: 6, index: 1 },
]
const PREAMBLE_TOPS = [200, 900]

/** The source offset CodeMirror reports for a 1-based line: 14px per line. */
const sourceTopOfLine = (line: number): number => (line - 1) * 14

function geometry(overrides: Partial<PaneGeometry> = {}): PaneGeometry {
  return {
    fromTop: 0,
    fromRange: SOURCE_RANGE,
    toRange: RENDERED_RANGE,
    totalLines: TOTAL_LINES,
    items: ITEMS,
    tops: TOPS,
    sourceTopOfLine,
    ...overrides,
  }
}

/** The inverse mapping's own fixture: the document half of the geometry, with
 *  the ranges fixed the way `planPaneSync` resolves them for that direction. */
function sourceMapping(document: {
  items: OutlineItem[]
  tops: number[] | null
  totalLines: number
}): SourceMapping {
  return {
    ...document,
    renderedRange: RENDERED_RANGE,
    sourceRange: SOURCE_RANGE,
    sourceTopOfLine,
  }
}

describe('renderedTopFor', () => {
  it('keeps the exact top when the document opens with a heading', () => {
    // The regression: the rendered pane's first heading is NOT at 0 — it sits
    // below the pane's 24px top padding — so measuring the first block from
    // that heading is what snapped the pane up by its own padding on the first
    // wheel notch, then slid from there.
    expect(renderedTopFor(1, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)).toBe(0)
  })

  it('has no step at the document top', () => {
    const first = renderedTopFor(2, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)
    const second = renderedTopFor(3, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)
    // One source line of travel is one source line of this block's own scale,
    // from the very first line: no notch between line 1 and line 2.
    expect(first).toBeGreaterThan(0)
    expect(second - first).toBeCloseTo(first, 6)
    // And that step is the block's scale, not the padding above the heading.
    expect(second - first).toBeCloseTo(700 / 21, 6)
  })

  it('carries a line inside the first heading block onto the block it spans', () => {
    // Lines 1..22 span the rendered block from the document's own top to the
    // second heading, so line 15 (14 lines in) is 14/21 of the way across.
    expect(renderedTopFor(15, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)).toBeCloseTo(
      (14 / 21) * 700,
      6,
    )
  })

  it('maps a line below the first heading block onto its own block', () => {
    // Line 32 is 10 lines into the second block, which spans lines 22..43 and
    // rendered offsets 700..1300.
    expect(renderedTopFor(32, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)).toBeCloseTo(
      700 + (10 / 21) * 600,
      6,
    )
  })

  it('leaves a preamble document alone: its first heading anchors its own block', () => {
    // A document that opens with body text has no such problem — the first
    // heading is a real position below the "intro" lines, and the text above it
    // is that heading's preamble. Only a document whose line 1 is a heading
    // gets the first-block origin moved.
    expect(renderedTopFor(1, PREAMBLE_ITEMS, PREAMBLE_TOPS, 10, RENDERED_RANGE)).toBe(0)
    expect(renderedTopFor(2, PREAMBLE_ITEMS, PREAMBLE_TOPS, 10, RENDERED_RANGE)).toBeCloseTo(
      200 / 3,
      6,
    )
    expect(renderedTopFor(4, PREAMBLE_ITEMS, PREAMBLE_TOPS, 10, RENDERED_RANGE)).toBeCloseTo(200, 6)
    // The second heading's block is the last one, so it stretches from that
    // heading onto the pane's end — unchanged by the first-block rule.
    expect(renderedTopFor(7, PREAMBLE_ITEMS, PREAMBLE_TOPS, 10, RENDERED_RANGE)).toBeCloseTo(900, 6)
    expect(renderedTopFor(9, PREAMBLE_ITEMS, PREAMBLE_TOPS, 10, RENDERED_RANGE)).toBeCloseTo(
      900 + (2 / 4) * (RENDERED_RANGE - 900),
      6,
    )
  })

  it('stretches the last block onto the pane end', () => {
    // The document's last line lands on the pane's own end, so a document whose
    // panes are laid out at different heights still lines up when it runs out.
    expect(renderedTopFor(TOTAL_LINES + 1, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)).toBe(
      RENDERED_RANGE,
    )
  })

  it('falls back to the ratio when there are no headings', () => {
    expect(renderedTopFor(22, [], null, 43, RENDERED_RANGE)).toBeCloseTo(
      (21 / 42) * RENDERED_RANGE,
      6,
    )
  })

  it('falls back to the ratio when the offsets and the outline are out of step', () => {
    // A heading mid-render: pairing the parsed outline with the DOM's offsets
    // would anchor on the wrong heading, so the mapping refuses.
    expect(renderedTopFor(22, ITEMS, null, 43, RENDERED_RANGE)).toBeCloseTo(
      (21 / 42) * RENDERED_RANGE,
      6,
    )
  })
})

describe('sourceTopFor', () => {
  it('inverts the first heading block exactly', () => {
    // Forward then back: the inverse has to use the same origin the forward
    // mapping does, or a scroll round trip drifts inside the first block.
    for (const line of [1, 2, 8, 15, 21]) {
      const rendered = renderedTopFor(line, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)
      const back = sourceTopFor(rendered, sourceMapping({ items: ITEMS, tops: TOPS, totalLines: TOTAL_LINES }))
      expect(back, `line ${line}`).toBeCloseTo(sourceTopOfLine(line), 4)
    }
  })

  it('inverts a block below the first one exactly', () => {
    for (const line of [22, 28, 35, 42]) {
      const rendered = renderedTopFor(line, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)
      const back = sourceTopFor(rendered, sourceMapping({ items: ITEMS, tops: TOPS, totalLines: TOTAL_LINES }))
      expect(back, `line ${line}`).toBeCloseTo(sourceTopOfLine(line), 4)
    }
  })

  it('keeps the top of the rendered pane on the source pane’s top', () => {
    expect(
      sourceTopFor(0, sourceMapping({ items: ITEMS, tops: TOPS, totalLines: TOTAL_LINES })),
    ).toBe(0)
  })

  it('keeps the top of a preamble document on the first heading', () => {
    // A rendered offset of 0 is the document's own top, which is the preamble's
    // first line — the block above the heading is measured from 0, not from the
    // heading, so the round trip lands back where it started.
    expect(
      sourceTopFor(0, sourceMapping({ items: PREAMBLE_ITEMS, tops: PREAMBLE_TOPS, totalLines: 10 })),
    ).toBe(0)
    // 60 of the heading's 200px is 0.3 of the way from line 1 to line 4, which
    // is line 1.9 — 12.6px into the source pane.
    expect(
      sourceTopFor(60, sourceMapping({ items: PREAMBLE_ITEMS, tops: PREAMBLE_TOPS, totalLines: 10 })),
    ).toBeCloseTo(0.9 * 14, 4)
  })

  it('inverts the preamble document below its first heading', () => {
    for (const line of [4, 5, 7, 9]) {
      const rendered = renderedTopFor(line, PREAMBLE_ITEMS, PREAMBLE_TOPS, 10, RENDERED_RANGE)
      const back = sourceTopFor(rendered, sourceMapping({ items: PREAMBLE_ITEMS, tops: PREAMBLE_TOPS, totalLines: 10 }))
      expect(back, `line ${line}`).toBeCloseTo(sourceTopOfLine(line), 4)
    }
  })

  it('falls back to the ratio when there are no headings', () => {
    // Half of the rendered pane's range is half of the source pane's range: the
    // fraction belongs to the pane the offset is measured in.
    expect(
      sourceTopFor(RENDERED_RANGE / 2, sourceMapping({ items: [], tops: null, totalLines: 43 })),
    ).toBeCloseTo(SOURCE_RANGE / 2, 6)
  })

  it('falls back to the ratio when the offsets and the outline are out of step', () => {
    // A heading mid-render: pairing the parsed outline with the DOM's offsets
    // would anchor on the wrong heading, so the mapping refuses.
    expect(
      sourceTopFor(RENDERED_RANGE / 2, sourceMapping({ items: ITEMS, tops: null, totalLines: 43 })),
    ).toBeCloseTo(SOURCE_RANGE / 2, 6)
  })
})

describe('planPaneSync', () => {
  it('lands the counterpart on the document top from the source pane’s top', () => {
    const plan = planPaneSync('source', geometry({ fromTop: 0 }))
    expect(plan).toEqual({ top: 0, atEdge: true })
  })

  it('lands the counterpart on the document top from the rendered pane’s top', () => {
    const plan = planPaneSync(
      'rendered',
      geometry({ fromTop: 0, fromRange: RENDERED_RANGE, toRange: SOURCE_RANGE }),
    )
    expect(plan).toEqual({ top: 0, atEdge: true })
  })

  it('holds the document top inside an engine quantum of the top', () => {
    // A fractional scroll the engine quantised away is still the document's
    // top, and the write has to be exactly 0 rather than 0.3999: the pane's
    // own scroll event compares the offset it kept with the one written, so a
    // fraction here is an echo that reads back as a scroll the user made.
    expect(planPaneSync('source', geometry({ fromTop: PANE_EDGE_PX * 0.8 }))).toEqual({
      top: 0,
      atEdge: true,
    })
  })

  it('follows the first block’s own scale just past the top', () => {
    // One line down in the source, the rendered pane takes one line of the
    // first block's own scale — the same step it took from the document's top.
    // Before the fix this notch went to the first heading instead, which is a
    // step of PADDING: the discontinuity, not the travel.
    const plan = planPaneSync('source', geometry({ fromTop: sourceTopOfLine(2) }), 2)
    const step = renderedTopFor(2, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE)
    expect(plan.atEdge).toBe(false)
    expect(plan.top).toBeCloseTo(step, 6)
    // The mapping this replaced put the first notch on tops[0] — the first
    // heading, one top-padding below the document's own top.
    expect(plan.top).not.toBeCloseTo(PADDING, 3)
    // And the step from the top is continuous with the next one.
    expect(renderedTopFor(3, ITEMS, TOPS, TOTAL_LINES, RENDERED_RANGE) - step).toBeCloseTo(step, 6)
  })

  it('lands the counterpart on the document end from either pane', () => {
    expect(planPaneSync('source', geometry({ fromTop: SOURCE_RANGE }))).toEqual({
      top: RENDERED_RANGE,
      atEdge: true,
    })
    expect(
      planPaneSync(
        'rendered',
        geometry({ fromTop: RENDERED_RANGE, fromRange: RENDERED_RANGE, toRange: SOURCE_RANGE }),
      ),
    ).toEqual({ top: SOURCE_RANGE, atEdge: true })
  })

  it('treats a pane with nothing to scroll as an edge', () => {
    // A pane whose whole document fits has one position, which is the end of
    // its (empty) range; an ease toward nowhere only adds latency.
    expect(planPaneSync('source', geometry({ fromTop: 0, fromRange: 0 }))).toEqual({
      top: 0,
      atEdge: true,
    })
  })
})
