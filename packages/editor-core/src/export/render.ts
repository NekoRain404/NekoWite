import { parseMdxTag } from '../mdx'
import { isInlineBreakValue } from '../plugins/inline-break'
import { renderList as renderBlockList, renderTable as renderBlockTable } from './blocks'
import { safeImageUrl, safeLinkUrl } from './url'
import { escapeHtml } from './escape-html'
import { nextHeadingId } from './headings'
import { renderMath } from './math'
import { parseFragment } from './pipeline'
import { citeKey } from './references'
import type { RenderNode } from './pipeline'

/**
 * How a node becomes HTML.
 *
 * The whole serialisation contract lives here: which element each mdast node
 * maps to, the order of its attributes, and what gets escaped. Everything that
 * reaches the exported file passes through this switch, so a change here is a
 * change to a user artifact.
 */

export type ComponentRenderer = (
  props: Record<string, string>,
  childrenHtml: string,
) => string

export interface RenderContext {
  math: 'katex' | 'text'
  componentRenderers?: Record<string, ComponentRenderer>
  /** Display URL by document src, filled by the async pre-pass. Component
   *  bodies are raw source text that `renderMdx` parses again at render time,
   *  so an image inside one cannot be rewritten in place by the pre-pass; it
   *  looks its resolved URL up here instead (see `resolveImageNodes`). */
  resolvedImages?: Map<string, string>
  citeNumbers: Map<string, number>
  // When true, nekoCite nodes render their literal `[@key]` source text
  // instead of a number. Mirrors the editor, which treats an mdx component
  // as an atom whose children are opaque — cites inside a component body are
  // never numbered nor registered in the reference list.
  literalCites?: boolean
  // When true, headings render WITHOUT a document anchor id. In the editor an
  // mdx component is an atom whose body is opaque source, so a heading inside
  // that body is not part of the document's anchor list. Emitting an id for it
  // consumed an entry meant for a real heading: every later id shifted by one
  // and the last was duplicated, so an exported anchor link pointed at the
  // wrong heading (or at a heading inside a callout).
  literalHeadingIds?: boolean
  // Set during render when at least one math node is actually emitted. The
  // exported <style> only injects the KaTeX CSS when math is present, so a
  // document with no math stays lean and sync/async output stays identical
  // (KaTeX CSS is only available after the lazy export-time load).
  hasMath?: boolean
  /** The remaining heading ids, in document order (see `headingAnchorIds`).
   *  Consumed by `nextHeadingId` as headings are rendered, so the ids match what
   *  the anchor buttons produce for the same document. */
  headingIds: string[]
  /** Footnote numbers by identifier, in order of first appearance. Shared by
   *  `footnoteReference` and `footnoteDefinition` so the pair always agrees. */
  footnoteNumbers: Map<string, number>
}

export function renderChildren(nodes: RenderNode[], ctx: RenderContext): string {
  return nodes.map((node) => renderNode(node, ctx)).join('')
}

function renderMdx(node: RenderNode, ctx: RenderContext): string {
  const raw = typeof node.value === 'string' ? node.value : ''
  const { name, props, children } = parseMdxTag(raw)
  const renderer = ctx.componentRenderers?.[name]
  if (renderer) {
    // Aligned with the editor: a component body is opaque source. Its cites
    // stay literal (literalCites) instead of being numbered, and its headings
    // take no document anchor (literalHeadingIds) so they cannot steal an id
    // from a real heading.
    const childrenHtml = renderChildren(parseFragment(children), {
      ...ctx,
      literalCites: true,
      literalHeadingIds: true,
    })
    return renderer(props, childrenHtml)
  }
  return `<div class="mdx-fallback">${escapeHtml(raw)}</div>`
}

/**
 * A hard line break inside a paragraph.
 *
 * mdast models shift+Enter (and the trailing-backslash / two-space spellings) as
 * a `break` node — a leaf with no children. The renderer had no case for it, so
 * it fell through to the generic "render the children" branch, which for a
 * childless node returns the empty string: the break vanished AND the two lines
 * ran together, turning a two-line paragraph into one concatenated line in the
 * exported HTML and PDF. The editor shows a real <br> for the same document, so
 * the export also disagreed with what the user sees.
 */
function renderBreak(): string {
  return '<br />'
}

