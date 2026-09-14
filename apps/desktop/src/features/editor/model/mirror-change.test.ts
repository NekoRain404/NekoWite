import { describe, expect, it } from 'vitest'
import { mirrorChange } from './mirror-change'

/** Apply a change the way CodeMirror does, so the tests read as text in/out. */
function apply(before: string, change: ReturnType<typeof mirrorChange>): string {
  if (!change) return before
  return before.slice(0, change.from) + change.insert + before.slice(change.to)
}

describe('mirrorChange', () => {
  it('turns a text edit into one change that only covers the edit', () => {
    const before = '# Note\n\nfirst line\n\nsecond line\n'
    const after = '# Note\n\nfirst line EDITED\n\nsecond line\n'
    const change = mirrorChange(before, after)
    // Only the added word: the shared "first line " is not part of the change.
    expect(change).toEqual({ from: 18, to: 18, insert: ' EDITED' })
    expect(apply(before, change)).toBe(after)
  })

  it('covers an insertion at the very start without swallowing the document', () => {
    const before = 'alpha\nbeta\n'
    const change = mirrorChange(before, 'Xalpha\nbeta\n')
    expect(change).toEqual({ from: 0, to: 0, insert: 'X' })
    // The point of the whole module: the range is the edit, not [0, doc.length].
    expect(change!.to - change!.from).toBe(0)
    expect(apply(before, change)).toBe('Xalpha\nbeta\n')
  })

  it('covers an insertion at the end', () => {
    const before = 'alpha\nbeta\n'
    const change = mirrorChange(before, 'alpha\nbeta\ntail\n')
    expect(change).toEqual({ from: 11, to: 11, insert: 'tail\n' })
    expect(apply(before, change)).toBe('alpha\nbeta\ntail\n')
  })

  it('covers a deletion, including one that empties the document', () => {
    expect(apply('alpha\nbeta\n', mirrorChange('alpha\nbeta\n', 'alpha\n'))).toBe('alpha\n')
    expect(mirrorChange('alpha\nbeta\n', 'alpha\n')).toEqual({ from: 6, to: 11, insert: '' })
    expect(apply('alpha\nbeta\n', mirrorChange('alpha\nbeta\n', ''))).toBe('')
  })

  it('handles a replacement whose two middles differ in length', () => {
    const before = 'one two three four five'
    const after = 'one 2 three 4 five'
    const change = mirrorChange(before, after)
    expect(apply(before, change)).toBe(after)
    // Both edits are inside one range here (the unchanged "three" is not a
    // useful anchor at this size), but never the whole document.
    expect(change!.to - change!.from).toBeLessThan(before.length)
  })

  it('is null only when the texts are equal', () => {
    expect(mirrorChange('same\n', 'same\n')).toBeNull()
    expect(mirrorChange('', '')).toBeNull()
    expect(mirrorChange('', 'x')).toEqual({ from: 0, to: 0, insert: 'x' })
  })

  it('round-trips a CRLF canonicalisation (the whole-file rewrite case)', () => {
    const before = 'a\r\nb\r\nc\r\n'
    const after = 'a\nb\nc\n'
    const change = mirrorChange(before, after)
    expect(apply(before, change)).toBe(after)
  })

  it('keeps a lone surrogate pair whole when it is unchanged', () => {
    const before = 'note 😀 one\nbody\n'
    const after = 'note 😀 two\nbody\n'
    const change = mirrorChange(before, after)
    expect(apply(before, change)).toBe(after)
    // The unchanged emoji is not split: trimming the suffix moved both ends by
    // the same number of code units.
    expect(change!.insert.endsWith('two')).toBe(true)
  })
})
