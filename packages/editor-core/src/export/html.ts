/**
 * Compatibility surface for the export renderer.
 *
 * The implementation moved to the modules beside this file:
 *
 *  - `pipeline.ts`   — markdown in, the export's mdast out (transform order is
 *                      a contract; a transform that runs after another can
 *                      produce different output).
 *  - `render.ts`     — how each node type becomes HTML.
 *  - `headings.ts`   — the `id` a heading carries, derived the way the editor's
 *                      anchor buttons derive it.
 *  - `math.ts`       — the lazy KaTeX boundary and how a math node renders.
 *  - `references.ts` — citation numbering and the bibliography.
 *  - `document.ts`   — the two entry points, the frame, and the image pre-pass.
 *  - `url.ts`        — the `href`/`src` allowlist (unchanged).
 *
 * `escape-html.ts` holds the shared escaping primitive.
 *
 * Nothing outside this directory should import the internals directly; the
 * names below are the package's export API and are unchanged by the split.
 */

export { doiUrl, formatReference } from './references'
export { renderDocument, renderDocumentAsync } from './document'
export type { ExportRef } from './references'
export type { ComponentRenderer } from './render'
export type { ExportImageTarget, RenderDocumentOptions } from './document'