export function renderNode(node: RenderNode, ctx: RenderContext): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value ?? '')
    case 'root':
      return renderChildren((node.children ?? []) as RenderNode[], ctx)
    case 'paragraph':
      return `<p>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</p>`
    case 'heading': {
      const level = Math.min(Math.max(node.depth ?? 1, 1), 6)
      const body = renderChildren((node.children ?? []) as RenderNode[], ctx)
      // An mdx component body is opaque: its headings are not document
      // headings, so they render without an anchor (see `literalHeadingIds`).
      if (ctx.literalHeadingIds) return `<h${level}>${body}</h${level}>`
      // Heading anchors copy a `#id` deep link, so the exported document has to
      // expose the matching id or every one of those links is dead. The ids are
      // the document-wide list computed up front by `headingAnchorIds`, which is
      // also what the anchor buttons and the scroll handler use.
      const id = nextHeadingId(ctx.headingIds, node)
      return `<h${level} id="${escapeHtml(id)}">${body}</h${level}>`
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
    case 'link': {
      // A destination that fails the allowlist (javascript:, data:text/html,
      // vbscript:, …) is dropped rather than emitted: the link text survives so
      // nothing is silently lost, but the exported file cannot run it.
      const href = safeLinkUrl(node.url)
      const body = renderChildren((node.children ?? []) as RenderNode[], ctx)
      return href === null ? body : `<a href="${escapeHtml(href)}">${body}</a>`
    }
    case 'image': {
      const styles: string[] = []
      if (node.width != null && Number.isFinite(node.width)) styles.push(`width:${node.width}px`)
      // The editor applies a stored height too (nodeView's applyDims sets both
      // inline), so dropping it here made an image with `{width=300 height=150}`
      // export at its intrinsic ratio instead of the ratio the user chose — the
      // exported picture was a different shape from the one on screen.
      if (node.height != null && Number.isFinite(node.height)) styles.push(`height:${node.height}px`)
      if (node.imageAlign === 'center') {
        styles.push('display:block', 'margin-left:auto', 'margin-right:auto')
      } else if (node.imageAlign === 'left') {
        styles.push('float:left')
      } else if (node.imageAlign === 'right') {
        styles.push('float:right')
      }
      const style = styles.length ? ` style="${styles.join(';')}"` : ''
      // An image inside a component body is re-parsed from that body's raw
      // source at render time, so it still carries the document src here: take
      // the display URL the async pre-pass recorded for it. A top-level image
      // was rewritten in place and misses this lookup.
      const resolved = typeof node.url === 'string' ? ctx.resolvedImages?.get(node.url) : undefined
      // Same allowlist as links, plus `data:image/*` for inlined pictures. A
      // rejected src is omitted so the alt text shows instead of a broken image
      // that would still have navigated on click.
      const src = safeImageUrl(resolved ?? node.url)
      const srcAttr = src === null ? '' : ` src="${escapeHtml(src)}"`
      return `<img${srcAttr} alt="${escapeHtml(node.alt ?? '')}"${style}>`
    }
    case 'list':
      return renderBlockList(node, (children) => renderChildren(children, ctx))
    case 'listItem':
      return `<li>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</li>`
    case 'thematicBreak':
      return '<hr>'
    case 'table':
      return renderBlockTable(node, (children) => renderChildren(children, ctx))
    case 'tableRow':
      return `<tr>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</tr>`
    case 'tableCell':
      return `<td>${renderChildren((node.children ?? []) as RenderNode[], ctx)}</td>`
    case 'yaml':
      return `<pre class="frontmatter">${escapeHtml(node.value ?? '')}</pre>`
    case 'inlineMath':
      return renderMath(node, ctx, false)
    // remark-math emits `math` for display math (`$$…$$`), NOT `displayMath`.
    // Matching only the latter meant display math fell through to
    // `renderChildren`, which returns '' for a leaf — so every exported
    // HTML/PDF silently dropped it. Both names are accepted because the editor's
    // own remark plugin (`mdx`/`math` transforms) is not the only producer of
    // the tree here.
    case 'math':
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
    // `==highlight==` (`nekoHighlight` is produced by highlightMdast above).
    case 'nekoHighlight':
      return `<mark class="nk-highlight">${renderChildren((node.children ?? []) as RenderNode[], ctx)}</mark>`
    case 'nekoWikiLink': {
      // The export is a standalone file, so a vault-relative wikilink has no
      // destination to navigate to. Keep the editor's DOM contract
      // (`span[data-wikilink]`, label = alias || target) so the text survives
      // instead of vanishing, and a downstream tool can still recover the
      // target from the attribute.
      const target = node.target ?? ''
      const label = node.alias || target
      return `<span class="wikilink" data-target="${escapeHtml(target)}">${escapeHtml(label)}</span>`
    }
    case 'footnoteReference': {
      const id = node.identifier ?? ''
      const n = ctx.footnoteNumbers.get(id) ?? ctx.footnoteNumbers.size + 1
      return (
        `<sup class="footnote-ref" id="fnref-${escapeHtml(id)}">` +
        `<a href="#fn-${escapeHtml(id)}">${n}</a></sup>`
      )
    }
    case 'footnoteDefinition': {
      const id = node.identifier ?? ''
      const n = ctx.footnoteNumbers.get(id)
      const marker = n != null ? `<span class="footnote-marker">[${n}]</span>` : ''
      const back = `<a class="footnote-backref" href="#fnref-${escapeHtml(id)}">↩</a>`
      const body = renderChildren((node.children ?? []) as RenderNode[], ctx)
      return (
        `<div class="footnote" id="fn-${escapeHtml(id)}">${marker}` +
        `<div class="footnote-body">${body}${back}</div></div>`
      )
    }
    case 'mdxJsxFlowElement':
      return renderMdx(node, ctx)
    case 'break':
      return renderBreak()
    case 'html': {
      // A break tag is the one piece of inline HTML the app implements: the pane
      // renders it as a line break (plugins/inline-break-view.ts) and so does the
      // export, because a reader who wrote `<br>` in a paragraph, a heading or a
      // table cell means a line break — not the characters, and not two lines run
      // together. Every OTHER raw tag keeps the escaping below.
      const value = node.value ?? ''
      if (isInlineBreakValue(value)) return renderBreak()
      // Intentional divergence from the editor: the editor shows inline
      // raw HTML (e.g. `<span style=...>`) as its source text, while the export
      // escapes it so it also shows as visible text. Escaping is the XSS-safe
      // default for untrusted markdown; if raw HTML support is ever needed it
      // must be opt-in with sanitization. See spec §3.2.
      return escapeHtml(value)
    }
    default:
      return renderChildren((node.children ?? []) as RenderNode[], ctx)
  }
}
