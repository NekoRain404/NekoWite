import { $remark } from '@milkdown/utils'

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
// map each text node's value index back to a source offset.
function escapedCiteIndexes(source: string, node: MdNode): Set<number> {
  const escaped = new Set<number>()
  const pos = node.position
  const value = node.value
  if (!pos || typeof value !== 'string' || source.length === 0) return escaped
  const start = pos.start.offset
  const end = pos.end.offset
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end > source.length) {
    return escaped
  }
  const valueToSource = new Map<number, number>()
  let vi = 0
  let si = start
  while (si < end && vi < value.length) {
    const ch = source[si]
    if (ch === '\\' && si + 1 < end) {
      valueToSource.set(vi, si)
      si += 2
    } else {
      valueToSource.set(vi, si)
      si += 1
    }
    vi++
  }
  CITE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CITE_RE.exec(value)) !== null) {
    const so = valueToSource.get(m.index)
    if (so !== undefined && source[so] === '\\') escaped.add(m.index)
  }
  return escaped
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
