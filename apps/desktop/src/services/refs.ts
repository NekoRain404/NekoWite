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

/** Map a parsed Cite into the app's Reference shape, drawing keys from a shared
 *  `used` set so entries parsed in separate batches keep the same keys they
 *  would have had in one whole-file parse. */
function toReferences(cite: Cite, used: Set<string>): Reference[] {
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
}

/** Parse a whole file, or nothing when the parser rejects it. */
function parseWhole(text: string, format: RefFormat, used: Set<string>): Reference[] {
  try {
    return toReferences(new Cite(text, { forceType: FORCE_TYPE[format] }), used)
  } catch {
    return []
  }
}

/** Entry starts at the beginning of a line: the citation-js parser is
 *  all-or-nothing, so this count is what tells us whether it dropped any.
 *  Macro/comment blocks are not entries and must not be counted. */
const BIB_ENTRY_START_RE = /^\s*@([A-Za-z]+)\s*[{(]/gm
const NON_ENTRY_BLOCKS = new Set(['string', 'preamble', 'comment'])

/** Split a BibTeX file into its top-level `@type{…}` blocks, brace-balanced so
 *  a value containing braces (`title = {A {B} C}`) does not end the block
 *  early. Blocks the parser does not treat as entries (`@string`, `@preamble`,
 *  `@comment`) are returned separately: they must still be prepended to every
 *  salvaged entry or `journal = jname` would come out as the literal macro
 *  name instead of its expansion. */
function splitBibBlocks(text: string): { entries: string[]; macros: string[] } {
  const entries: string[] = []
  const macros: string[] = []
  const re = /@([A-Za-z]+)\s*[{(]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const open = text[m.index + m[0].length - 1]
    const close = open === '{' ? '}' : ')'
    let depth = 1
    let i = m.index + m[0].length
    for (; i < text.length; i++) {
      const ch = text[i]
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === open) depth += 1
      else if (ch === close) depth -= 1
      if (depth === 0) break
    }
    if (depth !== 0) continue // truncated final block: nothing left to salvage from it
    const block = text.slice(m.index, i + 1)
    if (NON_ENTRY_BLOCKS.has(m[1].toLowerCase())) macros.push(block)
    else entries.push(block)
    re.lastIndex = i + 1
  }
  return { entries, macros }
}

/** RIS records end at an `ER  -` line. A file without a terminator still holds
 *  one (partial) record, which is kept as the trailing chunk. */
function splitRisRecords(text: string): string[] {
  const out: string[] = []
  const re = /^ER\s{0,2}-[^\S\n]*\r?\n?/gim
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(start, m.index + m[0].length))
    start = m.index + m[0].length
    re.lastIndex = start
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

/** How many entries the file text structurally contains. */
function expectedEntryCount(text: string, format: RefFormat): number {
  if (format === 'ris') return Math.max(text.match(/^ER\s{0,2}-\s*$/gim)?.length ?? 0, text.trim() ? 1 : 0)
  if (format !== 'bib') return 0
  let n = 0
  BIB_ENTRY_START_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BIB_ENTRY_START_RE.exec(text)) !== null) {
    if (!NON_ENTRY_BLOCKS.has(m[1].toLowerCase())) n += 1
  }
  return n
}

/** Read what the parser can still recover from a file it rejected as a whole.
 *  citation-js parses a `.bib` all-or-nothing, so ONE malformed entry (an empty
 *  cite key, an unclosed brace) used to turn a 200-entry library into zero
 *  entries, with no message anywhere: the panel showed its "put a .bib in the
 *  vault" empty state and every citation rendered as missing. Per-block parsing
 *  keeps the recoverable majority. */
function salvageEntries(text: string, format: RefFormat, used: Set<string>): Reference[] {
  if (format === 'ris') {
    const out: Reference[] = []
    for (const record of splitRisRecords(text)) {
      if (!record.trim()) continue
      out.push(...parseWhole(record, 'ris', used))
    }
    return out
  }
  if (format !== 'bib') return []
  const { entries, macros } = splitBibBlocks(text)
  const out: Reference[] = []
  for (const entry of entries) {
    // Macros first so `journal = jname` expands the way it does in the file.
    out.push(...parseWhole(`${macros.join('\n')}\n${entry}`, 'bib', used))
  }
  return out
}

/** A JSON file is only a CSL-JSON library when it is an ARRAY of items — the
 *  shape every reference manager exports. A vault's `package.json`/`tsconfig.json`
 *  is an object, and citation-js happily turned it into a nameless `ref` entry
 *  that showed up in the library (and in the citation picker) as a real
 *  reference. */
function isCslLibrary(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed)
  } catch {
    return false
  }
}

export interface ParsedRefs {
  refs: Reference[]
  /** Structurally present entries the parser could not recover, so the caller
   *  can say so instead of silently offering a partial library. */
  skipped: number
}

/** An entry with a title or an author is one the user can recognise in the
 *  library. */
function isUsableRef(ref: Reference): boolean {
  return ref.title !== '' || ref.authors.length > 0
}

/** Parse a reference file, salvaging the entries of one that the parser rejects
 *  as a whole. */
export function scanRefs(text: string, format: RefFormat): ParsedRefs {
  if (format === 'csl' && !isCslLibrary(text)) return { refs: [], skipped: 0 }
  const used = new Set<string>()
  const whole = parseWhole(text, format, used)
  // citation-js turns ANY JSON object into an entry. A vault's data files are
  // not a library, and entries with no title and no author are not references
  // anyone can use — so a file that yields nothing usable is not a library.
  if (format === 'csl' && whole.length > 0 && !whole.some(isUsableRef)) {
    return { refs: [], skipped: 0 }
  }
  const expected = expectedEntryCount(text, format)
  if (whole.length >= expected) return { refs: whole, skipped: 0 }
  const salvaged = salvageEntries(text, format, new Set<string>())
  if (salvaged.length > whole.length) {
    return { refs: salvaged, skipped: Math.max(0, expected - salvaged.length) }
  }
  return { refs: whole, skipped: Math.max(0, expected - whole.length) }
}

export function parseRefs(text: string, format: RefFormat): Reference[] {
  return scanRefs(text, format).refs
}
