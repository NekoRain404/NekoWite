// Referenced so consumer packages compiling this source see the ?inline module type.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./css.d.ts" />
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import type { Root } from 'mdast'
import { citeMdast } from '../cite'
import { imageDimMdast } from '../image'
import { mdxJsxMdast, parseMdxTag } from '../mdx'

// KaTeX is only needed at export time (the editor preview renders math via
// MathLive / the app's own renderer). Loading it lazily keeps the startup
// import graph free of ~1MB of math machinery. The async `renderDocumentAsync`
// always awaits the lazy load before rendering; the sync `renderDocument` can
// only render math if KaTeX is ALREADY loaded in this process (e.g. a prior
// async render or an explicit preload). If math is present but KaTeX is not
// yet loaded, the sync path throws a clear, actionable error rather than
// silently emitting raw LaTeX. Documents without math never touch KaTeX and
// stay byte-for-byte identical across both render entry points.
// The KaTeX CSS is pulled in the same lazy way (via `?inline`, so the fonts
// stay data: URIs and the exported HTML is self-contained) rather than being
// statically imported, which would drag the whole vendor-katex chunk into the
// entry's modulepreload graph.
let katexModule: (typeof import('katex'))['default'] | null = null
let katexCss = ''

async function loadKatex(): Promise<void> {
  if (katexModule) return
  const [mod, cssMod] = await Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css?inline'),
  ])
  katexModule = mod.default ?? mod
  katexCss = cssMod.default ?? cssMod
}

export interface ExportRef {
  key: string
  title?: string
  authors?: string[]
  year?: string
  doi?: string
  journal?: string
  volume?: string
  issue?: string
  pages?: string
  publisher?: string
  url?: string
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
  /** Async display-URL resolver for image srcs (e.g. vault-relative
   * attachment paths). Only used by the async render entry point. */
  resolveImage?: (src: string) => Promise<string>
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
  title?: string
  width?: number
  imageAlign?: string
  identifier?: string
}

interface RenderContext {
  math: 'katex' | 'text'
  refs?: Map<string, ExportRef>
  componentRenderers?: Record<string, ComponentRenderer>
  citeNumbers: Map<string, number>
  // When true, nekoCite nodes render their literal `[@key]` source text
  // instead of a number. Mirrors the editor, which treats an mdx component
  // as an atom whose children are opaque — cites inside a component body are
  // never numbered nor registered in the reference list.
  literalCites?: boolean
  // Set during render when at least one math node is actually emitted. The
  // exported <style> only injects the KaTeX CSS when math is present, so a
  // document with no math stays lean and sync/async output stays identical
  // (KaTeX CSS is only available after the lazy export-time load).
  hasMath?: boolean
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
    resolveReferences(t)
    imageDimMdast(t)
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

/** Build a doi.org link for a DOI string, or null when it is empty/invalid.
 *  Accepts both a raw DOI and an existing doi.org URL, normalizing the prefix. */
export function doiUrl(doi?: string | null): string | null {
  if (!doi) return null
  const cleaned = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  if (!/^10\.\d{4,9}\/[\w.:()\-/]+$/i.test(cleaned)) return null
  return `https://doi.org/${cleaned}`
}

function formatAuthors(authors: string[], max = 3): string {
  if (authors.length === 0) return ''
  if (authors.length === 1) return escapeHtml(authors[0])
  if (authors.length <= max) return authors.map((a) => escapeHtml(a)).join(', ')
  return `${authors.slice(0, max).map((a) => escapeHtml(a)).join(', ')}, et al.`
}

/** Format a reference as a bibliography entry. When journal/volume/DOI/etc.
 *  are present it emits `Authors (Year). Title. <em>Journal</em> Volume(Issue),
 *  Pages. [DOI link]`; otherwise it degrades to the plain `key — title
 *  (authors, year)` form. All parts are HTML-escaped and the journal and DOI
 *  link are marked up for the exported reference list. */
export function formatReference(ref: ExportRef): string {
  const hasRich = ref.journal || ref.volume || ref.issue || ref.pages || ref.doi || ref.url || ref.publisher
  if (!hasRich) {
    const meta: string[] = []
    if (ref.authors?.length) meta.push(ref.authors.join(', '))
    if (ref.year) meta.push(ref.year)
    const metaSuffix = meta.length ? ` (${meta.join(', ')})` : ''
    return ref.title ? `${ref.key} — ${escapeHtml(ref.title)}${metaSuffix}` : `${ref.key}${metaSuffix}`
  }
  const segs: string[] = []
  const author = formatAuthors(ref.authors ?? [])
  if (author) segs.push(ref.year ? `${author} (${escapeHtml(ref.year)})` : author)
  if (ref.title) segs.push(`${escapeHtml(ref.title)}.`)
  const venue: string[] = []
  if (ref.journal) venue.push(`<em>${escapeHtml(ref.journal)}</em>`)
  const volumeIssue = ref.volume
    ? `${escapeHtml(ref.volume)}${ref.issue ? `(${escapeHtml(ref.issue)})` : ''}`
    : ref.issue
      ? `(${escapeHtml(ref.issue)})`
      : ''
  if (volumeIssue) venue.push(volumeIssue)
  if (ref.pages) venue.push(escapeHtml(ref.pages))
  if (venue.length) segs.push(`${venue.join(' ')}.`)
  const doiHref = doiUrl(ref.doi)
  if (doiHref) {
    segs.push(`<a href="${escapeHtml(doiHref)}">doi:${escapeHtml(ref.doi ?? '')}</a>`)
  } else if (ref.url) {
    segs.push(`<a href="${escapeHtml(ref.url)}">${escapeHtml(ref.url)}</a>`)
  } else if (ref.publisher) {
    segs.push(escapeHtml(ref.publisher))
  }
  return segs.filter(Boolean).join(' ')
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

function collectCiteOrder(nodes: RenderNode[], numbers: Map<string, number>): void {
  for (const node of nodes) {
    if (node.type === 'nekoCite' && typeof node.value === 'string') {
      const key = citeKey(node.value)
      if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
      continue
    }
    // The editor treats an mdx component as an atom whose children are
    // opaque, so citations inside a component body are never numbered nor
    // added to the reference list. Do NOT descend into mdxJsxFlowElement.
    if (node.type === 'mdxJsxFlowElement') continue
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
  ctx.hasMath = true
  const value = node.value ?? ''
  if (ctx.math === 'text') {
    const delim = display ? '$$' : '$'
    const inner = `${delim}${escapeHtml(value)}${delim}`
    return display
      ? `<div class="math-latex">${inner}</div>`
      : `<span class="math-latex">${inner}</span>`
  }
  const katex = katexModule
  if (!katex) {
    // A synchronous renderer cannot `await` the lazy KaTeX load. Math was
    // requested in KaTeX mode, but KaTeX is not loaded in this process yet.
    // Fail loudly instead of silently emitting raw LaTeX.
    throw new Error(
      'math was requested but KaTeX is not loaded; call the async ' +
        'renderDocumentAsync(), or ensure a prior render loaded KaTeX ' +
        '(e.g. a prior async render) before using the sync renderDocument()',
    )
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
    // Aligned with the editor: a component body is opaque, so its cites stay
    // literal (literalCites) instead of being numbered.
    const childrenHtml = renderChildren(parseFragment(children), { ...ctx, literalCites: true })
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
    case 'image': {
      const styles: string[] = []
      if (node.width != null && Number.isFinite(node.width)) styles.push(`width:${node.width}px`)
      if (node.imageAlign === 'center') {
        styles.push('display:block', 'margin-left:auto', 'margin-right:auto')
      } else if (node.imageAlign === 'left') {
        styles.push('float:left')
      } else if (node.imageAlign === 'right') {
        styles.push('float:right')
      }
      const style = styles.length ? ` style="${styles.join(';')}"` : ''
      return `<img src="${escapeHtml(node.url ?? '')}" alt="${escapeHtml(node.alt ?? '')}"${style}>`
    }
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
      // Inside an mdx component body the cite is opaque source text (aligned
      // with the editor): render the literal `[@key]` instead of a number.
      if (ctx.literalCites) return escapeHtml(node.value ?? '')
      const key = citeKey(node.value ?? '')
      const number = ctx.citeNumbers.get(key) ?? ctx.citeNumbers.size + 1
      return `<span class="cite">${number}</span>`
    }
    case 'mdxJsxFlowElement':
      return renderMdx(node, ctx)
    case 'html':
      // Intentional divergence from the editor: the editor renders inline
      // raw HTML (e.g. `<span style=...>`) as live markup, but the export
      // escapes it to visible text. Escaping is the XSS-safe default for
      // untrusted markdown; if raw HTML support is ever needed it must be
      // opt-in with sanitization. See spec §3.2.
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
        return `<li>[${n}] ${formatReference(ref)}</li>`
      }
      return `<li>[${n}] ${escapeHtml(key)}</li>`
    })
    .join('')
  return `<section class="references"><h2>参考文献</h2><ol>${items}</ol></section>`
}

