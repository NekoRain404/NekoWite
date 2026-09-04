import { describe, expect, it } from 'vitest'
import {
  buildLinkGraph,
  computeLayout,
  computeLayoutChunked,
  extractLinks,
  graphSignature,
  resolveLinkPath,
} from './linkGraph'

describe('extractLinks', () => {
  it('extracts wiki link targets', () => {
    expect(extractLinks('见 [[笔记A]] 与 [[文件夹/笔记B]]')).toEqual(['笔记A', '文件夹/笔记B'])
  })

  it('strips wiki aliases and anchors', () => {
    const md = '[[:mem:0|别称]] [[目标#章节]] [[带 别名|alias]]'
    expect(extractLinks(md)).toEqual([':mem:0', '目标', '带 别名'])
  })

  it('extracts relative .md/.mdx inline links and ignores the alias label', () => {
    const md = '[标签](./sub/note.md) [另一个](../other.mdx "标题")'
    expect(extractLinks(md)).toEqual(['./sub/note.md', '../other.mdx'])
  })

  it('skips http(s), anchors, empty and non-markdown targets', () => {
    const md = [
      '[外部](https://example.com)',
      '[协议](obsidian://open)',
      '[锚点](#section)',
      '[附件](attachments/pic.png)',
      '[空]()',
    ].join('\n')
    expect(extractLinks(md)).toEqual([])
  })

  it('ignores links inside fenced code blocks', () => {
    const md = ['正文 [[真链接]]', '', '```md', '[[代码里的假链接]]', '[x](fake.md)', '```', '', '[真实](real.md)'].join('\n')
    expect(extractLinks(md)).toEqual(['真链接', 'real.md'])
  })

  it('ignores frontmatter content', () => {
    const md = '---\ntitle: "[[front]]"\n---\n\n正文 [[body链接]]'
    expect(extractLinks(md)).toEqual(['body链接'])
  })

  it('ignores image embeds and keeps bare tildes fences', () => {
    const md = ['![说明](pic.png)', '~~~', '[[fence内]]', '~~~', '[[正文]]'].join('\n')
    expect(extractLinks(md)).toEqual(['正文'])
  })

  it('handles CRLF and returns empty for no links', () => {
    expect(extractLinks('# 标题\r\n普通正文，没有链接。\r\n')).toEqual([])
  })
})

describe('resolveLinkPath', () => {
  const paths = ['a.md', 'docs/b.md', 'docs/c.mdx', 'guides/quick start.md']

  it('resolves sibling note by name', () => {
    expect(resolveLinkPath('docs/b.md', 'c', paths)).toBe('docs/c.mdx')
  })

  it('resolves extension-less wiki names against .md/.mdx', () => {
    expect(resolveLinkPath('a.md', 'b', paths)).toBe('docs/b.md')
    expect(resolveLinkPath('a.md', 'docs/c', paths)).toBe('docs/c.mdx')
  })

  it('resolves relative paths with .. against the source directory', () => {
    expect(resolveLinkPath('docs/b.md', '../a.md', paths)).toBe('a.md')
    expect(resolveLinkPath('a.md', 'docs/b.md', paths)).toBe('docs/b.md')
  })

  it('matches by file-name stem across directories as fallback', () => {
    expect(resolveLinkPath('docs/b.md', 'quick start', paths)).toBe('guides/quick start.md')
  })

  it('falls back to stem match when the relative path does not exist', () => {
    expect(resolveLinkPath('docs/b.md', '../不存在的名字', ['x/不存在的名字.md'])).toBe('x/不存在的名字.md')
  })

  it('returns null for unknown, external or anchor targets', () => {
    const external = ['a.md', 'https://example.com', '#锚点']
    expect(resolveLinkPath('a.md', '不存在', paths)).toBeNull()
    expect(resolveLinkPath('a.md', 'https://example.com', external)).toBeNull()
    expect(resolveLinkPath('a.md', '#锚点', external)).toBeNull()
    expect(resolveLinkPath('a.md', '', paths)).toBeNull()
  })

  it('is case-insensitive on extensions', () => {
    const upper = ['A.MD', 'sub/B.MDX']
    expect(resolveLinkPath('A.MD', 'sub/B', upper)).toBe('sub/B.MDX')
  })
})

