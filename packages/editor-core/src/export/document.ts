import { parseMdxTag } from '../mdx'
import { escapeHtml } from './escape-html'
import { katexStylesheet, loadKatex } from './math'
import { parseChildren, parseFragment } from './pipeline'
import { collectCiteOrder, renderReferences } from './references'
import { headingIdsFor } from './headings'
import { renderChildren } from './render'
import type { ComponentRenderer, RenderContext } from './render'
import type { ExportRef } from './references'
import type { RenderNode } from './pipeline'

/**
 * The exported document: the two render entry points, the frame around them,
 * and the async pre-pass that makes images survive the trip out of the app.
 */

/** What the exported document is for. It decides which src form the image
 *  resolver has to return, because the two export paths do not accept the same
 *  URLs:
 *
 *  - `'display'` (default): the HTML is rendered inside the app by the
 *    print/PDF path, where the app's own `asset:` URL resolves.
 *  - `'data'`: the HTML is written to disk and opened OUTSIDE the app — in a
 *    browser, or on another machine. An app-internal URL is a dead link there,
 *    so the resolver has to return a self-contained `data:` URL. That is the
 *    same rule the KaTeX CSS and its fonts already follow (imported `?inline`),
 *    which is what keeps the saved file portable.
 */
export type ExportImageTarget = 'display' | 'data'

export interface RenderDocumentOptions {
  title?: string
  refs?: Map<string, ExportRef>
  componentRenderers?: Record<string, ComponentRenderer>
  math?: 'katex' | 'text'
  includeCss?: boolean
  /** Async src resolver for images (e.g. vault-relative attachment paths).
   * Only used by the async render entry point. `target` is the form the caller
   * can actually use (see {@link ExportImageTarget}): a resolver that returns a
   * data URL for `'data'` keeps the exported file self-contained. */
  resolveImage?: (src: string, target: ExportImageTarget) => Promise<string>
  /** The src form {@link resolveImage} is asked for. Defaults to `'display'`,
   * which is what the in-app print/PDF path needs; the HTML export that is
   * saved to disk asks for `'data'`. */
  imageSrcTarget?: ExportImageTarget
}

