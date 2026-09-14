import { describe, expect, it } from 'vitest'
import { roundTrip } from './serialize'

describe('roundTrip', () => {
  it('preserves headings, emphasis, lists', () => {
    const md = '# Title\n\nSome **bold** and *italic*.\n\n- a\n- b\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves gfm tables', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('reads a table whose delimiter row starts with a lone hyphen as a table', () => {
    // `- | -` at the start of a line is also a bullet-list marker, and micromark
    // hands the line to the list before the table resolver sees it, so the note
    // came back as a paragraph plus a list with its pipes escaped. The same row
    // written `-- | --`, or with a leading pipe, is a table — a one-character
    // difference must not decide whether the user keeps their table.
    expect(roundTrip('a | b\n- | -\n1 | 2\n')).toBe('| a | b |\n| - | - |\n| 1 | 2 |\n')
    expect(roundTrip('a | b |\n- | - |\n1 | 2 |\n')).toBe('| a | b |\n| - | - |\n| 1 | 2 |\n')
  })
  it('reads the same row inside a container as a table', () => {
    expect(roundTrip('> a | b\n> - | -\n> 1 | 2\n')).toBe('> | a | b |\n> | - | - |\n> | 1 | 2 |\n')
  })
  it('leaves a list that is not a delimiter row alone', () => {
    // No header row above it: nothing to be a table of, so the list stands.
    expect(roundTrip('text\n- | -\n')).toBe('text\n\n- \\| -\n')
  })
  it('leaves a row whose cell count does not match the header alone', () => {
    // GFM wants the delimiter row to match the header row cell for cell; the
    // repair only fires when it does, so a deliberate list is not turned into a
    // table on a guess.
    expect(roundTrip('a | b | c\n- | -\n1 | 2\n')).toBe('a | b | c\n\n- \\| -\n  1 | 2\n')
  })
  it('leaves `- | -` inside a fenced code block alone', () => {
    const md = '```\na | b\n- | -\n1 | 2\n```\n'
    expect(roundTrip(md)).toBe(md)
  })
  // Pinned canonicalization: remark-stringify escapes a lone `$` in prose as its
  // Markdown literal form `\$` so the `$` is not misread as math delimiters. This
  // is intended (not a regression) and kept for v1.1; math delimiters themselves
  // still round-trip byte-for-byte below. trailing `\n` is stringify's canonical EOF.
  it('escapes a lone $ in prose to its Markdown literal form \\$ (intended canonicalization)', () => {
    const cases: [string, string][] = [
      ['Cost is $5.', 'Cost is \\$5.\n'],
      ['Price: $19.99.', 'Price: \\$19.99.\n'],
      ['Use $ for currency', 'Use \\$ for currency\n'],
      ['$a$b$', '$a$b\\$\n'],
    ]
    for (const [md, expected] of cases) {
      expect(roundTrip(md)).toBe(expected)
    }
  })
  it('keeps math delimiters byte-faithful through a round trip', () => {
    const md = '$E=mc^2$'
    const expected = '$E=mc^2$\n'
    expect(roundTrip(md)).toBe(expected)
  })
  it('preserves yaml frontmatter', () => {
    const md = '---\ntitle: hello\n---\n\n# Body\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves intentional bracket escapes', () => {
    // handlers.text only un-escapes `\[@` (the citation case). A user's
    // intentional `\[bracket` keeps its backslash, so escaped text can no
    // longer be corrupted into a live link on save. remark-stringify escapes
    // a plain `[` on output; that form is stable on re-save.
    expect(roundTrip('literal \\[bracket\\] here.\n')).toBe('literal \\[bracket] here.\n')
    expect(roundTrip(roundTrip('literal \\[bracket\\] here.\n'))).toBe('literal \\[bracket] here.\n')
  })

  it('still un-escapes the citation form', () => {
    expect(roundTrip('literal \\[@foo] here.\n')).toBe('literal [@foo] here.\n')
  })

  it('documents the residual round-trip of an escaped cite', () => {
    // The editor keeps `\[@foo]` literal (see cite/remark.ts); on this serialize
    // round trip handlers.text may still drop the now-literal backslash, so the
    // escaped form degrades to a plain `[@foo]` (which reopens as a real cite).
    expect(roundTrip('literal \\[@foo] here.\n')).toBe('literal [@foo] here.\n')
  })
})
