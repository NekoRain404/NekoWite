import { $remark } from '@milkdown/utils'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  name?: string
  position?: {
    start: { offset?: number | undefined }
    end: { offset?: number | undefined }
  }
}

const OPEN_RE = /^<([A-Z][A-Za-z0-9]*)[^>]*>?$/
const CLOSE_RE = /^<\/([A-Z][A-Za-z0-9]*)>\s*$/
const SELF_CLOSE_RE = /^<([A-Z][A-Za-z0-9]*)[^>]*\/\s*>$/
const INLINE_BLOCK_RE = /^<([A-Z][A-Za-z0-9]*)[^>]*>([\s\S]*)<\/\1>$/

function isOpenTag(value: string): string | null {
  const m = OPEN_RE.exec(value)
  return m ? m[1] : null
}

function isCloseTag(value: string, name: string): boolean {
  const m = CLOSE_RE.exec(value)
  return m !== null && m[1] === name
}

interface MergeResult {
  node: MdNode
  startIndex: number
  endIndex: number
}

function tryMergeComponent(
  nodes: MdNode[],
  source: string,
): MergeResult | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type !== 'html' || typeof node.value !== 'string') continue

    const selfClose = SELF_CLOSE_RE.exec(node.value)
    if (selfClose) {
      return {
        node: { type: 'mdxJsxFlowElement', name: selfClose[1], value: node.value },
        startIndex: i,
        endIndex: i,
      }
    }

    const inlineBlock = INLINE_BLOCK_RE.exec(node.value)
    if (inlineBlock) {
      return {
        node: { type: 'mdxJsxFlowElement', name: inlineBlock[1], value: node.value },
        startIndex: i,
        endIndex: i,
      }
    }

    const openName = isOpenTag(node.value)
    if (!openName) continue

    for (let j = i + 1; j < nodes.length; j++) {
      const cand = nodes[j]
      if (cand.type === 'html' && typeof cand.value === 'string' && isCloseTag(cand.value, openName)) {
        const openStart = node.position?.start.offset
        const closeEnd = cand.position?.end.offset
        let value: string
        if (openStart !== undefined && closeEnd !== undefined && source) {
          value = source.slice(openStart, closeEnd)
        } else {
          const body = nodes
            .slice(i + 1, j)
            .map((c) => (typeof c.value === 'string' ? c.value : ''))
            .join('\n\n')
          value = `${node.value}\n\n${body}\n\n${cand.value}`
        }
        return { node: { type: 'mdxJsxFlowElement', name: openName, value }, startIndex: i, endIndex: j }
      }
    }
  }
  return null
}

const TEXT_BLOCK = new Set(['paragraph', 'listItem'])

function transform(
  nodes: MdNode[],
  file: { value?: unknown },
  inTextBlock = false,
): MdNode[] {
  const out: MdNode[] = []
  const source = typeof file.value === 'string' ? file.value : ''
  let i = 0
  while (i < nodes.length) {
    const node = nodes[i]

    if (
      !inTextBlock &&
      node.type === 'paragraph' &&
      node.children &&
      node.children.length > 0
    ) {
      const merged = tryMergeComponent(node.children, source)
      if (
        merged &&
        merged.startIndex === 0 &&
        merged.endIndex === node.children.length - 1
      ) {
        out.push(merged.node)
        i += 1
        continue
      }
    }

    if (!inTextBlock) {
      const single = tryMergeComponent([node], source)
      if (single) {
        out.push(single.node)
        i += 1
        continue
      }
    }

    if (
      !inTextBlock &&
      node.type === 'html' &&
      typeof node.value === 'string'
    ) {
      const openName = isOpenTag(node.value)
      if (openName) {
        let found = false
        for (let j = i + 1; j < nodes.length; j++) {
          const cand = nodes[j]
          if (
            cand.type === 'html' &&
            typeof cand.value === 'string' &&
            isCloseTag(cand.value, openName)
          ) {
            const openStart = node.position?.start.offset
            const closeEnd = cand.position?.end.offset
            const value =
              openStart !== undefined && closeEnd !== undefined && source
                ? source.slice(openStart, closeEnd)
                : `${node.value}\n\n${nodes
                    .slice(i + 1, j)
                    .map((c) => (typeof c.value === 'string' ? c.value : ''))
                    .join('\n\n')}\n\n${cand.value}`
            out.push({ type: 'mdxJsxFlowElement', name: openName, value })
            i = j + 1
            found = true
            break
          }
        }
        if (found) continue
      }
    }

    if (node.children && node.children.length > 0) {
      const childIsTextBlock = TEXT_BLOCK.has(node.type)
      out.push({ ...node, children: transform(node.children, file, childIsTextBlock) })
    } else {
      out.push(node)
    }
    i += 1
  }
  return out
}

export function mdxJsxMdast(
  tree: MdNode & { children: MdNode[] },
  file: { value?: unknown },
): void {
  tree.children = transform(tree.children, file)
}

const mdxJsxRemark = $remark<'mdxJsxRemark', Record<string, unknown>>(
  'mdxJsxRemark',
  () =>
    function mdxJsxRemark() {
      return mdxJsxMdast
    },
)

export { mdxJsxRemark }