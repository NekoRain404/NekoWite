import { describe, expect, it } from 'vitest'
import {
  aggregateTagCounts,
  computeLibraryCounts,
  dirRelativeToVault,
  emptyFrontmatterFields,
  extractH1,
  extractOutlinks,
  extractSummary,
  fileNameTitle,
  filterAndSortNotes,
  formatRelativeTime,
  frontmatterBlock,
  hasFrontmatter,
  parseFrontmatterBlock,
  parseFrontmatterForPanel,
  parseNoteMeta,
  relPathOf,
  replaceFrontmatter,
  resolveLinkTarget,
  serializeFrontmatter,
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

describe('frontmatter serialization (panel + rewrite)', () => {
  it('parses block/inline/comma tags plus title, dates and other keys', () => {
    const fields = parseFrontmatterForPanel(
      'title: 笔记\n# a comment\ntags:\n  - 数学\n  - "随笔"\ndate: 2026-09-03\nauthor: nekora',
    )
    expect(fields.title).toBe('笔记')
    expect(fields.tags).toEqual(['数学', '随笔'])
    expect(fields.date).toBe('2026-09-03')
    expect(fields.other).toEqual({ author: 'nekora' })
    expect(parseFrontmatterForPanel('tags: [a, b]\ncreated: 2026-01-01')).toEqual({
      title: '',
      tags: ['a', 'b'],
      date: '',
      created: '2026-01-01',
      updated: '',
      other: {},
      rawSegments: [
        { key: 'tags', lines: ['tags: [a, b]'] },
        { key: 'created', lines: ['created: 2026-01-01'] },
      ],
    })
    expect(parseFrontmatterForPanel('title: X\ntags: 数学, 物理')).toMatchObject({
      title: 'X',
      tags: ['数学', '物理'],
    })
  })

  it('quotes values containing ": ", "#", newlines, empties and leading specials', () => {
    expect(serializeFrontmatter({ ...emptyFrontmatterFields(), title: 'a: b' })).toBe('title: "a: b"')
    expect(serializeFrontmatter({ ...emptyFrontmatterFields(), title: 'a#b' })).toBe('title: "a#b"')
    expect(serializeFrontmatter({ ...emptyFrontmatterFields(), title: 'a"b' })).toBe('title: "a\\"b"')
    expect(serializeFrontmatter({ ...emptyFrontmatterFields(), title: '  leading' })).toBe('title: "  leading"')
    expect(serializeFrontmatter({ ...emptyFrontmatterFields(), title: '' })).toBe('')
    expect(serializeFrontmatter({ ...emptyFrontmatterFields(), title: 'plain' })).toBe('title: plain')
  })

  it('serializes a tags block array and round-trips through the parser', () => {
    const inner = serializeFrontmatter({
      title: '图论',
      tags: ['数学', '随笔'],
      date: '',
      created: '2026-01-01',
      updated: '',
      other: { author: 'nekora' },
      rawSegments: [],
    })
    expect(inner).toContain('tags:')
    expect(inner).toContain('  - 数学')
    expect(inner).toContain('  - 随笔')
    const reparsed = parseFrontmatterForPanel(inner)
    expect(reparsed.title).toBe('图论')
    expect(reparsed.tags).toEqual(['数学', '随笔'])
    expect(reparsed.created).toBe('2026-01-01')
    expect(reparsed.other).toEqual({ author: 'nekora' })
  })

  it('round-trips quote-requiring tag values including commas', () => {
    const fields: ReturnType<typeof parseFrontmatterForPanel> = {
      title: '笔记',
      tags: ['a: b', 'c#d'],
      date: '',
      created: '',
      updated: '',
      other: { note: 'x: y' },
      rawSegments: [],
    }
    const reparsed = parseFrontmatterForPanel(serializeFrontmatter(fields))
    expect(reparsed.tags).toEqual(['a: b', 'c#d'])
    expect(reparsed.other).toEqual({ note: 'x: y' })
  })

  it('frontmatterBlock wraps inner text with fences and a trailing blank line', () => {
    expect(frontmatterBlock('title: x')).toBe('---\ntitle: x\n---\n\n')
    expect(hasFrontmatter('---\ntitle: x\n---\n\n# body')).toBe(true)
    expect(hasFrontmatter('no frontmatter')).toBe(false)
  })

  it('replaceFrontmatter rewrites only the block, preserving the body byte-for-byte', () => {
    const md = '---\ntitle: old\ntags: [x]\n---\n\n# Hello\n\nBody'
    const fields = {
      title: 'new',
      tags: ['a', 'b'],
      date: '2026-01-01',
      created: '',
      updated: '',
      other: { author: 'nekora' },
      rawSegments: [],
    }
    const { content, hadFront, changed } = replaceFrontmatter(md, fields)
    expect(hadFront).toBe(true)
    expect(changed).toBe(true)
    expect(content).toBe('---\ntitle: new\ntags:\n  - a\n  - b\ndate: 2026-01-01\nauthor: nekora\n---\n\n# Hello\n\nBody')
    expect(content.endsWith('\n\n# Hello\n\nBody')).toBe(true)
  })

  it('prepends a fresh frontmatter block when the document has none', () => {
    const body = '# Welcome\n\nContent'
    const { content, hadFront } = replaceFrontmatter(body, {
      title: 'Welcome',
      tags: [],
      date: '',
      created: '',
      updated: '',
      other: {},
      rawSegments: [],
    })
    expect(hadFront).toBe(false)
    expect(content).toBe('---\ntitle: Welcome\n---\n\n# Welcome\n\nContent')
  })
})

describe('frontmatter raw-text preservation', () => {
  // The audit's exact document: every unknown key must survive a panel write.
  const auditBlock = [
    'title: A',
    'aliases:',
    '  - one',
    '  - two',
    'cssclasses: [wide, dark]',
    'meta:',
    '  nested: 1',
    'doi: 10.1/x',
  ].join('\n')

  it('re-emits an untouched block byte-for-byte', () => {
    const fields = parseFrontmatterForPanel(auditBlock)
    expect(fields.title).toBe('A')
    expect(serializeFrontmatter(fields)).toBe(auditBlock)
  })

  it('keeps a block sequence, a flow sequence and a mapping when a field is edited', () => {
    const fields = { ...parseFrontmatterForPanel(auditBlock), title: 'B' }
    expect(serializeFrontmatter(fields)).toBe(auditBlock.replace('title: A', 'title: B'))
  })

  it('leaves replaceFrontmatter a no-op for an untouched block with unknown keys', () => {
    const md = `---\n${auditBlock}\n---\n\n# Body`
    const fields = parseFrontmatterForPanel(splitFrontmatterRaw(md).front)
    expect(replaceFrontmatter(md, fields)).toEqual({ content: md, hadFront: true, changed: false })
  })

  it('keeps blank separator lines between keys untouched', () => {
    const front = ['title: A', 'tags:', '  - 数学', '', 'author: ned', '', 'meta:', '  nested: 1'].join('\n')
    expect(serializeFrontmatter(parseFrontmatterForPanel(front))).toBe(front)
  })

  it('still parses a block tag list across a blank line', () => {
    const front = 'tags:\n\n  - a\n  - b'
    const fields = parseFrontmatterForPanel(front)
    expect(fields.tags).toEqual(['a', 'b'])
    expect(serializeFrontmatter(fields)).toBe('tags:\n  - a\n  - b')
  })

  it('keeps a key with an empty value and no continuation empty', () => {
    const front = 'title: A\ndraft:'
    expect(parseFrontmatterForPanel(front).other).toEqual({ draft: '' })
    expect(serializeFrontmatter(parseFrontmatterForPanel(front))).toBe(front)
  })

  it('keeps block scalars with their indented and blank lines', () => {
    const front = ['title: A', 'summary: |', '  first line', '', '  second line', 'note: >', '  folded'].join('\n')
    expect(serializeFrontmatter(parseFrontmatterForPanel(front))).toBe(front)
  })

  it('keeps a duplicated key twice, in its original order', () => {
    const front = 'title: A\nref: one\nref: two'
    const fields = parseFrontmatterForPanel(front)
    expect(fields.rawSegments.map((segment) => segment.key)).toEqual(['title', 'ref', 'ref'])
    // The display collapses duplicates, the raw text must not.
    expect(fields.other).toEqual({ ref: 'two' })
    expect(serializeFrontmatter(fields)).toBe(front)
  })

  it('keeps a leading comment above the block', () => {
    const front = '# hand-written\ntitle: A\nauthor: ned'
    expect(serializeFrontmatter(parseFrontmatterForPanel(front))).toBe(front)
  })

  it('never treats an indented key-like line as a top-level key', () => {
    const front = 'title: A\nmeta:\n  title: nested\n\ttitle: tabbed\nauthor: ned'
    const fields = parseFrontmatterForPanel(front)
    expect(fields.title).toBe('A')
    expect(serializeFrontmatter(fields)).toBe(front)
  })

  it('treats a tab-only indented line as a continuation, never a key', () => {
    const front = 'meta:\n\tnested: 1'
    const fields = parseFrontmatterForPanel(front)
    expect(fields.other).toEqual({ meta: '' })
    expect(serializeFrontmatter(fields)).toBe(front)
  })

  it('keeps a `---` inside a quoted value from splitting the block early', () => {
    const md = '---\nsubtitle: "before --- after"\nquote: "line one\n  --- not a fence\n  line three"\n---\n\n# Body'
    const { front, body } = splitFrontmatterRaw(md)
    expect(front).toContain('--- not a fence')
    const fields = parseFrontmatterForPanel(front)
    const { content, changed } = replaceFrontmatter(md, fields)
    expect(changed).toBe(false)
    expect(content).toBe(md)
    expect(body).toBe('# Body')
  })

  it('recognizes a non-ASCII key as a top-level key and keeps it raw', () => {
    const front = '标题: 我的笔记\ntitle: A'
    const fields = parseFrontmatterForPanel(front)
    expect(fields.other['标题']).toBe('我的笔记')
    expect(fields.rawSegments).toEqual([
      { key: '标题', lines: ['标题: 我的笔记'] },
      { key: 'title', lines: ['title: A'] },
    ])
    expect(serializeFrontmatter(fields)).toBe('title: A\n标题: 我的笔记')
  })

  it('keeps a non-indented line the key regex cannot express instead of merging it', () => {
    const front = 'title: A\nmy key: x'
    expect(serializeFrontmatter(parseFrontmatterForPanel(front))).toBe(front)
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

describe('metadata for long frontmatter', () => {
  // A block longer than the old 400-character snapshot never closed inside it,
  // so `front` came back empty: the note lost its title and tags in the list,
  // the tag filter and the search index, while the frontmatter panel (which
  // reads the whole block) still showed them.
  const longBlock = [
    '---',
    'title: A very long meta block',
    'tags: [alpha, beta]',
    'abstract: >-',
    '  ' + 'filler '.repeat(120).trim(),
    '---',
    '',
    '# Heading fallback',
    '',
    'Body text that should be the summary.',
  ].join('\n')

  it('finds the title and tags past the old 400-character limit', () => {
    const meta = parseNoteMeta('/v/long.md', longBlock, { mtime: 0, size: longBlock.length, vault: '/v' })
    expect(meta.title).toBe('A very long meta block')
    expect(meta.tags).toEqual(['alpha', 'beta'])
  })

  it('takes the summary from the body, not from the YAML', () => {
    const meta = parseNoteMeta('/v/long.md', longBlock, { mtime: 0, size: longBlock.length, vault: '/v' })
    expect(meta.summary).toContain('Body text')
    expect(meta.summary).not.toContain('filler')
  })

  it('still handles a note that opens with a fence but never closes it', () => {
    // The scan is capped, so this must not walk the whole document; with no
    // closing fence there is simply no frontmatter to read.
    const broken = '---\n' + 'x'.repeat(20000) + '\n\n# Title\n'
    const meta = parseNoteMeta('/v/broken.md', broken, { mtime: 0, size: broken.length, vault: '/v' })
    expect(meta.title).toMatch(/broken|Title/)
  })

  it('keeps a plain short block working exactly as before', () => {
    const short = '---\ntitle: Short\ntags: [one]\n---\n\n# H1\n\nsummary here\n'
    const meta = parseNoteMeta('/v/short.md', short, { mtime: 0, size: short.length, vault: '/v' })
    expect(meta.title).toBe('Short')
    expect(meta.tags).toEqual(['one'])
    expect(meta.summary).toContain('summary here')
  })
})
