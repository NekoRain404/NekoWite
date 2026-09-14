/**
 * The export module's entry: markdown in, one standalone HTML document out.
 *
 * The renderer is split by concern behind this file — `pipeline.ts` builds the
 * mdast, `render.ts` turns each node into HTML, `headings.ts` derives the anchor
 * ids, `math.ts` is the lazy KaTeX boundary, `references.ts` numbers the
 * citations, `document.ts` frames the document and pre-resolves its images, and
 * `url.ts` holds the href/src allowlist.
 *
 * Only the names below are the module's API. The node renderers, the pipeline's
 * transform order and the escaping primitive stay internal: a caller has no
 * business rendering one node, and the order transforms run in is a contract of
 * the whole document rather than of any caller.
 */

export { doiUrl, formatReference } from './references'
export type { ExportRef } from './references'

export { renderDocument, renderDocumentAsync } from './document'
export type { ExportImageTarget, RenderDocumentOptions } from './document'

export type { ComponentRenderer } from './render'

export * from './url'
