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
export function dirRelativeToVault(path: string, vault: string): string {
  const v = vault.replace(/\/+$/, '')
  let p = path
  if (v !== '' && (p === v || p.startsWith(`${v}/`))) {
    p = p.slice(v.length).replace(/^\/+/, '')
  }
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
    title: parsed.title || extractH1(body) || fileNameTitle(name) || '未命名',
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
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
  const d = new Date(mtime)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}
