import { $remark } from '@milkdown/utils'

import { openTagName } from './runs'
import { contentIndent, sourceBetween, sourceOf } from './source'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  /** `string | null`: an MDX fragment has no name, which is what `mdast`'s own
   *  `MdxJsxFlowElement` says about it once `remark-mdx` is in the program. */
  name?: string | null
  position?: {
    start: { offset?: number | undefined }
    end: { offset?: number | undefined }
  }
}

const OPEN_RE = /^<([A-Z][A-Za-z0-9]*)[^>]*>?$/
const CLOSE_RE = /^<\/([A-Z][A-Za-z0-9]*)>\s*$/
const SELF_CLOSE_RE = /^<([A-Z][A-Za-z0-9]*)[^>]*\/\s*>$/
const INLINE_BLOCK_RE = /^<([A-Z][A-Za-z0-9]*)[^>]*>([\s\S]*)<\/\1>$/

/** Also asked of an open tag the MDX parser could not pair, by `mask.ts`. */
export function isOpenTag(value: string): string | null {
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
  indent: number,
): MergeResult | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type !== 'html' || typeof node.value !== 'string') continue

    const selfClose = SELF_CLOSE_RE.exec(node.value)
    if (selfClose) {
      return {
        node: { type: 'mdxJsxFlowElement', name: selfClose[1], value: sourceOf(node, source, indent) },
        startIndex: i,
        endIndex: i,
      }
    }

    const inlineBlock = INLINE_BLOCK_RE.exec(node.value)
    if (inlineBlock) {
      return {
        node: { type: 'mdxJsxFlowElement', name: inlineBlock[1], value: sourceOf(node, source, indent) },
        startIndex: i,
        endIndex: i,
      }
    }

    const openName = isOpenTag(node.value)
    if (!openName) continue

    for (let j = i + 1; j < nodes.length; j++) {
      const cand = nodes[j]
      if (cand.type === 'html' && typeof cand.value === 'string' && isCloseTag(cand.value, openName)) {
        const value =
          sourceBetween(node, cand, source, indent) ??
          `${node.value}\n\n${nodes
            .slice(i + 1, j)
            .map((c) => (typeof c.value === 'string' ? c.value : ''))
            .join('\n\n')}\n\n${cand.value}`
        return { node: { type: 'mdxJsxFlowElement', name: openName, value }, startIndex: i, endIndex: j }
      }
    }
  }
  return null
}

/**
 * Rebuild an element whose open tag did not close inside its own block.
 *
 * A tag written across lines — `>` on a line of its own, the shape JSX authors
 * write — is not HTML to micromark, so it hands the tag back as TEXT and reads the
 * `>` line as a block of its own (an empty blockquote) with the body as another
 * paragraph. The element then reassembles as `<Callout\n  title="x"\n  kind="info"`
 * plus a blockquote plus a stray `</Callout>`, and every save rewrote it that way:
 * the component was escaped into literal text and the file gained markup the
 * author never typed.
 *
 * The element is one token to its author, so it is one node here: the source
 * between the tag's first character and its close tag is taken verbatim. The merge
 * only applies when the close tag ENDS the block that holds it — anything after it
 * would be deleted with the span.
 */
function tryMergeOpenTagSpan(
  nodes: MdNode[],
  start: number,
  source: string,
  indent: number,
): MergeResult | null {
  const first = nodes[start].children?.[0]
  if (first?.type !== 'text' || typeof first.value !== 'string') return null
  const name = openTagName(first.value)
  if (!name || first.position?.start.offset === undefined || !source) return null

  for (let j = start + 1; j < nodes.length; j++) {
    const closeEnd = closeTagEnd(nodes[j], name)
    if (closeEnd !== null) {
      const value = sourceBetween(first, nodes[j], source, indent)
      if (value === null) return null
      return {
        node: { type: 'html', value },
        startIndex: start,
        endIndex: j,
      }
    }
  }
  return null
}

