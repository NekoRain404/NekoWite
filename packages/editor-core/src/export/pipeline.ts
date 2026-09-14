import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import type { Root } from 'mdast'
import { citeMdast } from '../cite'
import { highlightMdast } from '../highlight/remark'
import { imageDimMdast } from '../image'
import { wikilinkMdast } from '../wikilink/remark'
import { mdxJsxMdast } from '../mdx'

/**
 * Raw markdown in, the export's mdast out.
 *
 * This module owns the tree shape (`TransformNode` / `RenderNode`) as well as
 * the pipeline that produces it, because it is the only module that builds these
 * nodes: `render.ts` consumes them and never invents one. Keeping the types here
 * is also what lets the renderer import `parseFragment` — a component body is
 * re-parsed at render time — without the two modules importing each other.
 */

export interface TransformNode {
  type: string
  value?: string
  children?: TransformNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

export interface RenderNode extends TransformNode {
  depth?: number
  lang?: string
  url?: string
  alt?: string
  ordered?: boolean
  start?: number
  align?: (string | null)[]
  name?: string
  title?: string
  width?: number
  /** Stored height, set by a shift-resize or written by hand as `{height=N}`.
   *  It was missing from this type, which is exactly why the renderer ignored
   *  it: the editor applies both dimensions (nodeView's `applyDims`) and the
   *  export applied only the width, so a sized image came out at the wrong
   *  proportions. */
  height?: number
  imageAlign?: string
  identifier?: string
  /** GFM task-list state on a `listItem`: true / false / null (not a task). */
  checked?: boolean | null
  /** Visible label of a GFM footnote (the text after `[^`). */
  label?: string
  /** `nekoWikiLink` target, i.e. the part before `|` in `[[target|alias]]`. */
  target?: string
  /** `nekoWikiLink` alias; empty when the wikilink has no `|` part. */
  alias?: string
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkMath)
  .use(() => (tree: Root, file: { value?: unknown }) => {
    const t = tree as unknown as TransformNode & { children: TransformNode[] }
    mdxJsxMdast(t, file)
    citeMdast(t, file)
    // `==highlight==` and `[[wikilink]]` are editor extensions, not markdown:
    // remark-parse leaves them as literal text. Without these two passes the
    // renderer received raw `==`/`[[ ]]` text instead of the node types it
    // renders, so the export disagreed with the editor it came from.
    highlightMdast(t)
    wikilinkMdast(t, file)
    stripEmptyLineMarkers(t)
    resolveReferences(t)
    imageDimMdast(t)
  })

/** The `<br>` spellings `visitEmptyLine` in @milkdown/preset-commonmark treats
 *  as an empty-paragraph marker. */
const EMPTY_LINE_MARKERS = new Set(['<br />', '<br>', '<br >', '<br/>'])

function isEmptyLineMarker(node: TransformNode): boolean {
  return node.type === 'html' && EMPTY_LINE_MARKERS.has((node.value ?? '').trim())
}

/**
 * Drop the empty-paragraph markers the editor writes to disk.
 *
 * Milkdown serializes an empty paragraph as a standalone `<br />` so an
 * intentional blank line survives a reopen, and removes it again while parsing
 * (`visitEmptyLine`) — so the editor never shows it. The export parses the raw
 * file without that step, so the marker reached the renderer as an ordinary
 * `html` node and was escaped into visible text: `&lt;br /&gt;`. Empty table
 * cells showed it most, because a cell's empty content is exactly what the
 * serializer writes a marker for.
 *
 * A marker is block-level when it is NOT a child of a paragraph — that is the
 * shape remark produces for a marker standing on its own line (a direct child of
 * `root`, a table cell, a blockquote, …). Inside a paragraph the same `<br>`
 * written next to text is the author's inline HTML, which keeps the `html`
 * case's escaping like any other raw HTML; a paragraph whose only child is the
 * marker is an empty paragraph and is emptied rather than printed.
 */
function stripEmptyLineMarkers(node: TransformNode): void {
  if (!Array.isArray(node.children)) return
  const children = node.children
  const blockLevel = node.type !== 'paragraph'
  node.children = children.filter(
    (child) => !isEmptyLineMarker(child) || (!blockLevel && !children.every(isEmptyLineMarker)),
  )
  for (const child of node.children) stripEmptyLineMarkers(child)
}

/** Resolve reference-style links/images (`[text][ref]`, `![alt][ref]`) to their
 *  `[ref]: url` definitions so exported HTML keeps the hyperlink/image src.
 *  Definitions are collected globally first (they may follow their uses);
 *  unresolvable references degrade to plain text / nothing. Component bodies
 *  stay opaque (re-parsed at render time, where definitions resolve locally). */
function resolveReferences(node: TransformNode): void {
  const children = Array.isArray(node.children) ? node.children : []
  const defs = new Map<string, { url: string; title?: string }>()
  const collect = (list: TransformNode[]): void => {
    for (const node of list) {
      if (node.type === 'mdxJsxFlowElement') continue
      if (node.type === 'definition') {
        const d = node as RenderNode
        const id = d.identifier ?? ''
        if (id && typeof d.url === 'string' && !defs.has(id)) {
          defs.set(id, { url: d.url, title: d.title })
        }
      }
      if (Array.isArray(node.children)) collect(node.children)
    }
  }
  const walk = (list: TransformNode[]): void => {
    for (const node of list) {
      if (node.type === 'mdxJsxFlowElement') continue
      const r = node as RenderNode
      if (r.type === 'linkReference' && typeof r.identifier === 'string') {
        const def = defs.get(r.identifier)
        if (def) {
          r.type = 'link'
          r.url = def.url
          r.title = def.title
        }
      } else if (r.type === 'imageReference' && typeof r.identifier === 'string') {
        const def = defs.get(r.identifier)
        if (def) {
          r.type = 'image'
          r.url = def.url
          r.title = def.title
        }
      }
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  collect(children)
  walk(children)
}

export function parseChildren(markdown: string): RenderNode[] {
  const tree = processor.parse(markdown)
  const result = processor.runSync(tree, markdown) as unknown as RenderNode
  return (result.children ?? []) as RenderNode[]
}

/** Parse a fragment that has already been through the pipeline once — an mdx
 *  component body, which the renderer re-parses from its raw source so the node
 *  types inside it come from the same transforms as the document's. */
export function parseFragment(source: string): RenderNode[] {
  const tree = processor.parse(source)
  const result = processor.runSync(tree, source) as unknown as RenderNode
  return (result.children ?? []) as RenderNode[]
}
