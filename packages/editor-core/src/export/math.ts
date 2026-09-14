// Referenced so consumer packages compiling this source see the ?inline module type.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./css.d.ts" />
import { escapeHtml } from './escape-html'
import type { RenderNode } from './pipeline'

/**
 * Maths, and the KaTeX boundary.
 *
 * KaTeX is only needed at export time (the editor preview renders math via
 * MathLive / the app's own renderer). Loading it lazily keeps the startup
 * import graph free of ~1MB of math machinery. The async `renderDocumentAsync`
 * always awaits the lazy load before rendering; the sync `renderDocument` can
 * only render math if KaTeX is ALREADY loaded in this process (e.g. a prior
 * async render or an explicit preload). If math is present but KaTeX is not
 * yet loaded, the sync path throws a clear, actionable error rather than
 * silently emitting raw LaTeX. Documents without math never touch KaTeX and
 * stay byte-for-byte identical across both render entry points.
 * The KaTeX CSS is pulled in the same lazy way (via `?inline`, so the fonts
 * stay data: URIs and the exported HTML is self-contained) rather than being
 * statically imported, which would drag the whole vendor-katex chunk into the
 * entry's modulepreload graph.
 */
let katexModule: (typeof import('katex'))['default'] | null = null
let katexCss = ''

export async function loadKatex(): Promise<void> {
  if (katexModule) return
  const [mod, cssMod] = await Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css?inline'),
  ])
  katexModule = mod.default ?? mod
  katexCss = cssMod.default ?? cssMod
}

/** The KaTeX stylesheet, or '' when the lazy load has not run. The exported
 *  `<style>` only injects it when a math node was actually emitted, which is
 *  what keeps a document with no math lean. */
export function katexStylesheet(): string {
  return katexCss
}

/** How a math node becomes HTML.
 *
 *  `hasMath` is set on the context so the document frame knows to inject the
 *  KaTeX stylesheet; in `'text'` mode the LaTeX source is shown verbatim
 *  instead of being rendered, which is also the path the tests use so their
 *  output never depends on whether KaTeX happens to be loaded in the process.
 */
export function renderMath(
  node: RenderNode,
  ctx: { math: 'katex' | 'text'; hasMath?: boolean },
  display: boolean,
): string {
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
