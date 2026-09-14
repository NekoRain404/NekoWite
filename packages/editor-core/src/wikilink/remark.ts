import { $remark } from '@milkdown/utils'

import { escapedMatchIndexes } from '../source-offsets'

interface MdNode {
  type: string
  value?: string
  target?: string
  alias?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MdNode[]
}

// `[[target|alias]]` is not standard markdown; remark-parse keeps it as literal
// text. Split it here into a nekoWikiLink node. The negative lookbehind is a
// first line of defence; the real work uses the raw source (see below).
const WIKILINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g

// remark-parse consumes `\[` escapes before the remark plugin runs, so a
// literal `\[[a]]` arrives as value `[[a]]`. To tell it from a real wikilink we
// consult the source markdown and check whether the matching `[[` was
// backslash-escaped at its source offset — the same mapping cite/remark.ts
// uses, shared so an entity early in the run cannot desynchronise one twin and
// leave the other correct (see `source-offsets.ts`).
function escapedIndexes(source: string, node: MdNode): Set<number> {
  return escapedMatchIndexes(WIKILINK_RE, source, node)
}

function splitWikilink(value: string, escaped: Set<number>): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((m = WIKILINK_RE.exec(value)) !== null) {
    if (escaped.has(m.index)) continue
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({ type: 'nekoWikiLink', target: m[1], alias: m[2] ?? '' })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function transform(nodes: MdNode[], source: string): MdNode[] {
  const out: MdNode[] = []
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.value === 'string' && node.value.includes('[[')) {
      const escaped = escapedIndexes(source, node)
      const parts = splitWikilink(node.value, escaped)
      if (parts.length >= 1) {
        out.push(...parts)
        continue
      }
    }
    if (node.children && node.children.length > 0) {
      out.push({ ...node, children: transform(node.children, source) })
    } else {
      out.push(node)
    }
  }
  return out
}

export function wikilinkMdast(
  tree: MdNode & { children: MdNode[] },
  file: { value?: unknown },
): void {
  const source = typeof file?.value === 'string' ? file.value : ''
  tree.children = transform(tree.children, source)
}

export const wikilinkRemark = $remark<'wikilinkRemark', Record<string, unknown>>(
  'wikilinkRemark',
  () =>
    function wikilinkRemark() {
      return wikilinkMdast
    },
)
