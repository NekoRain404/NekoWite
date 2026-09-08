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

  it('extracts metadata fields from bibtex (journal/volume/issue/pages/doi/publisher/url)', () => {
    const BIB = `@article{smith2020,
  title = {A Great Paper},
  author = {Smith, John},
  journal = {Journal of Testing},
  volume = {12},
  number = {3},
  pages = {45--67},
  year = {2020},
  doi = {10.1000/abc},
  publisher = {Foo Press},
  url = {https://example.com/paper},
}`
    const r = parseRefs(BIB, 'bib')[0]
    expect(r.journal).toBe('Journal of Testing')
    expect(r.volume).toBe('12')
    expect(r.issue).toBe('3')
    expect(r.pages).toBe('45-67')
    expect(r.doi).toBe('10.1000/abc')
    expect(r.publisher).toBe('Foo Press')
    expect(r.url).toBe('https://example.com/paper')
  })

  it('extracts metadata fields from RIS (JO/VL/IS/SP-EP/DO/UR)', () => {
    const RIS = `TY  - JOUR
AU  - Smith, John
TI  - A RIS Paper
JO  - Journal of RIS
VL  - 5
IS  - 2
SP  - 10
EP  - 20
PY  - 2021
DO  - 10.2000/ris
UR  - https://example.com/ris
ER  -`
    const r = parseRefs(RIS, 'ris')[0]
    expect(r.journal).toBe('Journal of RIS')
    expect(r.volume).toBe('5')
    expect(r.issue).toBe('2')
    expect(r.pages).toBe('10-20')
    expect(r.doi).toBe('10.2000/ris')
    expect(r.url).toBe('https://example.com/ris')
  })

  it('extracts metadata fields from CSL JSON (container-title/volume/issue/page/DOI/publisher/URL)', () => {
    const CSL = `[{
      "id": "doe2019",
      "title": "The JSON Paper",
      "author": [{ "family": "Doe", "given": "Jane" }],
      "issued": { "date-parts": [[2019]] },
      "type": "article-journal",
      "container-title": "Journal of JSON",
      "volume": "9",
      "issue": "1",
      "page": "100-110",
      "DOI": "10.3000/json",
      "publisher": "Baz Press",
      "URL": "https://example.com/json"
    }]`
    const r = parseRefs(CSL, 'csl')[0]
    expect(r.journal).toBe('Journal of JSON')
    expect(r.volume).toBe('9')
    expect(r.issue).toBe('1')
    expect(r.pages).toBe('100-110')
    expect(r.doi).toBe('10.3000/json')
    expect(r.publisher).toBe('Baz Press')
    expect(r.url).toBe('https://example.com/json')
  })

  it('returns empty array for unparseable content', () => {
    expect(parseRefs('this is not a reference format', 'bib')).toEqual([])
    expect(parseRefs('', 'ris')).toEqual([])
  })

  it('derives a stable slug key for RIS entries (not a temp id)', () => {
    const RIS = `TY  - JOUR
AU  - Smith, John
AU  - Doe, Jane
TI  - The Great Paper on Neural Nets
PY  - 2021
ER  -`
    const a = parseRefs(RIS, 'ris')
    const b = parseRefs(RIS, 'ris')
    expect(a.length).toBe(1)
    const key = a[0].key
    expect(key).not.toMatch(/^temp_id_/)
    expect(b[0].key).toBe(key)
    expect(key).toMatch(/^smith/)
    expect(key).toMatch(/2021/)
  })

  it('prefers a stable citation-js id over the derived slug', () => {
    const BIB = `@article{smith2020,
  title = {A Great Paper},
  author = {Smith, John},
  year = {2020},
}`
    const refs = parseRefs(BIB, 'bib')
    expect(refs[0].key).toBe('smith2020')
  })

  it('falls back to a generic slug when the entry has no stable fields', () => {
    const EMPTY = `TY  - JOUR
ER  -`
    const a = parseRefs(EMPTY, 'ris')
    const b = parseRefs(EMPTY, 'ris')
    expect(a.length).toBe(1)
    expect(a[0].key).not.toBe('')
    expect(a[0].key).toBe(b[0].key)
  })

  it('keeps CJK characters in the slug so Chinese RIS refs get distinct keys per year', () => {
    const RIS = `TY  - JOUR
AU  - 张伟
TI  - 关于神经网络的研究
PY  - 2021
ER  -
TY  - JOUR
AU  - 王芳
TI  - 深度学习综述
PY  - 2021
ER  -`
    const a = parseRefs(RIS, 'ris')
    const b = parseRefs(RIS, 'ris')
    expect(a.length).toBe(2)
    expect(a[0].key).not.toBe(a[1].key)
    expect(b[0].key).toBe(a[0].key)
    expect(b[1].key).toBe(a[1].key)
    expect(a[0].key).not.toBe('2021')
    expect(a[1].key).not.toBe('2021')
    expect(a[0].key).toContain('2021')
    expect(a[1].key).toContain('2021')
  })

  it('disambiguates colliding base slugs deterministically so distinct entries never share a key', () => {
    const RIS = `TY  - JOUR
AU  - Smith, John
TI  - The Study of Neural Networks
PY  - 2021
ER  -
TY  - JOUR
AU  - Smith, John
TI  - The Study of Deep Learning
PY  - 2021
ER  -`
    const a = parseRefs(RIS, 'ris')
    const b = parseRefs(RIS, 'ris')
    expect(a.length).toBe(2)
    expect(a[0].key).not.toBe(a[1].key)
    expect(b[0].key).toBe(a[0].key)
    expect(b[1].key).toBe(a[1].key)
  })
})
