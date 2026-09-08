import { describe, expect, it } from 'vitest'

import { slugify } from './slugify'

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