const printCss = `
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; max-width: 50rem; margin: 0 auto; padding: 2rem; color: #222; position: relative; }
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

function parseChildren(markdown: string): RenderNode[] {
  const tree = processor.parse(markdown)
  const result = processor.runSync(tree, markdown) as unknown as RenderNode
  return (result.children ?? []) as RenderNode[]
}

/** Rewrite every resolvable image src in the parsed tree to a display URL.
 * Concurrent repeats of the same src share one resolver call. */
async function resolveImageNodes(
  nodes: RenderNode[],
  resolve: (src: string) => Promise<string>,
  cache: Map<string, Promise<void>>,
): Promise<void> {
  for (const node of nodes) {
    if (node.type === 'image' && typeof node.url === 'string' && node.url && !/^(https?:|data:|asset:|blob:|mailto:)/i.test(node.url) && !node.url.startsWith('/')) {
      let pending = cache.get(node.url)
      if (!pending) {
        pending = resolve(node.url)
          .then((display) => {
            node.url = display
          })
          .catch(() => undefined)
        cache.set(node.url, pending)
      }
      await pending
      continue
    }
    // Component bodies are opaque source text re-parsed at render time; their
    // nested images are not rewritten here (same atom rule as the editor).
    if (node.type === 'mdxJsxFlowElement') continue
    if (node.children) await resolveImageNodes(node.children as RenderNode[], resolve, cache)
  }
}

function renderFromChildren(children: RenderNode[], opts?: RenderDocumentOptions): string {
  const math = opts?.math ?? 'katex'

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
      : `<style>${math === 'katex' && ctx.hasMath ? katexCss : ''}${printCss}</style>`

  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title>${style}</head><body>` +
    `${body}${references}</body></html>`
  )
}

export function renderDocument(markdown: string, opts?: RenderDocumentOptions): string {
  return renderFromChildren(parseChildren(markdown), opts)
}

/** Async variant of {@link renderDocument} that resolves image srcs to
 * display URLs before rendering, so exported HTML/PDF keep working images. */
export async function renderDocumentAsync(markdown: string, opts?: RenderDocumentOptions): Promise<string> {
  const children = parseChildren(markdown)
  await loadKatex()
  if (opts?.resolveImage) {
    await resolveImageNodes(children, opts.resolveImage, new Map())
  }
  return renderFromChildren(children, opts)
}
