import { describe, expect, it } from 'vitest'
import {
  findMisspelled,
  findMisspelledRanges,
  isMisspelled,
  suggestions,
  tokenize,
} from './spellcheck'

describe('tokenize', () => {
  it('splits words and keeps offsets', () => {
    expect(tokenize('hello world foo')).toEqual([
      { word: 'hello', offset: 0 },
      { word: 'world', offset: 6 },
      { word: 'foo', offset: 12 },
    ])
  })

  it('only recognizes plain ASCII letters', () => {
    expect(tokenize('你好 world, test123!')).toEqual([
      { word: 'world', offset: 3 },
      { word: 'test', offset: 10 },
    ])
    expect(tokenize('123 abc-def')).toEqual([
      { word: 'abc', offset: 4 },
      { word: 'def', offset: 8 },
    ])
  })

  it('handles contractions via stem tokens', () => {
    const tokens = tokenize("doesn't work")
    expect(tokens[0].word).toBe('doesn')
    expect(tokens[1].word).toBe('t')
    expect(tokens[2].word).toBe('work')
  })
})

describe('isMisspelled', () => {
  it('accepts dictionary words', () => {
    expect(isMisspelled('hello')).toBe(false)
    expect(isMisspelled('world')).toBe(false)
    expect(isMisspelled('writing')).toBe(false)
  })

  it('flags unknown lowercase words', () => {
    expect(isMisspelled('helo')).toBe(true)
    expect(isMisspelled('wrld')).toBe(true)
    expect(isMisspelled('recieve')).toBe(true)
  })

  it('skips proper nouns / capitalized words', () => {
    expect(isMisspelled('Helo')).toBe(false)
    expect(isMisspelled('London')).toBe(false)
  })

  it('skips acronyms and mixed case', () => {
    expect(isMisspelled('HTML')).toBe(false)
    expect(isMisspelled('iPhone')).toBe(false)
    expect(isMisspelled('AI')).toBe(false)
  })

  it('skips very short tokens', () => {
    expect(isMisspelled('q')).toBe(false)
    expect(isMisspelled('zz')).toBe(false)
  })

  it('rejects non-letter tokens', () => {
    expect(isMisspelled('test123')).toBe(false)
    expect(isMisspelled('foo-bar')).toBe(false)
  })
})

describe('findMisspelled', () => {
  it('reports misspelled words with offsets', () => {
    const result = findMisspelled('This is a test with helo wrld')
    expect(result).toEqual([
      { word: 'helo', offset: 20 },
      { word: 'wrld', offset: 25 },
    ])
  })

  it('does not flag a clean paragraph', () => {
    expect(findMisspelled('The quick brown fox jumps over the lazy dog.')).toEqual([])
  })

  it('skips capitalized proper nouns inside text', () => {
    expect(findMisspelled('Alice went to the store.')).toEqual([])
  })
})

describe('findMisspelledRanges', () => {
  it('maps token offsets to absolute ranges', () => {
    const ranges = findMisspelledRanges([{ text: 'good helo', base: 10 }])
    expect(ranges).toEqual([{ word: 'helo', from: 15, to: 19 }])
  })

  it('handles multiple fragments', () => {
    const ranges = findMisspelledRanges([
      { text: 'foo bar', base: 0 },
      { text: 'baz qux', base: 8 },
    ])
    expect(ranges.map((r) => r.word)).toEqual(['foo', 'bar', 'baz', 'qux'])
  })
})

describe('suggestions', () => {
  it('offers near neighbours by edit distance', () => {
    const result = suggestions('helo')
    expect(result).toContain('hello')
  })

  it('returns the word itself when already in the dictionary', () => {
    expect(suggestions('hello')).toContain('hello')
  })

  it('finds transposition neighbours', () => {
    const result = suggestions('recieve')
    expect(result).toContain('receive')
  })

  it('limits the result count', () => {
    expect(suggestions('helo', 1).length).toBe(1)
    expect(suggestions('helo', 5).length).toBeLessThanOrEqual(5)
  })
})
