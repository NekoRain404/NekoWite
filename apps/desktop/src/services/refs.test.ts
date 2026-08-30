import { describe, expect, it } from 'vitest'
import { detectFormat, parseRefs } from './refs'

const BIB = `@article{smith2020,
  title = {A Great Paper},
  author = {Smith, John and Doe, Jane},
  year = {2020},
}`

describe('detectFormat', () => {
  it('detects by extension', () => {
    expect(detectFormat('refs.bib')).toBe('bib')
    expect(detectFormat('refs.ris')).toBe('ris')
    expect(detectFormat('refs.json')).toBe('csl')
    expect(detectFormat('notes.md')).toBeNull()
  })
})

describe('parseRefs', () => {
  it('parses bibtex into Reference', () => {
    const refs = parseRefs(BIB, 'bib')
    expect(refs.length).toBeGreaterThan(0)
    const r = refs[0]
    expect(r.key).toBe('smith2020')
    expect(r.title).toContain('Great Paper')
    expect(r.authors).toContain('John Smith')
    expect(r.year).toBe('2020')
  })

  it('parses CSL json into Reference', () => {
    const CSL = `[{
      "id": "doe2019",
      "title": "The JSON Paper",
      "author": [{ "family": "Doe", "given": "Jane" }],
      "issued": { "date-parts": [[2019]] },
      "type": "article-journal"
    }]`
    const refs = parseRefs(CSL, 'csl')
    expect(refs.length).toBe(1)
    const r = refs[0]
    expect(r.key).toBe('doe2019')
    expect(r.title).toBe('The JSON Paper')
    expect(r.authors).toContain('Jane Doe')
    expect(r.year).toBe('2019')
  })

  it('parses raw author strings regardless of shape', () => {
    const CSL = `[{ "id": "raw1", "title": "Raw Author", "author": "Doe, Jane", "type": "article" }]`
    const refs = parseRefs(CSL, 'csl')
    expect(refs.length).toBe(1)
    expect(refs[0].authors).toContain('Doe, Jane')
  })

  it('returns empty array for unparseable content', () => {
    expect(parseRefs('this is not a reference format', 'bib')).toEqual([])
    expect(parseRefs('', 'ris')).toEqual([])
  })
})