const printCss = `
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; max-width: 50rem; margin: 0 auto; padding: 2rem; color: #222; position: relative; }
/* Mirrors the editor's own image rule (.neko-image img in editor-blocks.css:
   max-width + height:auto + the 3px radius). Without it an image carrying an
   explicit {width=N} was emitted at N device pixels with nothing to bound it,
   so a photo sized for the editor's narrow column overflowed the printed page
   and the exported image did not match what the app showed. height:auto is the
   no-stored-height case only — an explicit height is inline, exactly as in the
   editor, where the inline style also wins over this rule. */
img { max-width: 100%; height: auto; border-radius: 3px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: #f6f8fa; padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }
blockquote { margin: 0; padding-left: 1rem; border-left: 4px solid #d0d7de; color: #57606a; }
mark.nk-highlight { background: #fff3b0; padding: 0 0.1em; border-radius: 2px; }
.wikilink { color: #0969da; border-bottom: 1px dashed currentColor; }
.contains-task-list { list-style: none; padding-left: 0.25rem; }
.task-list-item { display: flex; align-items: flex-start; gap: 0.5rem; }
.task-list-item > input { margin: 0.4rem 0 0; flex: none; }
.task-list-item-body > p { margin: 0; }
.footnote-ref a { text-decoration: none; }
.footnote { display: flex; gap: 0.4rem; margin: 0.5rem 0; color: #57606a; font-size: 0.925em; }
.footnote-marker { flex: none; }
.footnote-body > p { margin: 0; }
.footnote-backref { margin-left: 0.35rem; text-decoration: none; }
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

/** Rewrite every resolvable image src in the parsed tree to a display URL.
 * Concurrent repeats of the same src share one resolver call.
 *
 * `resolved` maps a document src to the URL the resolver produced, so an image
 * the rewrite cannot reach in place (a component body) is still resolvable at
 * render time. */
async function resolveImageNodes(
  nodes: RenderNode[],
  resolve: (src: string, target: ExportImageTarget) => Promise<string>,
  target: ExportImageTarget,
  renderers: Record<string, ComponentRenderer> | undefined,
  cache: Map<string, Promise<void>>,
  resolved: Map<string, string>,
): Promise<void> {
  for (const node of nodes) {
    if (node.type === 'image' && typeof node.url === 'string' && node.url && !/^(https?:|data:|asset:|blob:|mailto:)/i.test(node.url) && !node.url.startsWith('/')) {
      const src = node.url
      let pending = cache.get(src)
      if (!pending) {
        pending = resolve(src, target)
          .then((display) => {
            node.url = display
            resolved.set(src, display)
          })
          .catch(() => undefined)
        cache.set(src, pending)
      }
      await pending
      continue
    }
    // A component body is opaque source text: cites and heading ids inside it
    // stay suppressed (the render pass re-parses it with `literalCites` /
    // `literalHeadingIds`), but an image src must still resolve. Skipping the
    // body outright left `![pic](assets/a.png)` in a saved export pointing at
    // whatever happened to sit beside it where the user saved the file. Walk a
    // throwaway parse of the body so those srcs reach `resolved`.
    if (node.type === 'mdxJsxFlowElement') {
      // Only a body with a renderer is emitted as HTML; without one the raw
      // source is escaped into a fallback box, so resolving its images (one
      // file read per image when the target is `'data'`) would be work that
      // nothing consumes.
      const { name, children } = parseMdxTag(typeof node.value === 'string' ? node.value : '')
      if (children && renderers?.[name]) {
        await resolveImageNodes(parseFragment(children), resolve, target, renderers, cache, resolved)
      }
      continue
    }
    if (node.children) await resolveImageNodes(node.children as RenderNode[], resolve, target, renderers, cache, resolved)
  }
}

/** Numbers every footnote in order of first appearance (reference first, then
 *  any definition that was never referenced), mirroring GFM's numbering. */
function collectFootnoteOrder(nodes: RenderNode[], numbers: Map<string, number>): void {
  const walk = (list: RenderNode[]): void => {
    for (const node of list) {
      if (node.type === 'footnoteReference' || node.type === 'footnoteDefinition') {
        const id = node.identifier ?? ''
        if (id && !numbers.has(id)) numbers.set(id, numbers.size + 1)
      }
      if (node.children?.length) walk(node.children as RenderNode[])
    }
  }
  walk(nodes)
}

function renderFromChildren(
  children: RenderNode[],
  opts?: RenderDocumentOptions,
  resolvedImages?: Map<string, string>,
): string {
  const math = opts?.math ?? 'katex'

  const citeNumbers = new Map<string, number>()
  collectCiteOrder(children, citeNumbers)

  const footnoteNumbers = new Map<string, number>()
  collectFootnoteOrder(children, footnoteNumbers)

  const ctx: RenderContext = {
    math,
    componentRenderers: opts?.componentRenderers,
    resolvedImages,
    citeNumbers,
    headingIds: headingIdsFor(children),
    footnoteNumbers,
  }

  const body = renderChildren(children, ctx)
  const references = renderReferences(Array.from(citeNumbers.keys()), { refs: opts?.refs })

  const title = opts?.title ?? parseTitle(children) ?? 'Untitled'
  const style =
    opts?.includeCss === false
      ? ''
      : `<style>${math === 'katex' && ctx.hasMath ? katexStylesheet() : ''}${printCss}</style>`

  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title>${style}</head><body>` +
    `${body}${references}</body></html>`
  )
}

export function renderDocument(markdown: string, opts?: RenderDocumentOptions): string {
  return renderFromChildren(parseChildren(markdown), opts)
}

/** Async variant of {@link renderDocument} that resolves image srcs before
 * rendering, so exported HTML/PDF keep working images. The src form the
 * resolver is asked for comes from {@link RenderDocumentOptions.imageSrcTarget}. */
export async function renderDocumentAsync(markdown: string, opts?: RenderDocumentOptions): Promise<string> {
  const children = parseChildren(markdown)
  await loadKatex()
  const resolvedImages = new Map<string, string>()
  if (opts?.resolveImage) {
    await resolveImageNodes(
      children,
      opts.resolveImage,
      opts.imageSrcTarget ?? 'display',
      opts.componentRenderers,
      new Map(),
      resolvedImages,
    )
  }
  return renderFromChildren(children, opts, resolvedImages)
}
