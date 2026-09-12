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
  doi?: string
  journal?: string
  volume?: string
  issue?: string
  pages?: string
  publisher?: string
  url?: string
}

const FORCE_TYPE: Record<RefFormat, string> = {
  bib: '@bibtex/text',
  ris: '@ris/file',
  csl: '@else/json',
}

export function detectFormat(filename: string): RefFormat | null {
  // Lowercased first: reference managers export `Library.BIB` and `Refs.RIS`
  // routinely, and a case-sensitive suffix test made those files invisible — the
  // panel showed every citation as missing and the export printed bare keys,
  // while the user believed their library was loaded. Everything else in the app
  // that matches an extension is already case-insensitive (`/\.(md|mdx)$/i`).
  const name = filename.toLowerCase()
  if (name.endsWith('.bib')) return 'bib'
  if (name.endsWith('.ris')) return 'ris'
  if (name.endsWith('.json')) return 'csl'
  return null
}

function authorName(a: { family?: string; given?: string } | string | undefined): string {
  if (typeof a === 'string') return a
  if (!a) return ''
  return [a.given, a.family].filter(Boolean).join(' ')
}

// citation-js normalizes every input format to CSL-JSON, so a single safe
// "text" accessor handles both plain strings and CSL string-arrays across
// bibtex / ris / json inputs.
function textField(entry: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = entry[key]
    if (value == null) continue
    const str = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string').join(', ')
      : String(value)
    const trimmed = str.trim()
    if (trimmed) return trimmed
  }
  return ''
}

const STOPWORDS = new Set(['the', 'a', 'an'])

function firstFamily(a: unknown): string {
  if (typeof a === 'string') return a.split(',')[0]?.trim() ?? ''
  if (a && typeof a === 'object' && 'family' in a && typeof a.family === 'string') {
    return a.family
  }
  return ''
}

// Keep Unicode letters/numbers (CJK included) so non-ASCII content survives slugging.
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function contentDigest(entry: Record<string, unknown>): string {
  const author = Array.isArray(entry.author)
    ? entry.author.map(authorName).join('|')
    : String(entry.author ?? '')
  return `${author}||${String(entry.title ?? '')}||${String(entry.year ?? '')}`
}

function hash36(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

// Returns a key unique within `used`, appending a deterministic content-derived
// disambiguator when the base slug is empty or already taken, so two distinct
// entries never collapse to the same key.
function uniqueKey(base: string, entry: Record<string, unknown>, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const digest = hash36(contentDigest(entry))
  let key = `${base}-${digest}`
  let n = 2
  while (used.has(key)) {
    key = `${base}-${digest}-${n}`
    n++
  }
  used.add(key)
  return key
}

function stableKey(entry: Record<string, unknown>, used: Set<string>): string {
  const id = entry.id ?? entry.key
  if (typeof id === 'string' && id && !id.startsWith('temp_id_')) {
    return uniqueKey(id, entry, used)
  }
  const author = Array.isArray(entry.author) ? entry.author[0] : entry.author
  const family = firstFamily(author)
  const year = String(
    (entry.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]?.[0] ??
      String(entry.year ?? ''),
  )
  const titleWords = String(entry.title ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const titleWord = titleWords.find((w) => !STOPWORDS.has(w)) ?? titleWords[0] ?? ''
  const base = slugify(`${family}${year}${titleWord}`).slice(0, 30) || 'ref'
  return uniqueKey(base, entry, used)
}

export function parseRefs(text: string, format: RefFormat): Reference[] {
  try {
    const cite = new Cite(text, { forceType: FORCE_TYPE[format] })
    const used = new Set<string>()
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
        key: stableKey(entry, used),
        title: String(entry.title ?? ''),
        authors,
        year: String(year),
        type: String(entry.type ?? ''),
        doi: textField(entry, 'DOI') || undefined,
        journal: textField(entry, 'container-title', 'journal', 'containerTitle') || undefined,
        volume: textField(entry, 'volume') || undefined,
        issue: textField(entry, 'issue', 'number') || undefined,
        pages: textField(entry, 'page') || undefined,
        publisher: textField(entry, 'publisher') || undefined,
        url: textField(entry, 'URL') || undefined,
      }
    })
  } catch {
    return []
  }
}
