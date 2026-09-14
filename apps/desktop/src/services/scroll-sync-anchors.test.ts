import { describe, expect, it } from 'vitest'
import { parseOutline } from './outline'
import {
  anchorHeadingIndex,
  clampLine,
  clampRatio,
  countDocumentLines,
  headingSourceLine,
  lineRatio,
  nearestHeadingIndex,
} from './scroll-sync-anchors'

describe('countDocumentLines', () => {
  it('returns 1 for empty and single-line content', () => {
    expect(countDocumentLines('')).toBe(1)
    expect(countDocumentLines('hello')).toBe(1)
  })
  it('does not open an empty last line for a trailing break', () => {
    expect(countDocumentLines('a\nb\n')).toBe(2)
    expect(countDocumentLines('a\n')).toBe(1)
    expect(countDocumentLines('a\r\nb')).toBe(2)
  })
})

describe('lineRatio', () => {
  it('returns 0 for degenerate documents', () => {
    expect(lineRatio(1, 1)).toBe(0)
    expect(lineRatio(5, 0)).toBe(0)
  })
  it('maps first/last lines to 0/1', () => {
    expect(lineRatio(1, 3)).toBe(0)
    expect(lineRatio(3, 3)).toBe(1)
    expect(lineRatio(2, 3)).toBe(0.5)
  })
  it('clamps out-of-range lines', () => {
    expect(lineRatio(0, 3)).toBe(0)
    expect(lineRatio(99, 3)).toBe(1)
  })
})

describe('anchorHeadingIndex', () => {
  const md = ['# A', '', 'para A1', '## B', '### C', '# D', 'tail'].join('\n')
  const items = parseOutline(md)

  it('returns null when there are no headings', () => {
    expect(anchorHeadingIndex([], 1)).toBeNull()
  })

  it('anchors body lines to the closest heading at or above', () => {
    expect(anchorHeadingIndex(items, 3)).toBe(0)
    expect(anchorHeadingIndex(items, 7)).toBe(3)
  })

  it('anchors an exact heading line to itself', () => {
    expect(anchorHeadingIndex(items, 1)).toBe(0)
    expect(anchorHeadingIndex(items, 4)).toBe(1)
    expect(anchorHeadingIndex(items, 6)).toBe(3)
  })

  it('clamps to the first heading when the target precedes it', () => {
    expect(anchorHeadingIndex(items, 0)).toBe(0)
    expect(anchorHeadingIndex(items, 2)).toBe(0)
  })

  it('clamps to the last heading past the end', () => {
    expect(anchorHeadingIndex(items, 100)).toBe(3)
  })
})

describe('nearestHeadingIndex', () => {
  const md = ['# A', '', 'para A1', '## B', '### C', '# D', 'tail'].join('\n')
  const items = parseOutline(md)
  // Rendered top offsets of the four headings, in document order.
  const tops = [0, 120, 400, 900]

  it('returns null when there are no headings', () => {
    expect(nearestHeadingIndex([], 0)).toBeNull()
    expect(nearestHeadingIndex([], 640, [])).toBeNull()
  })

  it('returns null when the offsets and outline items disagree in length', () => {
    expect(nearestHeadingIndex(tops, 640, items.slice(0, 2))).toBeNull()
    expect(nearestHeadingIndex([0, 120], 640, items)).toBeNull()
  })

  it('selects the last heading at or before the scroll position', () => {
    expect(nearestHeadingIndex(tops, 0)).toBe(0)
    expect(nearestHeadingIndex(tops, 119)).toBe(0)
    expect(nearestHeadingIndex(tops, 120)).toBe(1)
    expect(nearestHeadingIndex(tops, 399)).toBe(1)
    expect(nearestHeadingIndex(tops, 400)).toBe(2)
    expect(nearestHeadingIndex(tops, 5000)).toBe(3)
  })

  it('clamps to the first heading when scrolled above it', () => {
    expect(nearestHeadingIndex([80, 200], -40)).toBe(0)
    expect(nearestHeadingIndex([80, 200], NaN)).toBe(0)
  })

  it('accepts matching outline items without changing the result', () => {
    expect(nearestHeadingIndex(tops, 640, items)).toBe(2)
  })
})

describe('headingSourceLine', () => {
  const md = ['# A', '', 'para A1', '## B', '### C', '# D', 'tail'].join('\n')
  const items = parseOutline(md)

  it('returns null when there are no headings', () => {
    expect(headingSourceLine([], 0)).toBeNull()
  })

  it('converts a heading index to its 1-based source line', () => {
    expect(headingSourceLine(items, 0)).toBe(1)
    expect(headingSourceLine(items, 1)).toBe(4)
    expect(headingSourceLine(items, 2)).toBe(5)
    expect(headingSourceLine(items, 3)).toBe(6)
  })

  it('clamps an out-of-range index onto the first or last heading', () => {
    expect(headingSourceLine(items, -7)).toBe(1)
    expect(headingSourceLine(items, 99)).toBe(6)
    expect(headingSourceLine(items, NaN)).toBe(1)
  })

  it('floors a fractional index', () => {
    expect(headingSourceLine(items, 1.8)).toBe(4)
  })

  it('never returns a line below 1', () => {
    const malformed = [{ level: 1, text: 'x', line: -4, index: 0 }]
    expect(headingSourceLine(malformed, 0)).toBe(1)
  })
})

describe('clampLine', () => {
  it('clamps a line into the document range', () => {
    expect(clampLine(5, 10)).toBe(5)
    expect(clampLine(0, 10)).toBe(1)
    expect(clampLine(-3, 10)).toBe(1)
    expect(clampLine(11, 10)).toBe(10)
    expect(clampLine(2.7, 10)).toBe(2)
  })

  it('keeps degenerate documents on line 1', () => {
    expect(clampLine(9, 1)).toBe(1)
    expect(clampLine(9, 0)).toBe(1)
    expect(clampLine(9, -4)).toBe(1)
    expect(clampLine(NaN, 10)).toBe(1)
  })

  it('leaves the ratio at 0 when a degenerate document is clamped', () => {
    expect(lineRatio(clampLine(7, 1), 1)).toBe(0)
  })
})

describe('clampRatio', () => {
  it('clamps a ratio into [0, 1]', () => {
    expect(clampRatio(0)).toBe(0)
    expect(clampRatio(0.25)).toBe(0.25)
    expect(clampRatio(1)).toBe(1)
    expect(clampRatio(-0.4)).toBe(0)
    expect(clampRatio(2.5)).toBe(1)
    expect(clampRatio(Infinity)).toBe(1)
    expect(clampRatio(-Infinity)).toBe(0)
  })

  it('treats a non-numeric ratio as 0', () => {
    expect(clampRatio(NaN)).toBe(0)
  })
})
