import { safeLinkUrl } from './url'
import { escapeHtml } from './escape-html'
import type { RenderNode } from './pipeline'

/**
 * Citations and the bibliography.
 *
 * A `nekoCite` node (`[@key]`) is numbered by order of first appearance, and
 * the same numbering feeds the reference list appended to the document, so the
 * two always agree. The entries themselves come from the user's .bib/.ris file
 * and are printed into a file opened OUTSIDE the app, so every field is escaped
 * here rather than at the call site.
 */

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

/** The reference list's view of the render context. Kept narrower than the
 *  renderer's own context so the bibliography does not have to know how a node
 *  is rendered. */
export interface ReferenceContext {
  refs?: Map<string, ExportRef>
}

/** The lookup key a `nekoCite` node's source text names: `[@smith2020]` and
 *  `[@smith2020]`-style spellings both reduce to `smith2020`, which is what the
 *  bibliography map and the numbering are keyed by. */
export function citeKey(value: string): string {
  return value.replace(/^\[@/, '').replace(/\]$/, '')
}

/** Number every citation in the tree, in order of first appearance. */
export function collectCiteOrder(nodes: RenderNode[], numbers: Map<string, number>): void {
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
    // `key`, `authors` and `year` come from the user's .bib/.ris file, and the
    // exported HTML is opened OUTSIDE the app (so outside its CSP): escape them
    // exactly like the rich branch escapes every field it prints.
    const meta: string[] = []
    if (ref.authors?.length) meta.push(ref.authors.map((a) => escapeHtml(a)).join(', '))
    if (ref.year) meta.push(escapeHtml(ref.year))
    const metaSuffix = meta.length ? ` (${meta.join(', ')})` : ''
    return ref.title
      ? `${escapeHtml(ref.key)} — ${escapeHtml(ref.title)}${metaSuffix}`
      : `${escapeHtml(ref.key)}${metaSuffix}`
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
    const doiUrl = safeLinkUrl(doiHref)
    segs.push(
      doiUrl === null
        ? `doi:${escapeHtml(ref.doi ?? '')}`
        : `<a href="${escapeHtml(doiUrl)}">doi:${escapeHtml(ref.doi ?? '')}</a>`,
    )
  } else if (ref.url) {
    const refUrl = safeLinkUrl(ref.url)
    segs.push(
      refUrl === null ? escapeHtml(ref.url) : `<a href="${escapeHtml(refUrl)}">${escapeHtml(refUrl)}</a>`,
    )
  } else if (ref.publisher) {
    segs.push(escapeHtml(ref.publisher))
  }
  return segs.filter(Boolean).join(' ')
}

/** The reference list appended to the exported document, in citation order.
 *  A cited key with no matching reference still gets its row, so the number in
 *  the body always has something to point at. */
export function renderReferences(order: string[], ctx: ReferenceContext): string {
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
