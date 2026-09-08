import { $remark } from '@milkdown/utils'

interface MdNode {
  type: string
  value?: string
  width?: number
  height?: number
  imageAlign?: string
  children?: MdNode[]
}

// Parse a trailing `{width=300 height=200 align=center}` block so the
// width/height/align become real node attrs instead of adjacent text. The
// imageDimMarkdown serializer emits width, then align, then height, but any
// order is accepted on input.
function parseDims(value: string): { width?: number; height?: number; align?: string } | null {
  const m = /^\{\s*([\s\w=]+?)\s*\}$/.exec(value)
  if (!m) return null
  const parts = m[1].split(/\s+/)
  let width: number | undefined
  let height: number | undefined
  let align: string | undefined
  for (const part of parts) {
    const w = /^width=(\d+)$/.exec(part)
    if (w) {
      width = Number(w[1])
      continue
    }
    const h = /^height=(\d+)$/.exec(part)
    if (h) {
      height = Number(h[1])
      continue
    }
    const a = /^align=(left|center|right)$/.exec(part)
    if (a) {
      align = a[1]
    }
  }
  if (width === undefined && height === undefined && align === undefined) return null
  return { width, height, align }
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
          height: dims.height ?? undefined,
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
