import { describe, expect, it } from 'vitest'
import {
  buildLinkGraph,
  buildLinkGraphDetailed,
  computeLayout,
  computeLayoutChunked,
  extractLinks,
  extractLinksDetailed,
  findBrokenLinks,
  graphSignature,
  orphanNodes,
  refreshNode,
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

  it('resolves a sibling-dir wiki link to the note in the same directory, not a same-name root note', () => {
    const paths = ['note.md', 'folder/note.md', 'folder/other.md']
    // From a note inside folder/, the wikilink resolves to the sibling note in
    // the same directory even though a root-level note shares its filename.
    expect(resolveLinkPath('folder/other.md', 'note', paths)).toBe('folder/note.md')
  })

  it('chooses deterministically between same-name notes, independent of input order', () => {
    const paths = ['guides/quick start.md', 'docs/quick start.md']
    expect(resolveLinkPath('a.md', 'quick start', paths)).toBe('docs/quick start.md')
    // Reversing the input order must not change the winner (no "first by array
    // order" fallback).
    expect(resolveLinkPath('a.md', 'quick start', [...paths].reverse())).toBe(
      'docs/quick start.md',
    )
  })

  it('prefers the same-name note whose directory best matches the source note', () => {
    const paths = ['a/proj.md', 'x/p1/proj.md', 'x/y/sub/proj.md']
    // Exact sibling (x/y/proj.md) does not exist; among the same-name notes the
    // one sharing the most leading directories (x/y/sub/proj.md) wins.
    expect(resolveLinkPath('x/y/note.md', 'proj', paths)).toBe('x/y/sub/proj.md')
  })

  it('anchors a leading-slash link to the vault root, not the note directory', () => {
    const paths = ['guides/quick start.md', 'docs/quick start.md']
    // /guides/quick start means vault-root guides/; it must NOT be resolved
    // against the source note's docs/ directory (docs/guides/… does not exist).
    expect(resolveLinkPath('docs/a.md', '/guides/quick start', paths)).toBe(
      'guides/quick start.md',
    )
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

describe('extractLinksDetailed', () => {
  it('records the link kind and display text', () => {
    expect(extractLinksDetailed('[[笔记A]] 与 [[带别名|别名]] 与 [标签](note.md)')).toEqual([
      { target: '笔记A', kind: 'wiki', text: '' },
      { target: '带别名', kind: 'wiki', text: '别名' },
      { target: 'note.md', kind: 'markdown', text: '标签' },
    ])
  })

  it('matches extractLinks for targets (kind is the only extra field)', () => {
    const md = '[[a]] [b](./b.md)'
    expect(extractLinks(md)).toEqual(['a', './b.md'])
    expect(extractLinksDetailed(md).map((l) => l.target)).toEqual(['a', './b.md'])
  })
})

describe('buildLinkGraphDetailed', () => {
  it('tracks edge kind and collects broken link targets', () => {
    const g = buildLinkGraphDetailed([
      { path: 'a.md', content: '[[b]] [c](c.md) [[不存在]]' },
      { path: 'b.md', content: '[[a]]' },
      { path: 'c.md', content: '' },
    ])
    expect(g.edges).toEqual([
      { from: 'a.md', to: 'b.md', kind: 'wiki' },
      { from: 'a.md', to: 'c.md', kind: 'markdown' },
      { from: 'b.md', to: 'a.md', kind: 'wiki' },
    ])
    expect(g.broken).toEqual([{ from: 'a.md', target: '不存在', text: '' }])
  })

  it('keeps orphan nodes (degree 0) in the node list', () => {
    const g = buildLinkGraphDetailed([
      { path: 'hub.md', content: '[[孤岛]]' },
      { path: '孤岛.md', content: '没有任何链接' },
    ])
    const nodes = g.nodes.map((n) => n.id)
    expect(nodes).toContain('孤岛.md')
    expect(g.nodes.find((n) => n.id === '孤岛.md')?.degree).toBe(1)
  })
})

describe('orphanNodes', () => {
  it('returns only the degree-0 nodes', () => {
    const graph = buildLinkGraphDetailed([
      { path: 'hub.md', content: '[[a]]' },
      { path: 'a.md', content: '[[hub]]' },
      { path: 'orphan.md', content: '' },
    ])
    expect(orphanNodes(graph).map((n) => n.id)).toEqual(['orphan.md'])
  })
})

describe('findBrokenLinks', () => {
  it('lists every target that resolves to no note', () => {
    const broken = findBrokenLinks([
      { path: 'a.md', content: '[[ok]] [[missing]] [x](./nope.md)' },
      { path: 'ok.md', content: '' },
    ])
    expect(broken).toEqual([
      { from: 'a.md', target: 'missing', text: '' },
      { from: 'a.md', target: './nope.md', text: 'x' },
    ])
  })
})

describe('refreshNode (incremental)', () => {
  const allPaths = ['a.md', 'b.md', 'c.md']

  it('refreshes only the changed note out-edges, keeping its in-edges', () => {
    const initial = buildLinkGraphDetailed([
      { path: 'a.md', content: '[[b]] [[c]]' },
      { path: 'b.md', content: '[[a]]' },
      { path: 'c.md', content: '' },
    ])
    const updated = refreshNode(initial, 'a.md', '[[b]] only', allPaths)
    // a loses its edge to c but keeps b's incoming edge (b→a).
    expect(updated.edges).toHaveLength(2)
    expect(updated.edges).toContainEqual({ from: 'a.md', to: 'b.md', kind: 'wiki' })
    expect(updated.edges).toContainEqual({ from: 'b.md', to: 'a.md', kind: 'wiki' })
    expect(updated.nodes.find((n) => n.id === 'a.md')?.degree).toBe(2)
    expect(updated.nodes.find((n) => n.id === 'b.md')?.degree).toBe(2)
    expect(updated.nodes.find((n) => n.id === 'c.md')?.degree).toBe(0)
  })

  it('adds a new node and edges when the note is created', () => {
    const initial = buildLinkGraphDetailed([
      { path: 'a.md', content: '[x](a.md)' },
    ])
    const updated = refreshNode(initial, 'd.md', '[[a]]', ['a.md', 'd.md'])
    expect(updated.nodes.map((n) => n.id)).toContain('d.md')
    expect(updated.edges).toContainEqual({ from: 'd.md', to: 'a.md', kind: 'wiki' })
  })

  it('deletes the node and every edge touching it when content is null', () => {
    const initial = buildLinkGraphDetailed([
      { path: 'a.md', content: '[[b]]' },
      { path: 'b.md', content: '[[a]]' },
      { path: 'c.md', content: '' },
    ])
    const updated = refreshNode(initial, 'b.md', null, allPaths)
    expect(updated.nodes.map((n) => n.id).sort()).toEqual(['a.md', 'c.md'])
    expect(updated.edges).toEqual([])
    // Both a→b and b→a are removed, so a is now orphaned (degree 0).
    expect(updated.nodes.find((n) => n.id === 'a.md')?.degree).toBe(0)
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
