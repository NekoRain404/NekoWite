import { describe, expect, it } from 'vitest'
import { detectFormat, parseRefs, scanRefs } from './refs'

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

describe('non-ASCII reference data', () => {
  it('keeps accented and CJK author names and titles intact (UTF-8 bibtex)', () => {
    const BIB = `@article{mueller2019,
  title = {Über die Prüfung der Moleküle},
  author = {Müller, Jörg and 张伟 and Ó Súilleabháin, Seán},
  year = {2019},
}`
    const refs = parseRefs(BIB, 'bib')
    expect(refs).toHaveLength(1)
    expect(refs[0]?.title).toContain('Über die Prüfung der Moleküle')
    expect(refs[0]?.authors.join(' | ')).toContain('Jörg Müller')
    expect(refs[0]?.authors.join(' | ')).toContain('张伟')
    expect(refs[0]?.authors.join(' | ')).toContain('Seán Ó Súilleabháin')
  })

  it('reads a CRLF (Windows-exported) bibtex file like an LF one', () => {
    const LF = `@article{smith2020,
  title = {A Great Paper},
  author = {Smith, John},
  year = {2020},
}`
    const crlf = parseRefs(LF.replace(/\n/g, '\r\n'), 'bib')
    expect(crlf.map((r) => r.key)).toEqual(parseRefs(LF, 'bib').map((r) => r.key))
    expect(crlf[0]?.title).toBe('A Great Paper')
    expect(crlf[0]?.authors).toEqual(['John Smith'])
  })
})

describe('scanRefs (a broken entry must not empty the library)', () => {
  it('keeps the good entries of a bibtex file containing one entry with no key', () => {
    const BIB = `@article{good1,
  title = {Good One},
  author = {Smith, John},
  year = {2020},
}

@article{,
  title = {Anonymous Entry},
  author = {Nobody},
}

@article{good2,
  title = {Good Two},
  author = {Doe, Jane},
  year = {2021},
}`
    const out = scanRefs(BIB, 'bib')
    // citation-js rejects the file as a whole, so before the salvage this was
    // `[]` and every citation in the vault rendered as missing.
    expect(out.refs.map((r) => r.key)).toEqual(['good1', 'good2'])
    expect(out.skipped).toBe(1)
  })

  it('keeps the good entries of a bibtex file whose last entry is truncated', () => {
    const BIB = `@article{good1,
  title = {Good One},
  year = {2020},
}

@article{broken,
  title = {Unclosed`
    const out = scanRefs(BIB, 'bib')
    expect(out.refs.map((r) => r.key)).toContain('good1')
  })

  it('expands @string macros in salvaged entries the way the whole-file parse would', () => {
    const BIB = `@string{jtest = {Journal of Testing}}

@article{macro1,
  title = {Macro Paper},
  author = {Smith, John},
  journal = jtest,
  year = {2020},
}

@article{,
  title = {No Key},
}`
    const out = scanRefs(BIB, 'bib')
    expect(out.refs.map((r) => r.key)).toEqual(['macro1'])
    expect(out.refs[0]?.journal).toBe('Journal of Testing')
  })

  it('reports how many entries it could not recover', () => {
    const out = scanRefs('@article{,\n  title = {No Key},\n}', 'bib')
    expect(out).toEqual({ refs: [], skipped: 1 })
  })

  it('still parses a healthy file without reporting anything skipped', () => {
    const out = scanRefs(BIB, 'bib')
    expect(out.refs).toHaveLength(1)
    expect(out.skipped).toBe(0)
  })

  it('keeps every RIS record when one record is malformed', () => {
    const RIS = `TY  - JOUR
AU  - Smith, John
TI  - First
PY  - 2020
ER  -
TY  - JOUR
TI  - Second
PY  - 2021
ER  -`
    const out = scanRefs(RIS, 'ris')
    expect(out.refs).toHaveLength(2)
    expect(out.skipped).toBe(0)
  })
})

describe('non-library JSON files', () => {
  it('does not treat a vault object JSON (package.json) as a CSL library', () => {
    const out = scanRefs('{"name":"myapp","version":"1.0.0"}', 'csl')
    expect(out).toEqual({ refs: [], skipped: 0 })
    expect(parseRefs('{"name":"myapp","version":"1.0.0"}', 'csl')).toEqual([])
  })

  it('does not treat an array of unrelated objects as a CSL library', () => {
    expect(scanRefs('[{"foo":"bar"},{"baz":1}]', 'csl').refs).toEqual([])
  })

  it('still parses a real CSL array', () => {
    const CSL = `[{"id":"doe2019","title":"The JSON Paper","author":[{"family":"Doe","given":"Jane"}]}]`
    const out = scanRefs(CSL, 'csl')
    expect(out.refs.map((r) => r.key)).toEqual(['doe2019'])
    expect(out.skipped).toBe(0)
  })
})

describe('reference file detection', () => {
  it('accepts the uppercase extensions reference managers export', () => {
    // Zotero writes `Library.BIB`; the case-sensitive test hid it entirely.
    expect(detectFormat('Library.BIB')).toBe('bib')
    expect(detectFormat('Refs.RIS')).toBe('ris')
    expect(detectFormat('items.JSON')).toBe('csl')
    expect(detectFormat('library.bib')).toBe('bib')
    expect(detectFormat('notes.md')).toBeNull()
  })
})
