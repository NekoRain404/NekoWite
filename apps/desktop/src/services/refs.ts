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
        key: String(entry.id ?? entry.key ?? ''),
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