describe('buildLinkGraph', () => {
  it('builds nodes for all notes and deduplicated edges', () => {
    const graph = buildLinkGraph([
      { path: 'a.md', content: '指向 [[b]] 与 [c](c.md)' },
      { path: 'b.md', content: '回到 [[a]] [[a|别名]]' },
      { path: 'c.md', content: '[[b]] [[b]]' },
    ])
    expect(graph.nodes.map((n) => n.id)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(graph.edges).toHaveLength(4)
    expect(graph.edges).toContainEqual({ from: 'a.md', to: 'b.md' })
    expect(graph.edges).toContainEqual({ from: 'a.md', to: 'c.md' })
    expect(graph.edges).toContainEqual({ from: 'b.md', to: 'a.md' })
    expect(graph.edges).toContainEqual({ from: 'c.md', to: 'b.md' })
  })

  it('keeps orphan nodes and counts degrees both ways', () => {
    const graph = buildLinkGraph([
      { path: 'hub.md', content: '[[a]] [[a|再来一次]]' },
      { path: 'a.md', content: '回到 [[hub]]' },
      { path: '孤岛.md', content: '没有任何链接' },
    ])
    const orphans = graph.nodes.filter((n) => n.degree === 0)
    expect(orphans.map((n) => n.id)).toEqual(['孤岛.md'])
    expect(graph.edges).toHaveLength(2)
    expect(graph.nodes.find((n) => n.id === 'hub.md')?.degree).toBe(2)
  })

  it('drops self links and unresolvable targets', () => {
    const graph = buildLinkGraph([
      { path: 'a.md', content: '自指 [[a]] 还有 [[不存在]]' },
      { path: 'b.md', content: '' },
    ])
    expect(graph.edges).toEqual([])
    expect(graph.nodes.map((n) => n.id)).toEqual(['a.md', 'b.md'])
  })

  it('returns empty graph for empty input', () => {
    expect(buildLinkGraph([])).toEqual({ nodes: [], edges: [] })
  })
})

describe('computeLayout', () => {
  const nodes = [
    { id: 'a.md' },
    { id: 'b.md' },
    { id: 'c.md' },
    { id: '孤岛.md' },
    { id: 'e.md' },
  ]
  const edges = [
    { from: 'a.md', to: 'b.md' },
    { from: 'a.md', to: 'c.md' },
    { from: 'b.md', to: 'c.md' },
  ]

  it('returns one point per node with coordinates inside the canvas', () => {
    const layout = computeLayout(nodes, edges, 800, 600)
    expect(layout).toHaveLength(nodes.length)
    for (const point of layout) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(800)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(600)
    }
    expect(new Set(layout.map((p) => p.id))).toEqual(new Set(nodes.map((n) => n.id)))
  })

  it('is deterministic for the same seed', () => {
    const first = computeLayout(nodes, edges, 800, 600, { seed: 7 })
    const second = computeLayout(nodes, edges, 800, 600, { seed: 7 })
    expect(first).toEqual(second)
  })

  it('seeds change the layout', () => {
    const first = computeLayout(nodes, edges, 800, 600, { seed: 1 })
    const second = computeLayout(nodes, edges, 800, 600, { seed: 2 })
    expect(first).not.toEqual(second)
  })

  it('keeps connected nodes closer than random pairs on average', () => {
    const layout = computeLayout(nodes, edges, 800, 600, { seed: 42 })
    const byId = new Map(layout.map((p) => [p.id, p]))
    const dist = (a: string, b: string) => {
      const pa = byId.get(a)!
      const pb = byId.get(b)!
      return Math.hypot(pa.x - pb.x, pa.y - pb.y)
    }
    const connected = [dist('a.md', 'b.md'), dist('a.md', 'c.md'), dist('b.md', 'c.md')]
    const far = [dist('a.md', '孤岛.md'), dist('b.md', '孤岛.md'), dist('c.md', '孤岛.md')]
    const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length
    expect(avg(connected)).toBeLessThan(avg(far))
  })

  it('handles edge cases without throwing', () => {
    expect(computeLayout([], [], 800, 600)).toEqual([])
    expect(computeLayout([{ id: 'only.md' }], [], 100, 100)).toHaveLength(1)
    expect(computeLayout(nodes, edges, 0, 600)).toEqual([])
    expect(computeLayout([{ id: 'a.md' }, { id: 'a.md' }], [], 200, 200)).toHaveLength(1)
  })
})

describe('computeLayoutChunked', () => {
  const nodes = [
    { id: 'a.md' },
    { id: 'b.md' },
    { id: 'c.md' },
    { id: 'd.md' },
  ]
  const edges = [
    { from: 'a.md', to: 'b.md' },
    { from: 'b.md', to: 'c.md' },
    { from: 'c.md', to: 'd.md' },
  ]

  it('returns the same coordinates as the synchronous layout for the same seed', async () => {
    const sync = computeLayout(nodes, edges, 800, 600, { seed: 7 })
    const chunked = await computeLayoutChunked(nodes, edges, 800, 600, { seed: 7 })
    expect(chunked).toEqual(sync)
  })

  it('is deterministic across runs', async () => {
    const first = await computeLayoutChunked(nodes, edges, 800, 600, { seed: 11 })
    const second = await computeLayoutChunked(nodes, edges, 800, 600, { seed: 11 })
    expect(first).toEqual(second)
  })

  it('handles empty and single-node graphs', async () => {
    expect(await computeLayoutChunked([], [], 800, 600)).toEqual([])
    expect(await computeLayoutChunked([{ id: 'only.md' }], [], 100, 100)).toHaveLength(1)
  })
})

describe('graphSignature', () => {
  it('is order-insensitive for the same structure', () => {
    const a = graphSignature(
      [{ id: 'a.md' }, { id: 'b.md' }],
      [{ from: 'a.md', to: 'b.md' }],
    )
    const b = graphSignature(
      [{ id: 'b.md' }, { id: 'a.md' }],
      [{ from: 'b.md', to: 'a.md' }],
    )
    expect(a).toBe(b)
  })

  it('changes when nodes or edges change', () => {
    const base = graphSignature([{ id: 'a.md' }, { id: 'b.md' }], [{ from: 'a.md', to: 'b.md' }])
    const moreNodes = graphSignature(
      [{ id: 'a.md' }, { id: 'b.md' }, { id: 'c.md' }],
      [{ from: 'a.md', to: 'b.md' }],
    )
    const moreEdges = graphSignature(
      [{ id: 'a.md' }, { id: 'b.md' }, { id: 'c.md' }],
      [{ from: 'a.md', to: 'b.md' }, { from: 'b.md', to: 'c.md' }],
    )
    expect(moreNodes).not.toBe(base)
    expect(moreEdges).not.toBe(base)
  })
})
