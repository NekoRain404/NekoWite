import { describe, expect, it } from 'vitest'
import { detectDirection, resolveDirection } from './rtl'

describe('detectDirection', () => {
  it('returns ltr for pure English text', () => {
    expect(detectDirection('Hello world, this is an English note.')).toBe('ltr')
  })

  it('returns rtl for pure Arabic text', () => {
    expect(detectDirection('مرحبا بالعالم هذا هو نص عربي')).toBe('rtl')
  })

  it('returns rtl for pure Hebrew text', () => {
    expect(detectDirection('שלום עולם זהו טקסט בעברית')).toBe('rtl')
  })

  it('returns auto for empty text', () => {
    expect(detectDirection('')).toBe('auto')
    expect(detectDirection(null)).toBe('auto')
    expect(detectDirection(undefined)).toBe('auto')
  })

  it('returns auto for whitespace-only text', () => {
    expect(detectDirection('   \n  \t ')).toBe('auto')
  })

  it('returns auto for direction-neutral-only text (numbers/punctuation)', () => {
    expect(detectDirection('12345 !? ... --- 6789')).toBe('auto')
  })

  it('returns rtl when RTL characters dominate a mixed sample', () => {
    expect(detectDirection('مرحبا hello مرحبا بالعالم')).toBe('rtl')
  })

  it('returns ltr when LTR characters dominate a mixed sample', () => {
    expect(detectDirection('hello مرحبا this is mostly English here')).toBe('ltr')
  })

  it('only inspects the leading 300 characters', () => {
    // The first 300 code units are nearly all latin, so the sample reads ltr
    // even though the full string is RTL-dominated once past char 300.
    expect(detectDirection(`${'a'.repeat(200)}${'ب'.repeat(300)}`)).toBe('ltr')
    // A long leading Arabic run still wins within the sample.
    expect(detectDirection(`${'ب'.repeat(300)}hello`)).toBe('rtl')
  })

  it('ignores bidi marks and digits when counting direction', () => {
    // A lone RLM marker is neutral and must not flip a pure-LTR string.
    expect(detectDirection('abc\u200F')).toBe('ltr')
  })
})

describe('resolveDirection', () => {
  it('returns explicit ltr regardless of content', () => {
    expect(resolveDirection('ltr', 'مرحبا بالعالم')).toBe('ltr')
  })

  it('returns explicit rtl regardless of content', () => {
    expect(resolveDirection('rtl', 'hello world')).toBe('rtl')
  })

  it('falls back to detection for auto', () => {
    expect(resolveDirection('auto', 'hello world')).toBe('ltr')
    expect(resolveDirection('auto', 'مرحبا بالعالم')).toBe('rtl')
  })

  it('returns auto for auto on empty content', () => {
    expect(resolveDirection('auto', '')).toBe('auto')
  })
})
