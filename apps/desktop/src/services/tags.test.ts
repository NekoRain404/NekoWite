import { describe, expect, it } from 'vitest'
import { mergeTags, normalizeTag, normalizeTags, removeTagFromContent, removeTags } from './tags'

describe('normalizeTag / normalizeTags', () => {
  it('strips # prefixes, trims whitespace and collapses inner runs', () => {
    expect(normalizeTag('  #Math  ')).toBe('Math')
    expect(normalizeTag('##图  论')).toBe('图 论')
    expect(normalizeTag('  ')).toBe('')
  })
  it('dedupes and drops empties while preserving first-occurrence order', () => {
    expect(normalizeTags(['#a', ' a ', '', 'b', 'a', null, undefined])).toEqual(['a', 'b'])
  })
})

describe('mergeTags / removeTags', () => {
  it('unions two lists after normalization', () => {
    expect(mergeTags(['a', 'b'], ['b', '#c'])).toEqual(['a', 'b', 'c'])
  })
  it('removes tags by normalized form', () => {
    expect(removeTags(['a', 'b', 'c'], ['b', ' #c '])).toEqual(['a'])
    expect(removeTags(['a'], ['x'])).toEqual(['a'])
  })
})

describe('removeTagFromContent', () => {
  it('removes a tag from the frontmatter array and preserves the body', () => {
    const md = '---\ntitle: t\ntags:\n  - a\n  - b\n---\n\n# Body'
    expect(removeTagFromContent(md, 'a')).toBe('---\ntitle: t\ntags:\n  - b\n---\n\n# Body')
  })
  it('removes a tag from an inline list', () => {
    const md = '---\ntags: [a, b]\n---\n\nBody'
    expect(removeTagFromContent(md, 'a')).toBe('---\ntags:\n  - b\n---\n\nBody')
  })
  it('returns content unchanged when the tag is absent or there is no frontmatter', () => {
    const md = '---\ntags: [a]\n---\n\nBody'
    expect(removeTagFromContent(md, 'zzz')).toBe(md)
    expect(removeTagFromContent('# no frontmatter', 'a')).toBe('# no frontmatter')
  })
})
