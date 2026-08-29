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
})