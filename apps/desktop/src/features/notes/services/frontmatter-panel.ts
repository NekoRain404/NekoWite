/**
 * The frontmatter property panel's editable model: parse the block into fields
 * the panel edits, and serialize those fields back without losing anything the
 * panel does not understand.
 *
 * Parse and serialize live together on purpose. They are not two phases of one
 * pipeline but one contract: `rawSegments` exists only so `serializeFrontmatter`
 * can re-emit text the parser never interpreted, so a change to what the parser
 * keeps is a change to what the serializer can preserve. Splitting them would
 * put that contract in a type imported from both sides — a horizontal chop, not
 * a second concern (§13.3).
 *
 * The lightweight scan (`splitFrontmatterRaw`) is `frontmatter-scan.ts`; this
 * module builds on it rather than re-finding the fences.
 *
 * Pure: no fs, no gateway, no store.
 */

import { splitFrontmatterRaw, stripQuotes } from './frontmatter-scan'

/** One top-level frontmatter key together with the original text of its value.
 * A segment opens on a non-indented `key:` line and takes the indented lines
 * that follow (blank lines inside the value included), so nested mappings,
 * sequences, block scalars and comments travel with their key and are never
 * re-quoted. */
export interface FrontmatterSegment {
  /** Original key text; `''` for keyless text (a comment above the first key,
   * a blank separator line). */
  key: string
  lines: string[]
}

/** Editable fields surfaced by the frontmatter property panel. `other` is a
 * read-only display view of unknown keys; `rawSegments` keeps the block text
 * per segment so serialization can write it back byte-for-byte. */
export interface FrontmatterFields {
  title: string
  tags: string[]
  date: string
  created: string
  updated: string
  other: Record<string, string>
  rawSegments: FrontmatterSegment[]
}

// A top-level key starts at column 0 and is made of letters/digits (Unicode
// included, so `标题:` is recognized) plus `_`/`-`; an indented line never
// matches, so a nested `  title: x` stays inside its parent segment.
const FRONTMATTER_KEY_RE = /^([\p{L}\p{N}_-]+)\s*:\s*(.*)$/u
const KNOWN_FRONTMATTER_KEYS = new Set(['title', 'tags', 'date', 'created', 'updated'])

function isKnownFrontmatterKey(key: string): boolean {
  return KNOWN_FRONTMATTER_KEYS.has(key.toLowerCase())
}

/** Split inner frontmatter text into top-level key segments at the text level,
 * interpreting no values. YAML scopes a top-level key to column 0, so a blank
 * or indented line inside a value continues the segment above; a non-indented
 * line that is not a recognizable key becomes its own keyless segment instead
 * of being guessed as a continuation — otherwise a key this regex cannot
 * express could be swallowed by (and lost with) a known key the panel
 * rewrites. */
function splitFrontmatterSegments(front: string): FrontmatterSegment[] {
  if (front === '') return []
  const segments: FrontmatterSegment[] = []
  let current: FrontmatterSegment | null = null
  // Blank lines are held back: inside a value they continue the key above, but
  // above a new top-level key they belong to the text between keys, so a known
  // key cannot swallow (and drop) them when serialization replaces its text.
  let blanks: string[] = []
  for (const line of front.split(/\r?\n/)) {
    if (line.trim() === '') {
      blanks.push(line)
      continue
    }
    if (/^[ \t]/.test(line)) {
      // Indented: continue the segment above, taking any blank lines that sat
      // inside the value with it.
      if (current === null) {
        current = { key: '', lines: [] }
        segments.push(current)
      }
      current.lines.push(...blanks, line)
      blanks = []
      continue
    }
    if (blanks.length > 0) {
      segments.push({ key: '', lines: blanks })
      blanks = []
    }
    const key = FRONTMATTER_KEY_RE.exec(line)
    current = { key: key ? key[1] : '', lines: [line] }
    segments.push(current)
  }
  if (blanks.length > 0) segments.push({ key: '', lines: blanks })
  return segments
}

/** Tags from a `tags:` segment: inline `[a, b]` / `a, b` on the key line, or
 * the `- item` lines that follow it. */
function parseTagValues(inline: string, lines: string[]): string[] {
  if (inline !== '') {
    const cleaned = inline.replace(/^\[/, '').replace(/\]$/, '')
    return cleaned.split(',').map((p) => stripQuotes(p)).filter(Boolean)
  }
  const tags: string[] = []
  for (const line of lines.slice(1)) {
    const item = /^\s+-\s*(.+?)\s*$/.exec(line)
    if (item) {
      const tag = stripQuotes(item[1])
      if (tag) tags.push(tag)
      continue
    }
    if (line.trim() === '') continue
    break
  }
  return tags
}

/** Parse the inner frontmatter text (between the `---` fences) into the fields
 * the panel edits, a display-only view of every other key, and the raw segments
 * `serializeFrontmatter` re-emits as-is. */
