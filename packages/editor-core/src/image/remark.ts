import { $remark } from '@milkdown/utils'

interface MdNode {
  type: string
  value?: string
  width?: number
  imageAlign?: string
  children?: MdNode[]
}

// Parse a trailing `{width=300 align=center}` block so the width/align become
// real node attrs instead of adjacent text. Width is emitted before align by
// imageDimMarkdown, but we accept either order on input.
function parseDims(value: string): { width?: number; align?: string } | null {
  const m = /^\{\s*((?:width=\d+)\s*)?((?:align=(left|center|right))\s*)?\}$/.exec(value)
  if (!m) return null
  const width = m[1] ? Number(/width=(\d+)/.exec(m[1])![1]) : undefined
  const align = m[2] ? (/align=(left|center|right)/.exec(m[2])![1]) : undefined
  if (width === undefined && align === undefined) return null
  return { width, align }
}

function transform(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type === 'image') {
      const next = nodes[i + 1]
      const dims =
        next && next.type === 'text' && typeof next.value === 'string'
          ? parseDims(next.value)
          : null
      if (dims) {
        out.push({
          ...node,
          width: dims.width ?? undefined,
          imageAlign: dims.align ?? undefined,
        })
        i += 1
        continue
      }
      out.push(node)
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

export function imageDimMdast(tree: MdNode & { children: MdNode[] }): void {
  tree.children = transform(tree.children)
}

export const imageDimRemark = $remark<'imageDimRemark', Record<string, unknown>>(
  'imageDimRemark',
  () =>
    function imageDimRemark() {
      return imageDimMdast
    },
)
