import { t } from '../i18n'

export interface NoteSummary {
  path: string
  name: string
  title: string
  tags: string[]
  summary: string
  mtime: number
  size: number
  dir: string
  links: string[]
}

export type LibraryFilter = 'all' | 'recent' | 'favorites' | 'uncategorized' | `tag:${string}`
export type SortBy = 'mtime' | 'title' | 'name'

export interface LibraryCounts {
  all: number
  recent: number
  favorites: number
  uncategorized: number
}

export interface MdLink {
  text: string
  target: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---((?:\r?\n)+|$)/
const SNAPSHOT_CHARS = 400
const SUMMARY_CHARS = 120

export function splitFrontmatterRaw(md: string): { front: string; body: string } {
  const match = FRONTMATTER_RE.exec(md)
  if (!match) return { front: '', body: md }
  return { front: match[1] ?? '', body: md.slice(match[0].length) }
}

function stripQuotes(value: string): string {
  const t = value.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** Lightweight frontmatter scan: `title:` string plus `tags:` as a YAML block
 * array, an inline `[a, b]` list, or a comma-separated value. */
export function parseFrontmatterBlock(front: string): { title: string; tags: string[] } {
  let title = ''
  let tags: string[] = []
  let collectingTags = false
  for (const line of front.split(/\r?\n/)) {
    if (collectingTags) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line)
      if (item) {
        const tag = stripQuotes(item[1])
        if (tag) tags.push(tag)
        continue
      }
      if (line.trim() === '') continue
      collectingTags = false
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    const value = pair[2].trim()
    if (key === 'title') {
      title = stripQuotes(value)
      collectingTags = false
    } else if (key === 'tags') {
      tags = []
      if (value === '') {
        collectingTags = true
      } else {
        const cleaned = value.replace(/^\[/, '').replace(/\]$/, '')
        tags = cleaned
          .split(',')
          .map((piece) => stripQuotes(piece))
          .filter(Boolean)
      }
    } else {
      collectingTags = false
    }
  }
  return { title, tags }
}

/** Editable fields surfaced by the frontmatter property panel. `other` holds
 * every unrecognized YAML key verbatim (read-only display, not edited). */
export interface FrontmatterFields {
  title: string
  tags: string[]
  date: string
  created: string
  updated: string
  other: Record<string, string>
}

const FRONTMATTER_KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/
const KNOWN_FRONTMATTER_KEYS = new Set(['title', 'tags', 'date', 'created', 'updated'])

/** Parse the inner frontmatter text (between the `---` fences) into editable
 * fields plus every other key as a raw scalar. */
export function parseFrontmatterForPanel(front: string): FrontmatterFields {
  const fields: FrontmatterFields = {
    title: '',
    tags: [],
    date: '',
    created: '',
    updated: '',
    other: {},
  }
  let collectingTags = false
  for (const line of front.split(/\r?\n/)) {
    if (collectingTags) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line)
      if (item) {
        const tag = stripQuotes(item[1])
        if (tag) fields.tags.push(tag)
        continue
      }
      if (line.trim() === '') continue
      collectingTags = false
    }
    const pair = FRONTMATTER_KEY_RE.exec(line)
    if (!pair) continue
    const key = pair[1]
    const value = pair[2].trim()
    const lower = key.toLowerCase()
    if (lower === 'title') {
      fields.title = stripQuotes(value)
      collectingTags = false
    } else if (lower === 'tags') {
      fields.tags = []
      if (value === '') {
        collectingTags = true
      } else {
        const cleaned = value.replace(/^\[/, '').replace(/\]$/, '')
        fields.tags = cleaned.split(',').map((p) => stripQuotes(p)).filter(Boolean)
      }
    } else if (lower === 'date') {
      fields.date = stripQuotes(value)
      collectingTags = false
    } else if (lower === 'created') {
      fields.created = stripQuotes(value)
      collectingTags = false
    } else if (lower === 'updated') {
      fields.updated = stripQuotes(value)
      collectingTags = false
    } else if (!KNOWN_FRONTMATTER_KEYS.has(lower)) {
      // Preserve the original key casing for unknown keys.
      fields.other[key] = stripQuotes(value)
      collectingTags = false
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
 * Known keys are emitted first (title, tags, date, created, updated), then any
 * preserved `other` keys in their original insertion order. */
export function serializeFrontmatter(fields: FrontmatterFields): string {
  const lines: string[] = []
  if (fields.title !== '') lines.push(`title: ${yamlScalar(fields.title)}`)
  const tags = [...new Set(fields.tags)]
  if (tags.length > 0) {
    lines.push('tags:')
    for (const tag of tags) lines.push(`  - ${yamlScalar(tag)}`)
  }
  if (fields.date !== '') lines.push(`date: ${yamlScalar(fields.date)}`)
  if (fields.created !== '') lines.push(`created: ${yamlScalar(fields.created)}`)
  if (fields.updated !== '') lines.push(`updated: ${yamlScalar(fields.updated)}`)
  for (const [key, value] of Object.entries(fields.other)) {
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

export function hasFrontmatter(md: string): boolean {
  return splitFrontmatterRaw(md).front !== ''
}

export function emptyFrontmatterFields(): FrontmatterFields {
  return { title: '', tags: [], date: '', created: '', updated: '', other: {} }
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

export function fileNameTitle(name: string): string {
  return name.replace(/\.(md|mdx)$/i, '').trim()
}

function fenceMask(content: string): string {
  let inFence = false
  const lines: string[] = []
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      lines.push('')
      continue
    }
    lines.push(inFence ? '' : line)
  }
  return lines.join('\n')
}

export function extractH1(body: string): string {
  const visible = fenceMask(body)
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(visible)
  if (!match) return ''
  return match[1].replace(/[#`*_~]/g, '').replace(/\s+/g, ' ').trim()
}

export function extractSummary(body: string, max = SUMMARY_CHARS): string {
  const visible = fenceMask(body)
  const text = visible
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, max)
}

/** Directory of `path` relative to the vault. Absolute paths (Tauri) get the
 * vault prefix stripped; already-relative paths (demo gateway) are kept as-is. */
/**
 * A note path with the vault prefix removed, so it can be re-rooted at the
 * vault.
 *
 * `tab.path` is vault-relative in some flows and an absolute (vault-prefixed)
 * path in others — `list_dir` returns the resolved path, while the link index
 * returns a vault-relative one — so anything that needs to JOIN the vault back
 * onto a note path must strip whatever prefix is already there first. Joining
 * without stripping is what produced a doubled path in copied heading links.
 */
export function notePathRelativeToVault(path: string, vault: string): string {
  const v = (vault || '').replace(/\/+$/, '')
  let p = path
  if (v !== '' && (p === v || p.startsWith(`${v}/`))) {
    p = p.slice(v.length)
  }
  return p.replace(/^\/+/, '')
}

export function dirRelativeToVault(path: string, vault: string): string {
  const p = notePathRelativeToVault(path, vault)
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export function relPathOf(note: Pick<NoteSummary, 'dir' | 'name'>): string {
  return note.dir ? `${note.dir}/${note.name}` : note.name
}

/** Resolve a markdown link target against the note's vault-relative dir. */
export function resolveLinkTarget(fromRelDir: string, target: string): string {
  const clean = target.split('#')[0].trim()
  if (!clean) return ''
  const segs = fromRelDir ? fromRelDir.split('/') : []
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segs.pop()
    else segs.push(part)
  }
  return segs.join('/')
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const EXTERNAL_RE = /^(https?:|mailto:|#|data:)/i

export function extractOutlinks(content: string): MdLink[] {
  const out: MdLink[] = []
  for (const match of content.matchAll(LINK_RE)) {
    const target = match[2]
    if (EXTERNAL_RE.test(target)) continue
    const path = target.split('#')[0]
    if (!/\.(md|mdx)$/i.test(path)) continue
    out.push({ text: match[1].trim(), target })
  }
  return out
}

export function parseNoteMeta(
  path: string,
  content: string,
  meta: { mtime: number; size: number; vault: string },
): NoteSummary {
  const snapshot = content.slice(0, SNAPSHOT_CHARS)
  const { front, body } = splitFrontmatterRaw(snapshot)
  const parsed = parseFrontmatterBlock(front)
  const name = path.split('/').pop() ?? path
  const dir = dirRelativeToVault(path, meta.vault)
  const tags = [...new Set(parsed.tags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean))]
  const fromDir = dir
  const links = [
    ...new Set(
      extractOutlinks(content)
        .map((l) => resolveLinkTarget(fromDir, l.target))
        .filter(Boolean),
    ),
  ]
  return {
    path,
    name,
    title: parsed.title || extractH1(body) || fileNameTitle(name) || t('note.untitled'),
    tags,
    summary: extractSummary(body),
    mtime: meta.mtime,
    size: meta.size,
    dir,
    links,
  }
}

export function matchesQuery(note: NoteSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${note.title} ${note.name} ${note.summary} ${relPathOf(note)} ${note.tags.join(' ')}`
    .toLowerCase()
    .includes(q)
}

export interface FilterOptions {
  filter: LibraryFilter
  query: string
  favorites: ReadonlySet<string>
  recents: readonly string[]
  sortBy: SortBy
}

export function filterNotes(notes: NoteSummary[], opts: FilterOptions): NoteSummary[] {
  const recentSet = new Set(opts.recents)
  const tagFilter = opts.filter.startsWith('tag:') ? opts.filter.slice(4) : null
  return notes.filter((note) => {
    if (opts.filter === 'favorites' && !opts.favorites.has(note.path)) return false
    if (opts.filter === 'recent' && !recentSet.has(note.path)) return false
    if (opts.filter === 'uncategorized' && note.dir !== '') return false
    if (tagFilter && !note.tags.includes(tagFilter)) return false
    return matchesQuery(note, opts.query)
  })
}

export function sortNotes(notes: NoteSummary[], sortBy: SortBy): NoteSummary[] {
  const next = [...notes]
  const byName = (a: NoteSummary, b: NoteSummary): number =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  next.sort((a, b) => {
    let c: number
    if (sortBy === 'mtime') c = b.mtime - a.mtime
    else if (sortBy === 'title') c = a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true })
    else c = byName(a, b)
    if (c === 0) c = byName(a, b)
    return c
  })
  return next
}

export function filterAndSortNotes(notes: NoteSummary[], opts: FilterOptions): NoteSummary[] {
  return sortNotes(filterNotes(notes, opts), opts.sortBy)
}

export function aggregateTagCounts(
  notes: NoteSummary[],
  limit = 8,
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const note of notes) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'))
    .slice(0, limit)
}

export function computeLibraryCounts(
  notes: NoteSummary[],
  favorites: readonly string[],
  recents: readonly string[],
): LibraryCounts {
  const paths = new Set(notes.map((n) => n.path))
  let uncategorized = 0
  for (const note of notes) {
    if (note.dir === '') uncategorized += 1
  }
  return {
    all: notes.length,
    recent: recents.filter((p) => paths.has(p)).length,
    favorites: favorites.filter((p) => paths.has(p)).length,
    uncategorized,
  }
}

export function formatRelativeTime(mtime: number, now = Date.now()): string {
  if (!mtime || mtime <= 0) return '—'
  const diff = now - mtime
  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  if (diff < minute) return t('time.justNow')
  if (diff < hour) return t('time.minutesAgo', { n: Math.floor(diff / minute) })
  if (diff < day) return t('time.hoursAgo', { n: Math.floor(diff / hour) })
  if (diff < 30 * day) return t('time.daysAgo', { n: Math.floor(diff / day) })
  const d = new Date(mtime)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}
