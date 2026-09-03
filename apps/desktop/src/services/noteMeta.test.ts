import { describe, expect, it } from 'vitest'
import {
  aggregateTagCounts,
  computeLibraryCounts,
  dirRelativeToVault,
  extractH1,
  extractOutlinks,
  extractSummary,
  fileNameTitle,
  filterAndSortNotes,
  formatRelativeTime,
  parseFrontmatterBlock,
  parseNoteMeta,
  relPathOf,
  resolveLinkTarget,
  splitFrontmatterRaw,
} from './noteMeta'
import type { NoteSummary } from './noteMeta'

function note(overrides: Partial<NoteSummary> & { path: string }): NoteSummary {
  return {
    name: overrides.path.split('/').pop() ?? overrides.path,
    title: fileNameTitle(overrides.path.split('/').pop() ?? overrides.path),
    tags: [],
    summary: '',
    mtime: 0,
    size: 0,
    dir: '',
    links: [],
    ...overrides,
  }
}

describe('parseFrontmatterBlock', () => {
  it('parses YAML array tags', () => {
    const front = 'title: 笔记一\ntags:\n  - 数学\n  - 随笔\nother: x'
    expect(parseFrontmatterBlock(front)).toEqual({ title: '笔记一', tags: ['数学', '随笔'] })
  })
  it('parses inline bracket and comma-separated tags plus quoted title', () => {
    expect(parseFrontmatterBlock("title: \"My Note\"\ntags: [a, b]")).toEqual({ title: 'My Note', tags: ['a', 'b'] })
    expect(parseFrontmatterBlock('title: X\ntags: 数学, 物理')).toEqual({ title: 'X', tags: ['数学', '物理'] })
  })
})

describe('splitFrontmatterRaw / title fallbacks', () => {
  it('splits frontmatter from body', () => {
    const md = '---\ntitle: T\n---\n\n# 正文'
    const { front, body } = splitFrontmatterRaw(md)
    expect(front).toContain('title: T')
    expect(body).toBe('# 正文')
  })
  it('extracts the first H1 with fence awareness and falls back to file name', () => {
    expect(extractH1('```md\n# not a heading\n```\n\n# 真标题')).toBe('真标题')
    expect(extractH1('no heading here')).toBe('')
    expect(fileNameTitle('我的笔记.md')).toBe('我的笔记')
  })
})

describe('extractSummary', () => {
  it('strips code blocks, links and markers, and truncates to 120 chars', () => {
    const body = '# 标题\n\n```js\nconst x = 1\n```\n\n这是[链接](a.md)与 **加粗** 文本。\n\n' + '长'.repeat(200)
    const summary = extractSummary(body)
    expect(summary).not.toContain('const x')
    expect(summary).toContain('这是链接与 加粗 文本')
    expect(summary.length).toBeLessThanOrEqual(120)
  })
})

describe('parseNoteMeta', () => {
  it('builds a NoteSummary with frontmatter title/tags, relative dir and resolved links', () => {
    const content = '---\ntitle: 图论笔记\ntags: [math, graph]\n---\n\n# 图论\n\n参见 [基础](../basics/intro.md) 与 [同目录](sibling.md)。'
    const meta = parseNoteMeta('/vault/notes/graph.md', content, { mtime: 100, size: content.length, vault: '/vault' })
    expect(meta.title).toBe('图论笔记')
    expect(meta.tags).toEqual(['math', 'graph'])
    expect(meta.dir).toBe('notes')
    expect(meta.name).toBe('graph.md')
    expect(meta.links).toEqual(['basics/intro.md', 'notes/sibling.md'])
  })
  it('uses H1 and file name fallbacks without frontmatter and marks root notes uncategorized', () => {
    const meta = parseNoteMeta('欢迎.md', '# 欢迎\n\n正文内容。', { mtime: 0, size: 10, vault: 'memoir://demo' })
    expect(meta.title).toBe('欢迎')
    expect(meta.dir).toBe('')
    expect(meta.summary).toBe('欢迎 正文内容。')
  })
})

describe('dirRelativeToVault / relPathOf', () => {
  it('strips vault prefix from absolute paths and keeps relative paths', () => {
    expect(dirRelativeToVault('/vault/sub/a.md', '/vault')).toBe('sub')
    expect(dirRelativeToVault('welcome.md', 'memoir://demo')).toBe('')
    expect(dirRelativeToVault('/vault/a.md', '/vault/')).toBe('')
    expect(relPathOf({ dir: 'sub', name: 'a.md' })).toBe('sub/a.md')
    expect(relPathOf({ dir: '', name: 'a.md' })).toBe('a.md')
  })
})

describe('resolveLinkTarget', () => {
  it('resolves ./ and ../ segments and anchors', () => {
    expect(resolveLinkTarget('notes', './sibling.md')).toBe('notes/sibling.md')
    expect(resolveLinkTarget('notes/deep', '../basics/intro.md#sec')).toBe('notes/basics/intro.md')
    expect(resolveLinkTarget('', 'top.md')).toBe('top.md')
    expect(resolveLinkTarget('a', '')).toBe('')
  })
})

