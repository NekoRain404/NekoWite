import { headingAnchorIds, slugify } from '../slugify'
import type { RenderNode } from './pipeline'

/**
 * The `id` an exported heading carries.
 *
 * A heading anchor copies a `#id` deep link, so the exported document has to
 * expose the matching id or every one of those links is dead. The ids come from
 * `headingAnchorIds`, the same helper the anchor buttons and the scroll handler
 * use, which is what keeps the two ends agreeing.
 */

/** Node types that carry a `value` in mdast yet contribute NO text to a
 *  heading's slug.
 *
 *  The anchor button slugs ProseMirror's `Node.textContent`, which concatenates
 *  TEXT nodes only — an atom is a leaf with no text content, so it contributes
 *  nothing however it renders (a citation shows a number, math renders a
 *  formula, JSX shows its source, and none of it reaches `textContent`).
 *  Including these values here made the export disagree with every link the
 *  anchors copy: `# Claim [@smith2020]` was `#claim` in the editor but
 *  `#claim-smith2020` in the export, so the copied link was dead. */
const TEXT_FREE_ATOMS = new Set(['inlineMath', 'math', 'nekoCite', 'html', 'mdxJsxFlowElement'])

/** The text of a node as the editor's heading slug sees it, used to derive the
 *  exported `id`. Must stay in step with ProseMirror's `textContent`. */
function plainText(node: RenderNode): string {
  if (typeof node.value === 'string' && !TEXT_FREE_ATOMS.has(node.type)) return node.value
  return (node.children ?? []).map((child) => plainText(child as RenderNode)).join('')
}

/**
 * The text of every heading in the tree, in document order.
 *
 * Computed up front (rather than tracked while rendering) so the ids handed to
 * each heading are exactly the ones `headingAnchorIds` produced for the
 * document — the anchor buttons and the scroll handler derive from the same
 * list, which is what keeps a copied link resolvable.
 */
export function collectHeadingTexts(nodes: RenderNode[]): string[] {
  const out: string[] = []
  const walk = (list: RenderNode[]): void => {
    for (const node of list) {
      if (node.type === 'heading') out.push(plainText(node))
      if (node.children?.length) walk(node.children as RenderNode[])
    }
  }
  walk(nodes)
  return out
}

/** The document-wide id list for a parsed document, ready to be consumed as
 *  headings render. */
export function headingIdsFor(nodes: RenderNode[]): string[] {
  return headingAnchorIds(collectHeadingTexts(nodes))
}

/** Take the next id for a heading being rendered.
 *
 *  A component body is re-parsed at render time and its headings were never
 *  enumerated, so the list can run out; falling back to a slug of the heading's
 *  own text keeps such a heading addressable instead of giving it `undefined`. */
export function nextHeadingId(ids: string[], node: RenderNode): string {
  return ids.shift() ?? slugify(plainText(node))
}
