import { Cite } from '@citation-js/core'
import '@citation-js/plugin-bibtex'
import '@citation-js/plugin-ris'
import '@citation-js/plugin-csl'

export type RefFormat = 'bib' | 'ris' | 'csl'

export interface Reference {
  key: string
  title: string
  authors: string[]
  year: string
  type: string
}

const FORCE_TYPE: Record<RefFormat, string> = {
  bib: '@bibtex/text',
  ris: '@ris/file',
  csl: '@else/json',
}

export function detectFormat(filename: string): RefFormat | null {
  if (filename.endsWith('.bib')) return 'bib'
  if (filename.endsWith('.ris')) return 'ris'
  if (filename.endsWith('.json')) return 'csl'
  return null
}

function authorName(a: { family?: string; given?: string } | string | undefined): string {
  if (typeof a === 'string') return a
  if (!a) return ''
  return [a.given, a.family].filter(Boolean).join(' ')
}

const STOPWORDS = new Set(['the', 'a', 'an'])

function firstFamily(a: unknown): string {
  if (typeof a === 'string') return a.split(',')[0]?.trim() ?? ''
  if (a && typeof a === 'object' && 'family' in a && typeof a.family === 'string') {
    return a.family
  }
  return ''
}

function stableKey(entry: Record<string, unknown>): string {
  const id = entry.id ?? entry.key
  if (typeof id === 'string' && id && !id.startsWith('temp_id_')) {
    return id
  }
  const author = Array.isArray(entry.author) ? entry.author[0] : entry.author
  const family = firstFamily(author)
  const year = String(
    (entry.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]?.[0] ??
      String(entry.year ?? ''),
  )
  const titleWords = String(entry.title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const titleWord = titleWords.find((w) => !STOPWORDS.has(w)) ?? titleWords[0] ?? ''
  const slug = `${family}${year}${titleWord}`.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return slug.slice(0, 30) || 'ref'
}

export function parseRefs(text: string, format: RefFormat): Reference[] {
  try {
    const cite = new Cite(text, { forceType: FORCE_TYPE[format] })
    return cite.data.map((entry: Record<string, unknown>) => {
      const authors = Array.isArray(entry.author)
        ? entry.author.map(authorName)
        : typeof entry.author === 'string'
          ? [entry.author]
          : []
      const year =
        (entry.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]?.[0] ??
        String(entry.year ?? '')
      return {
        key: stableKey(entry),
        title: String(entry.title ?? ''),
        authors,
        year: String(year),
        type: String(entry.type ?? ''),
      }
    })
  } catch {
    return []
  }
}