/** End offset of the `</name>` that closes the element, when it is the last thing
 *  in `node`; otherwise null. A paragraph is searched because that is where a
 *  multi-line tag's closer lands. */
function closeTagEnd(node: MdNode, name: string): number | null {
  const candidates = node.type === 'paragraph' && node.children ? node.children : [node]
  const last = candidates[candidates.length - 1]
  if (
    last &&
    last.type === 'html' &&
    typeof last.value === 'string' &&
    isCloseTag(last.value, name)
  ) {
    return last.position?.end.offset ?? null
  }
  return null
}

/** The mdast types that carry a block of MDX source in `value` and that
 *  remark-stringify has no handler for, so they are written as `html`. */
const MDX_BLOCKS = new Set(['mdxJsxFlowElement', 'mdxFlowExpression', 'mdxjsEsm'])

/**
 * Write each block of MDX source back as raw HTML.
 *
 * `mdxJsxFlowElement` is this pass's own node type, and `mdxFlowExpression` /
 * `mdxjsEsm` are the MDX parser's: the editor's parse turns all three into an
 * `mdxComponent` node, but the save path re-parses its own output with plain
 * remark-stringify, which has no handler for any of them. Flattening to `html` —
 * which is what they are, source text — is what lets the save path write them
 * out verbatim instead of dropping them.
 */
export function flattenMdxElements(node: MdNode): void {
  if (!node.children) return
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (typeof child.value === 'string' && MDX_BLOCKS.has(child.type)) {
      node.children[i] = { type: 'html', value: child.value }
      continue
    }
    flattenMdxElements(child)
  }
}

// Contexts whose inline content is NOT a candidate for a whole-block component
// merge: a paragraph/list item may have a single component span the whole block,
// but a GFM table cell holds a component inside its own paragraph wrapper, and
// the mdxComponent node is a *block* atom that cannot live in that paragraph
// (Milkdown would throw "Cannot create node for paragraph"). Inside these
// contexts the JSX stays as raw `html` nodes so it is preserved verbatim.
const TEXT_BLOCK = new Set([
  'paragraph',
  'listItem',
  'tableCell',
  'tableHeader',
  // Phrasing containers. A block atom cannot be a child of any of these, so
  // converting the JSX to `mdxJsxFlowElement` here makes ProseMirror reject the
  // parent it belongs to ("Cannot create node for heading") — and milkdown
  // swallows that throw, so `open()` succeeds with a TRUNCATED document that the
  // next save writes over the file. `**[text <Callout />](url)` emptied the file
  // outright; `# Title <Callout />` dropped every other block in it. The JSX
  // stays a raw `html` node in these contexts instead: rendered as inline source
  // text, and written back verbatim.
  'heading',
  'emphasis',
  'strong',
  'delete',
  'link',
  'nekoHighlight',
])

function transform(
  nodes: MdNode[],
  file: { value?: unknown },
  inTextBlock = false,
  indent = 0,
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
      const merged = tryMergeComponent(node.children, source, indent)
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
      const single = tryMergeComponent([node], source, indent)
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
            const value =
              sourceBetween(node, cand, source, indent) ??
              `${node.value}\n\n${nodes
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

    // A tag whose `>` is in a later block (see `tryMergeOpenTagSpan`). Runs after
    // the two merges above, which handle the tags micromark could read.
    if (!inTextBlock && node.type === 'paragraph') {
      const span = tryMergeOpenTagSpan(nodes, i, source, indent)
      if (span) {
        out.push(span.node)
        i = span.endIndex + 1
        continue
      }
    }

    if (node.children && node.children.length > 0) {
      const childIsTextBlock = TEXT_BLOCK.has(node.type)
      // The container's own indent applies to everything inside it: a component
      // merged out of a blockquote's or a list item's children still carries the
      // block's prefix on its continuation lines.
      const childIndent = contentIndent(node, indent, source)
      out.push({ ...node, children: transform(node.children, file, childIsTextBlock, childIndent) })
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