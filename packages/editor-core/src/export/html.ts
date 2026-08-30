// Referenced so consumer packages compiling this source see the ?inline module type.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./css.d.ts" />
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import katex from 'katex'
import katexCss from 'katex/dist/katex.min.css?inline'
import type { Root } from 'mdast'
import { citeMdast } from '../cite'
import { mdxJsxMdast, parseMdxTag } from '../mdx'

export interface ExportRef {
  key: string
  title?: string
  authors?: string[]
  year?: string
}

export type ComponentRenderer = (
  props: Record<string, string>,
  childrenHtml: string,
) => string

export interface RenderDocumentOptions {
  title?: string
  refs?: Map<string, ExportRef>
  componentRenderers?: Record<string, ComponentRenderer>
  math?: 'katex' | 'text'
  includeCss?: boolean
}

interface TransformNode {
  type: string
  value?: string
  children?: TransformNode[]
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

interface RenderNode extends TransformNode {
  depth?: number
  lang?: string
  url?: string
  alt?: string
  ordered?: boolean
  start?: number
  align?: (string | null)[]
  name?: string
}

interface RenderContext {
  math: 'katex' | 'text'
  refs?: Map<string, ExportRef>
  componentRenderers?: Record<string, ComponentRenderer>
  citeNumbers: Map<string, number>
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
  })

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function citeKey(value: string): string {
  return value.replace(/^\[@/, '').replace(/\]$/, '')
}

function collectCiteOrder(nodes: RenderNode[], numbers: Map<string, number>): void {
  for (const node of nodes) {
    if (node.type === 'nekoCite' && typeof node.value === 'string') {
      const key = citeKey(node.value)
      if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
    } else if (
      node.type === 'mdxJsxFlowElement' &&
      typeof node.value === 'string'
    ) {
      const { children } = parseMdxTag(node.value)
      if (children) collectCiteOrder(parseFragment(children), numbers)
    }
    if (node.children) collectCiteOrder(node.children as RenderNode[], numbers)
  }
}

function parseFragment(source: string): RenderNode[] {
  const tree = processor.parse(source)
  const result = processor.runSync(tree, source) as unknown as RenderNode
  return (result.children ?? []) as RenderNode[]
}

function renderChildren(nodes: RenderNode[], ctx: RenderContext): string {
  return nodes.map((node) => renderNode(node, ctx)).join('')
}

function renderMath(node: RenderNode, ctx: RenderContext, display: boolean): string {
  const value = node.value ?? ''
  if (ctx.math === 'text') {
    const delim = display ? '$$' : '$'
    const inner = `${delim}${escapeHtml(value)}${delim}`
    return display
      ? `<div class="math-latex">${inner}</div>`
      : `<span class="math-latex">${inner}</span>`
  }
  let html = ''
  try {
    html = katex.renderToString(value, { displayMode: display, throwOnError: false })
  } catch {
    html = ''
  }
  if (!html) {
    const inner = `$${escapeHtml(value)}$`
    return `<span class="math-latex">${inner}</span>`
  }
  return display
    ? `<div class="math-display">${html}</div>`
    : `<span class="math-inline">${html}</span>`
}

function renderMdx(node: RenderNode, ctx: RenderContext): string {
  const raw = typeof node.value === 'string' ? node.value : ''
  const { name, props, children } = parseMdxTag(raw)
  const renderer = ctx.componentRenderers?.[name]
  if (renderer) {
    const childrenHtml = renderChildren(parseFragment(children), ctx)
    return renderer(props, childrenHtml)
  }
  return `<div class="mdx-fallback">${escapeHtml(raw)}</div>`
}

function renderList(node: RenderNode, ctx: RenderContext): string {
  const tag = node.ordered ? 'ol' : 'ul'
  const start = node.ordered && typeof node.start === 'number' && node.start !== 1
    ? ` start="${node.start}"`
    : ''
  const items = (node.children ?? [])
    .map((item) => `<li>${renderChildren(item.children as RenderNode[] ?? [], ctx)}</li>`)
    .join('')
  return `<${tag}${start}>${items}</${tag}>`
}

function renderTable(node: RenderNode, ctx: RenderContext): string {
  const rows = (node.children ?? []) as RenderNode[]
  let html = '<table>'
  rows.forEach((row, i) => {
    const cells = (row.children ?? []) as RenderNode[]
    const tag = i === 0 ? 'th' : 'td'
    const cellHtml = cells
      .map((cell) => `<${tag}>${renderChildren((cell.children ?? []) as RenderNode[], ctx)}</${tag}>`)
      .join('')
    const wrapper = i === 0 ? 'thead' : 'tbody'
    html += `<${wrapper}><tr>${cellHtml}</tr></${wrapper}>`
  })
  return `${html}</table>`
}