export function parseFrontmatterForPanel(front: string): FrontmatterFields {
  const fields: FrontmatterFields = {
    title: '',
    tags: [],
    date: '',
    created: '',
    updated: '',
    other: {},
    rawSegments: [],
  }
  for (const segment of splitFrontmatterSegments(front)) {
    // Every segment is kept, known keys included: serialization needs the
    // original positions to know which text sat above the first key.
    fields.rawSegments.push(segment)
    if (segment.key === '') continue
    const value = (FRONTMATTER_KEY_RE.exec(segment.lines[0])?.[2] ?? '').trim()
    const lower = segment.key.toLowerCase()
    if (lower === 'title') fields.title = stripQuotes(value)
    else if (lower === 'tags') fields.tags = parseTagValues(value, segment.lines)
    else if (lower === 'date') fields.date = stripQuotes(value)
    else if (lower === 'created') fields.created = stripQuotes(value)
    else if (lower === 'updated') fields.updated = stripQuotes(value)
    else {
      // Display only. The bytes written back always come from rawSegments, so
      // a value this one-line view cannot show (list, mapping, block scalar)
      // is rendered roughly but never stored as a scalar.
      fields.other[segment.key] = stripQuotes(value)
    }
  }
  return fields
}

const LEADING_YAML_SPECIALS = ['`', '-', '?', '&', '*', '!', '|', '>', '%', '@', '[', ']', '{', '}']

/** True when a YAML scalar must be double-quoted to round-trip safely. */
function needsQuote(value: string): boolean {
  if (value === '') return true
  if (/^\s|\s$/.test(value)) return true
  if (value.includes('\n')) return true
  if (value.includes(': ') || value.includes('#') || value.endsWith(':')) return true
  if (value.includes('"') || value.includes("'")) return true
  if (LEADING_YAML_SPECIALS.some((c) => value.startsWith(c))) return true
  return false
}

function quoteScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
  return `"${escaped}"`
}

function yamlScalar(value: string): string {
  return needsQuote(value) ? quoteScalar(value) : value
}

/** Serialize editable fields back to inner frontmatter text (no `---` fences).
 * Known keys are emitted first (title, tags, date, created, updated); every
 * other key then follows as its ORIGINAL text, byte-for-byte and in document
 * order, so values the panel does not understand (sequences, mappings, block
 * scalars, duplicate keys) survive a round trip even when a field is edited. */
export function serializeFrontmatter(fields: FrontmatterFields): string {
  const lines: string[] = []
  const segments = fields.rawSegments ?? []
  // Keyless lines that sat above the first key (a leading comment, a blank
  // line) keep that position, so an untouched block re-serializes unchanged.
  let next = 0
  while (next < segments.length && segments[next].key === '') {
    lines.push(...segments[next].lines)
    next += 1
  }
  if (fields.title !== '') lines.push(`title: ${yamlScalar(fields.title)}`)
  const tags = [...new Set(fields.tags)]
  if (tags.length > 0) {
    lines.push('tags:')
    for (const tag of tags) lines.push(`  - ${yamlScalar(tag)}`)
  }
  if (fields.date !== '') lines.push(`date: ${yamlScalar(fields.date)}`)
  if (fields.created !== '') lines.push(`created: ${yamlScalar(fields.created)}`)
  if (fields.updated !== '') lines.push(`updated: ${yamlScalar(fields.updated)}`)
  const preserved = new Set<string>()
  for (; next < segments.length; next += 1) {
    const segment = segments[next]
    // Known keys were re-emitted above; repeating their original text as well
    // would duplicate them.
    if (segment.key !== '' && isKnownFrontmatterKey(segment.key)) continue
    preserved.add(segment.key)
    lines.push(...segment.lines)
  }
  // Field sets built by hand carry no raw text, so their `other` values still
  // need the scalar path; parsed keys always have a raw segment above.
  for (const [key, value] of Object.entries(fields.other)) {
    if (preserved.has(key)) continue
    lines.push(`${key}: ${yamlScalar(value)}`)
  }
  return lines.join('\n')
}

/** Wrap inner frontmatter text into a full `---…---` block with a trailing
 * blank line, matching editor-core's splitFrontmatter block shape. */
export function frontmatterBlock(inner: string): string {
  const normalized = inner.endsWith('\n') ? inner : `${inner}\n`
  return `---\n${normalized}---\n\n`
}

export function emptyFrontmatterFields(): FrontmatterFields {
  return { title: '', tags: [], date: '', created: '', updated: '', other: {}, rawSegments: [] }
}

/** Rebuild a document's frontmatter block from `fields`, preserving the body
 * byte-for-byte. Adds a fresh frontmatter block when the document has none. */
export function replaceFrontmatter(
  content: string,
  fields: FrontmatterFields,
): { content: string; hadFront: boolean; changed: boolean } {
  const { front, body } = splitFrontmatterRaw(content)
  const hadFront = front !== ''
  const next = frontmatterBlock(serializeFrontmatter(fields)) + body
  return { content: next, hadFront, changed: next !== content }
}