describe('extractOutlinks', () => {
  it('keeps only relative markdown links', () => {
    const content = '[a](b.md) [ext](https://x.com/y.md) [img](pic.png) [anchor](#h) [t](c.md "title")'
    const links = extractOutlinks(content)
    expect(links).toEqual([
      { text: 'a', target: 'b.md' },
      { text: 't', target: 'c.md' },
    ])
  })
})

describe('filterAndSortNotes', () => {
  const notes: NoteSummary[] = [
    note({ path: '/vault/b.md', dir: '', tags: ['math'], mtime: 300, summary: 'alpha 内容' }),
    note({ path: '/vault/sub/a.md', dir: 'sub', tags: [], mtime: 100, title: 'Zeta' }),
    note({ path: '/vault/sub/c.md', dir: 'sub', tags: ['math', 'deep'], mtime: 200, title: 'Alpha' }),
  ]
  const base = { query: '', favorites: new Set(['/vault/sub/c.md']), recents: ['/vault/sub/a.md'], sortBy: 'mtime' as const }

  it('filters by favorites, recent, uncategorized and tag', () => {
    expect(filterAndSortNotes(notes, { ...base, filter: 'favorites' }).map((n) => n.path)).toEqual(['/vault/sub/c.md'])
    expect(filterAndSortNotes(notes, { ...base, filter: 'recent' }).map((n) => n.path)).toEqual(['/vault/sub/a.md'])
    expect(filterAndSortNotes(notes, { ...base, filter: 'uncategorized' }).map((n) => n.path)).toEqual(['/vault/b.md'])
    expect(filterAndSortNotes(notes, { ...base, filter: 'tag:math' }).map((n) => n.path)).toEqual(['/vault/b.md', '/vault/sub/c.md'])
  })
  it('matches the query against title/name/summary/tags', () => {
    expect(filterAndSortNotes(notes, { ...base, filter: 'all', query: 'alpha' }).map((n) => n.path)).toEqual(['/vault/b.md', '/vault/sub/c.md'])
    expect(filterAndSortNotes(notes, { ...base, filter: 'all', query: 'zeta' }).map((n) => n.path)).toEqual(['/vault/sub/a.md'])
    expect(filterAndSortNotes(notes, { ...base, filter: 'all', query: '不存在' })).toEqual([])
  })
  it('sorts by mtime desc, title asc and name asc with stable tie-break', () => {
    expect(filterAndSortNotes(notes, { ...base, filter: 'all', sortBy: 'mtime' }).map((n) => n.path)).toEqual(['/vault/b.md', '/vault/sub/c.md', '/vault/sub/a.md'])
    expect(filterAndSortNotes(notes, { ...base, filter: 'all', sortBy: 'title' }).map((n) => n.path)).toEqual(['/vault/sub/c.md', '/vault/b.md', '/vault/sub/a.md'])
    expect(filterAndSortNotes(notes, { ...base, filter: 'all', sortBy: 'name' }).map((n) => n.path)).toEqual(['/vault/sub/a.md', '/vault/b.md', '/vault/sub/c.md'])
  })
})

describe('aggregateTagCounts', () => {
  it('counts tags, sorts by count desc then tag, and limits to top 8', () => {
    const notes: NoteSummary[] = [
      note({ path: '/vault/1.md', tags: ['a', 'b'] }),
      note({ path: '/vault/2.md', tags: ['a'] }),
      note({ path: '/vault/3.md', tags: ['c'] }),
      ...Array.from({ length: 10 }, (_, i) => note({ path: `/vault/x${i}.md`, tags: [`t${i}`] })),
    ]
    const tags = aggregateTagCounts(notes)
    expect(tags).toHaveLength(8)
    expect(tags[0]).toEqual({ tag: 'a', count: 2 })
    expect(tags.slice(1).map((t) => t.count)).toEqual([1, 1, 1, 1, 1, 1, 1])
  })
})

describe('computeLibraryCounts', () => {
  it('counts all/recent/favorites/uncategorized against existing notes only', () => {
    const notes: NoteSummary[] = [
      note({ path: '/vault/root.md', dir: '' }),
      note({ path: '/vault/sub/a.md', dir: 'sub' }),
    ]
    expect(computeLibraryCounts(notes, ['/vault/root.md', '/vault/gone.md'], ['/vault/sub/a.md', '/vault/gone.md'])).toEqual({
      all: 2,
      recent: 1,
      favorites: 1,
      uncategorized: 1,
    })
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-03T12:00:00Z')
  it('formats buckets in Chinese and dates beyond 30 days', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(formatRelativeTime(now - 4 * 86_400_000, now)).toBe('4 天前')
    expect(formatRelativeTime(now - 45 * 86_400_000, now)).toBe('2026/07/20')
    expect(formatRelativeTime(0, now)).toBe('—')
  })
})