function renderNode(node: RenderNode, ctx: RenderContext): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value ?? '')
    case 'root':
      return renderChildren((node.children ?? []) as RenderNode[], ctx)
    case 'paragraph':
      return `<p>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</p>`
    case 'heading': {
      const level = Math.min(Math.max(node.depth ?? 1, 1), 6)
      return `<h${level}>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</h${level}>`
    }
    case 'emphasis':
      return `<em>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</em>`
    case 'strong':
      return `<strong>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</strong>`
    case 'delete':
      return `<del>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</del>`
    case 'inlineCode':
      return `<code>${escapeHtml(node.value ?? '')}</code>`
    case 'code': {
      const lang = node.lang ? ` class="language-${escapeHtml(node.lang)}"` : ''
      return `<pre><code${lang}>${escapeHtml(node.value ?? '')}</code></pre>`
    }
    case 'blockquote':
      return `<blockquote>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</blockquote>`
    case 'link':
      return `<a href="${escapeHtml(node.url ?? '')}">${renderChildren((node.children ?? []) as RenderNode[], ctx)}</a>`
    case 'image':
      return `<img src="${escapeHtml(node.url ?? '')}" alt="${escapeHtml(node.alt ?? '')}">`
    case 'list':
      return renderList(node, ctx)
    case 'listItem':
      return `<li>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</li>`
    case 'thematicBreak':
      return '<hr>'
    case 'table':
      return renderTable(node, ctx)
    case 'tableRow':
      return `<tr>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</tr>`
    case 'tableCell':
      return `<td>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</td>`
    case 'yaml':
      return `<pre class="frontmatter">${escapeHtml(node.value ?? '')}</pre>`
    case 'inlineMath':
      return renderMath(node, ctx, false)
    case 'displayMath':
      return renderMath(node, ctx, true)
    case 'nekoCite': {
      const key = citeKey(node.value ?? '')
      const number = ctx.citeNumbers.get(key) ?? ctx.citeNumbers.size + 1
      return `<span class="cite">${number}</span>`
    }
    case 'mdxJsxFlowElement':
      return renderMdx(node, ctx)
    case 'html':
      return escapeHtml(node.value ?? '')
    default:
      return renderChildren((node.children ?? []) as RenderNode[], ctx)
  }
}

function parseTitle(nodes: RenderNode[]): string | undefined {
  for (const node of nodes) {
    if (node.type !== 'yaml' || typeof node.value !== 'string') continue
    const m = /^title:\s*(.*?)\s*$/m.exec(node.value)
    if (m) {
      return m[1].replace(/^['"]|['"]$/g, '')
    }
  }
  return undefined
}

function renderReferences(order: string[], ctx: RenderContext): string {
  if (order.length === 0) return ''
  const items = order
    .map((key, i) => {
      const n = i + 1
      const ref = ctx.refs?.get(key)
      if (ref) {
        const meta: string[] = []
        if (ref.authors?.length) meta.push(ref.authors.join(', '))
        if (ref.year) meta.push(ref.year)
        const text = ref.title
          ? `${key} — ${ref.title}${meta.length ? ` (${meta.join(', ')})` : ''}`
          : `${key}${meta.length ? ` (${meta.join(', ')})` : ''}`
        return `<li>[${n}] ${escapeHtml(text)}</li>`
      }
      return `<li>[${n}] ${escapeHtml(key)}</li>`
    })
    .join('')
  return `<section class="references"><h2>参考文献</h2><ol>${items}</ol></section>`
}

const printCss = `
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; max-width: 50rem; margin: 0 auto; padding: 2rem; color: #222; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: #f6f8fa; padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }
blockquote { margin: 0; padding-left: 1rem; border-left: 4px solid #d0d7de; color: #57606a; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.7rem; }
th { background: #f6f8fa; }
.cite { color: #0969da; }
.cite::before { content: '['; }
.cite::after { content: ']'; }
.math-display { overflow-x: auto; }
.references { margin-top: 3rem; border-top: 1px solid #d0d7de; padding-top: 1rem; }
.references ol { padding-left: 1.5rem; }
.callout { border-left: 4px solid #0969da; background: #f6f8fa; padding: 0.75rem 1rem; margin: 1rem 0; }
.callout-body { margin: 0; }
.mdx-fallback { border: 1px dashed #d0d7de; padding: 0.5rem 0.75rem; color: #57606a; }
.frontmatter { background: #f6f8fa; padding: 0.75rem 1rem; border-radius: 6px; color: #57606a; }
`

export function renderDocument(markdown: string, opts?: RenderDocumentOptions): string {
  const math = opts?.math ?? 'katex'
  const tree = processor.parse(markdown)
  const result = processor.runSync(tree, markdown) as unknown as RenderNode
  const children = (result.children ?? []) as RenderNode[]

  const citeNumbers = new Map<string, number>()
  collectCiteOrder(children, citeNumbers)

  const ctx: RenderContext = {
    math,
    refs: opts?.refs,
    componentRenderers: opts?.componentRenderers,
    citeNumbers,
  }

  const body = renderChildren(children, ctx)
  const references = renderReferences(Array.from(citeNumbers.keys()), ctx)

  const title = opts?.title ?? parseTitle(children) ?? 'Untitled'
  const style =
    opts?.includeCss === false
      ? ''
      : `<style>${math === 'katex' ? katexCss : ''}${printCss}</style>`

  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title>${style}</head><body>` +
    `${body}${references}</body></html>`
  )
}
