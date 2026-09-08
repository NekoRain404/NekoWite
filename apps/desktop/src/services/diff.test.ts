import { describe, expect, it } from 'vitest'
import { lineDiff, diffStats, DIFF_MAX_LINES } from './diff'

describe('lineDiff', () => {
  it('returns a single unchanged line for identical inputs', () => {
    const diff = lineDiff('a\nb\nc', 'a\nb\nc')
    expect(diff).toEqual([
      { type: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'same', text: 'b', oldLine: 2, newLine: 2 },
      { type: 'same', text: 'c', oldLine: 3, newLine: 3 },
    ])
  })

  it('marks every line as deleted when the new text is empty', () => {
    const diff = lineDiff('a\nb', '')
    expect(diff).toEqual([
      { type: 'del', text: 'a', oldLine: 1, newLine: null },
      { type: 'del', text: 'b', oldLine: 2, newLine: null },
    ])
  })

  it('marks every line as added when the old text is empty', () => {
    const diff = lineDiff('', 'a\nb')
    expect(diff).toEqual([
      { type: 'add', text: 'a', oldLine: null, newLine: 1 },
      { type: 'add', text: 'b', oldLine: null, newLine: 2 },
    ])
  })

  it('handles both empty inputs', () => {
    expect(lineDiff('', '')).toEqual([])
  })

  it('detects an insertion in the middle', () => {
    const diff = lineDiff('a\nb\nc', 'a\nx\ny\nb\nc')
    expect(diff).toEqual([
      { type: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'add', text: 'x', oldLine: null, newLine: 2 },
      { type: 'add', text: 'y', oldLine: null, newLine: 3 },
      { type: 'same', text: 'b', oldLine: 2, newLine: 4 },
      { type: 'same', text: 'c', oldLine: 3, newLine: 5 },
    ])
  })

  it('detects a deletion in the middle', () => {
    const diff = lineDiff('a\nb\nc\nd', 'a\nd')
    expect(diff).toEqual([
      { type: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'del', text: 'b', oldLine: 2, newLine: null },
      { type: 'del', text: 'c', oldLine: 3, newLine: null },
      { type: 'same', text: 'd', oldLine: 4, newLine: 2 },
    ])
  })

  it('detects a replacement as delete + add', () => {
    const diff = lineDiff('a\nb\nc', 'a\nB\nc')
    expect(diff).toEqual([
      { type: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'del', text: 'b', oldLine: 2, newLine: null },
      { type: 'add', text: 'B', oldLine: null, newLine: 2 },
      { type: 'same', text: 'c', oldLine: 3, newLine: 3 },
    ])
  })

  it('ignores a single trailing newline so EOF newline flips are not diffs', () => {
    expect(lineDiff('a\nb', 'a\nb\n')).toEqual([
      { type: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'same', text: 'b', oldLine: 2, newLine: 2 },
    ])
  })

  it('truncates inputs at DIFF_MAX_LINES', () => {
    const a = Array.from({ length: DIFF_MAX_LINES + 50 }, (_, i) => `old-${i}`).join('\n')
    const b = Array.from({ length: DIFF_MAX_LINES + 80 }, (_, i) => `new-${i}`).join('\n')
    const diff = lineDiff(a, b)
    expect(diff).toHaveLength(DIFF_MAX_LINES * 2)
    expect(diff.every((l) => l.type !== 'same')).toBe(true)
    expect(diffStats(diff)).toEqual({ added: DIFF_MAX_LINES, removed: DIFF_MAX_LINES, unchanged: 0 })
  })

  it('does not report additions beyond the line cap', () => {
    const shared = Array.from({ length: DIFF_MAX_LINES }, (_, i) => `line-${i}`)
    const oldText = shared.join('\n')
    const newText = [...shared, 'beyond-cap'].join('\n')
    const diff = lineDiff(oldText, newText)
    expect(diff).toHaveLength(DIFF_MAX_LINES)
    expect(diff.every((l) => l.type === 'same')).toBe(true)
  })
})

describe('diffStats', () => {
  it('counts added / removed / unchanged', () => {
    const diff = lineDiff('a\nb', 'a\nc\nd')
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1, unchanged: 1 })
  })
})