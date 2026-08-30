import { $remark } from '@milkdown/utils'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

const CITE_RE = /\[@([^\]]+)\]/g

function splitCite(value: string): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  CITE_RE.lastIndex = 0
  while ((m = CITE_RE.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({ type: 'nekoCite', value: m[0] })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function transform(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = []
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.value === 'string' && node.value.includes('[@')) {
      const parts = splitCite(node.value)
      if (parts.length > 1) {
        out.push(...parts)
        continue
      }
    }
    if (node.children && node.children.length > 0) {
      out.push({ ...node, children: transform(node.children) })
    } else {
      out.push(node)
    }
  }
  return out
}

export const citeRemark = $remark<'citeRemark', Record<string, unknown>>(
  'citeRemark',
  () =>
    function citeRemark() {
      return (tree) => {
        const root = tree as MdNode & { children: MdNode[] }
        root.children = transform(root.children)
      }
    },
)
