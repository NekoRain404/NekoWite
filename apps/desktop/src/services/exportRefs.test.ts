import { describe, expect, it } from 'vitest'
import { toExportRefs } from './exportRefs'
import type { Reference } from './refs'

const reference = (over: Partial<Reference> = {}): Reference => ({
  key: 'smith2020',
  title: 'A paper',
  authors: ['Smith', 'Jones'],
  year: '2020',
  type: 'article',
  doi: '10.1000/xyz',
  journal: 'Journal',
  volume: '1',
  issue: '2',
  pages: '3-4',
  publisher: 'Press',
  url: 'https://x.dev',
  ...over,
})

describe('toExportRefs', () => {
  it('keys the map by the citation key, so a cited `[@key]` resolves', () => {
    const map = toExportRefs([reference(), reference({ key: 'doe2021', title: 'Another' })])
    expect([...map.keys()]).toEqual(['smith2020', 'doe2021'])
    expect(map.get('doe2021')?.title).toBe('Another')
  })

  it('carries the citation fields the renderer needs', () => {
    const map = toExportRefs([reference()])
    expect(map.get('smith2020')).toEqual({
      key: 'smith2020',
      title: 'A paper',
      authors: ['Smith', 'Jones'],
      year: '2020',
      doi: '10.1000/xyz',
      journal: 'Journal',
      volume: '1',
      issue: '2',
      pages: '3-4',
      publisher: 'Press',
      url: 'https://x.dev',
    })
    // `Reference` is the app's own bookkeeping, not the exporter's shape: a
    // field the renderer does not know must not travel into the export.
    expect(map.get('smith2020')).not.toHaveProperty('type')
  })

  it('accepts the store map directly, and returns an empty map for an empty library', () => {
    expect(toExportRefs(new Map<string, Reference>().values()).size).toBe(0)
  })
})
