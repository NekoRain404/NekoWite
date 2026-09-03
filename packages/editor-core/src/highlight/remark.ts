import { $remark } from '@milkdown/utils'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

// `==text==` is not a markdown special delimiter, so remark-parse leaves it
// as a single text value; split it here into an inline highlight container.
// The content cannot contain `=` (nesting is not supported — `==**x**==`
// arrives as three sibling nodes and only plain text is wrapped).
const HIGHLIGHT_RE = /==([^=\n]+)==/g

function splitHighlight(value: string): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  HIGHLIGHT_RE.lastIndex = 0
  while ((m = HIGHLIGHT_RE.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({ type: 'nekoHighlight', children: [{ type: 'text', value: m[1] }] })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function transform(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = []
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.value === 'string' && node.value.includes('==')) {
      out.push(...splitHighlight(node.value))
      continue
    }
    if (node.children && node.children.length > 0) {
      out.push({ ...node, children: transform(node.children) })
    } else {
      out.push(node)
    }
  }
  return out
}

export function highlightMdast(tree: MdNode & { children: MdNode[] }): void {
  tree.children = transform(tree.children)
}

export const highlightRemark = $remark<'highlightRemark', Record<string, unknown>>(
  'highlightRemark',
  () =>
    function highlightRemark() {
      return highlightMdast
    },
)
