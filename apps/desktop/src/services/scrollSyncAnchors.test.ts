import { describe, expect, it } from 'vitest'
import { parseOutline } from './outline'
import { anchorHeadingIndex, countDocumentLines, lineRatio } from './scrollSyncAnchors'

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
