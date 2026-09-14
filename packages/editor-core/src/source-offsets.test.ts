import { describe, expect, it } from 'vitest'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { citeMdast } from './cite/remark'
import { wikilinkMdast } from './wikilink/remark'
import { escapedMatchIndexes, valueToSourceOffsets } from './source-offsets'

/**
 * A text node's decoded VALUE is not its SOURCE spelling: `&amp;` is five source
 * characters and one value character, a `\[` escape is two and one, and the
 * indentation of a continuation line is dropped entirely. Both the citation and
 * the wikilink matcher ask the source whether a match was escaped — `\[@foo]`
 * is a literal, `[@foo]` is a citation — so a mapping that only accounts for
 * backslashes reports the wrong character for everything after the entity and a
 * deliberately escaped construct gets parsed as syntax.
 */

const parse = (md: string): never => unified().use(remarkParse).parse(md) as never

/** Every node type in the tree, depth-first. */
function nodeTypes(tree: { children?: unknown[] }): string[] {
  const out: string[] = []
  const walk = (node: { type?: string; children?: unknown[] }): void => {
    if (typeof node.type === 'string') out.push(node.type)
    for (const child of node.children ?? []) {
      if (child && typeof child === 'object') walk(child as { type?: string; children?: unknown[] })
    }
  }
  walk(tree)
  return out
}

describe('valueToSourceOffsets', () => {
  it('maps a plain run one to one', () => {
    const source = 'abc'
    const node = { value: 'abc', position: { start: { offset: 0 }, end: { offset: 3 } } }
    const map = valueToSourceOffsets(source, node)
    expect([...map.entries()]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ])
  })

  it('points an escaped character at its backslash', () => {
    const source = 'a \\[b'
    const node = { value: 'a [b', position: { start: { offset: 0 }, end: { offset: 5 } } }
    const map = valueToSourceOffsets(source, node)
    expect(map.get(0)).toBe(0)
    expect(map.get(2)).toBe(2) // the `[` was written `\[`
    expect(source[2]).toBe('\\')
  })

  it('stays aligned across an HTML entity', () => {
    const source = 'a &amp; b'
    const node = { value: 'a & b', position: { start: { offset: 0 }, end: { offset: 9 } } }
    const map = valueToSourceOffsets(source, node)
    expect(map.get(2)).toBe(2) // the decoded `&` starts the entity in the source
    expect(map.get(4)).toBe(8) // ... and the `b` is four source characters later
    expect(source[8]).toBe('b')
  })

  it('reports the escaped match after an entity', () => {
    const source = 'a &amp; \\[@foo]'
    const node = { value: 'a & [@foo]', position: { start: { offset: 0 }, end: { offset: 14 } } }
    const escaped = escapedMatchIndexes(/(?<!\\)\[@([^\]]+)\]/g, source, node)
    expect([...escaped]).toEqual([4])
    expect(source[8]).toBe('\\')
  })
})

describe('an escaped construct after an entity stays literal', () => {
  it('does not turn an escaped citation into a citation', () => {
    const md = 'a &amp; \\[@foo]\n'
    const tree = parse(md)
    citeMdast(tree, { value: md })
    expect(nodeTypes(tree)).not.toContain('nekoCite')
  })

  it('does not turn an escaped wikilink into a wikilink', () => {
    const md = 'a &amp; \\[[Note]]\n'
    const tree = parse(md)
    wikilinkMdast(tree, { value: md })
    expect(nodeTypes(tree)).not.toContain('nekoWikiLink')
  })

  it('still finds a real citation after an entity', () => {
    const md = 'a &amp; [@foo]\n'
    const tree = parse(md)
    citeMdast(tree, { value: md })
    expect(nodeTypes(tree)).toContain('nekoCite')
  })

  it('still finds a real wikilink after an entity', () => {
    const md = 'a &amp; [[Note]]\n'
    const tree = parse(md)
    wikilinkMdast(tree, { value: md })
    expect(nodeTypes(tree)).toContain('nekoWikiLink')
  })
})
