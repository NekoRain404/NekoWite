import { describe, expect, it } from 'vitest'

import { headingAnchorIds, slugify } from './slugify'

describe('slugify', () => {
  it('slugifies latin words', () => {
    expect(slugify('Hello World')).toBe('hello-world')
    expect(slugify('Getting Started Guide')).toBe('getting-started-guide')
  })

  it('normalises spaces, underscores and repeated hyphens', () => {
    expect(slugify('a  b')).toBe('a-b')
    expect(slugify('a_b_c')).toBe('a-b-c')
    expect(slugify('a--b')).toBe('a-b')
    expect(slugify('  leading and trailing  ')).toBe('leading-and-trailing')
  })

  it('keeps CJK characters (no ASCII downcasing applied)', () => {
    expect(slugify('你好 世界')).toBe('你好-世界')
    expect(slugify('复杂标题 example')).toBe('复杂标题-example')
  })

  it('preserves latin letters and digits, dropping punctuation', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('第1章 引言')).toBe('第1章-引言')
    expect(slugify('C++ 与 Rust')).toBe('c-与-rust')
  })

  it('strips diacritics-safe unicode letters (e.g. accented latin)', () => {
    // Accented letters are \p{L}; they stay (not transliterated) by design.
    expect(slugify('café résumé')).toBe('café-résumé')
  })

  it('falls back to a stable placeholder when nothing remains', () => {
    expect(slugify('!!!')).toBe('section')
    expect(slugify('---')).toBe('section')
    expect(slugify('')).toBe('section')
  })

  it('is safe for URLs and html fragment ids (no spaces or quotes)', () => {
    const out = slugify('a "quoted" / "title" with symbols')
    expect(out).not.toMatch(/[\s"<>]/)
  })
})

describe('headingAnchorIds', () => {
  it('slugs each heading in document order', () => {
    expect(headingAnchorIds(['One', 'Two Three'])).toEqual(['one', 'two-three'])
  })

  it('suffixes a repeated slug so each heading owns a distinct id', () => {
    // Without this the second "Same" shares the first one's id, so the anchor it
    // copies points at the wrong heading.
    expect(headingAnchorIds(['Same', 'Same', 'Same'])).toEqual(['same', 'same-1', 'same-2'])
  })

  it('only suffixes the collisions, not every heading', () => {
    expect(headingAnchorIds(['A', 'B', 'A', 'C', 'A'])).toEqual(['a', 'b', 'a-1', 'c', 'a-2'])
  })

  it('falls back to the placeholder slug for punctuation-only titles', () => {
    expect(headingAnchorIds(['!!!', '???'])).toEqual(['section', 'section-1'])
  })

  it('produces ids that are stable for the same input', () => {
    const texts = ['Same', 'Other', 'Same']
    expect(headingAnchorIds(texts)).toEqual(headingAnchorIds(texts))
  })

  it('documents the slug/index ambiguity it shares with GitHub', () => {
    // A heading literally titled "Same 1" collides with the suffix assigned to
    // a second "Same". Resolution is positional, so both are still addressable
    // in document order — this pins that expectation rather than pretending the
    // collision does not exist.
    expect(headingAnchorIds(['Same', 'Same', 'Same 1'])).toEqual(['same', 'same-1', 'same-1'])
  })

  it('agrees with slugify for a single heading', () => {
    expect(headingAnchorIds(['Hello World'])).toEqual([slugify('Hello World')])
  })

  it('handles an empty list', () => {
    expect(headingAnchorIds([])).toEqual([])
  })
})
