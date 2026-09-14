import { $remark } from '@milkdown/utils'

import { escapedMatchIndexes } from '../source-offsets'

interface MdNode {
  type: string
  value?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MdNode[]
}

// Negative lookbehind so a literal `\[@` (when the backslash survives to the
// mdast value) is not parsed as a citation.
const CITE_RE = /(?<!\\)\[@([^\]]+)\]/g

// remark-parse consumes `\[` escapes before citeRemark sees the tree, so the
// mdast value no longer carries the backslash. To tell an escaped `\[@foo]`
// from a real `[@foo]` we consult the raw markdown (the `file` argument) and
// map each text node's value index back to a source offset — the mapping, and
// why it has to cope with more than escapes, lives in `source-offsets.ts`.
function escapedCiteIndexes(source: string, node: MdNode): Set<number> {
  return escapedMatchIndexes(CITE_RE, source, node)
}

function splitCite(value: string, escaped: Set<number>): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  CITE_RE.lastIndex = 0
  while ((m = CITE_RE.exec(value)) !== null) {
    if (escaped.has(m.index)) continue
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({ type: 'nekoCite', value: m[0] })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function transform(nodes: MdNode[], source: string): MdNode[] {
  const out: MdNode[] = []
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.value === 'string' && node.value.includes('[@')) {
      const escaped = escapedCiteIndexes(source, node)
      const parts = splitCite(node.value, escaped)
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

export function citeMdast(
  tree: MdNode & { children: MdNode[] },
  file: { value?: unknown },
): void {
  const source = typeof file?.value === 'string' ? file.value : ''
  tree.children = transform(tree.children, source)
}

export const citeRemark = $remark<'citeRemark', Record<string, unknown>>(
  'citeRemark',
  () =>
    function citeRemark() {
      return citeMdast
    },
)
