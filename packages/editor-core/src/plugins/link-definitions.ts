/**
 * Link reference definitions, kept through the editor's parse.
 *
 * The schema has no node for a definition, and the commonmark preset runs
 * `remark-inline-links` over every tree, which deletes EVERY `definition` after
 * turning the references it could resolve into inline links. Inlining a used
 * reference is intended — the href and title survive and only the source form
 * changes. A definition nothing points at has nothing to inline, so deleting it
 * LOSES the author's text: a note whose whole content was
 * `[unused]: https://example.com` opened as an empty document and saved as an
 * empty file. These two passes are the repair, and they sit around the
 * transformers: park the unreferenced definitions where nothing deletes them,
 * then write them back as nodes the model can hold.
 *
 * The definitions a reference DOES point at are untouched, so the inlining
 * keeps writing exactly what it always wrote.
 */

/** The subset of mdast these passes walk (the shape `MdastLike` in remark.ts has). */
export interface DefinitionNode {
  type?: string
  children?: DefinitionNode[]
  value?: unknown
  /** Link/image reference label, already normalised by the parser. */
  identifier?: unknown
  /** Definition fields, for the position-less fallback. */
  url?: unknown
  title?: unknown
  label?: unknown
  position?: { start?: { offset?: number }; end?: { offset?: number } }
}

/**
 * The node type an unreferenced definition is parked under.
 *
 * It cannot stay a `definition` (the transformer deletes those) and it cannot
 * become an `html` node yet — that happens after the transformers run, and a
 * type no transformer matches keeps it out of their way in between.
 */
const KEPT_DEFINITION = 'nekoKeptDefinition'

/** Park every definition that no `linkReference`/`imageReference` points at. */
export function keepUnusedDefinitions(tree: DefinitionNode): void {
  const referenced = new Set<string>()
  const walk = (node: DefinitionNode): void => {
    if (
      (node.type === 'linkReference' || node.type === 'imageReference') &&
      typeof node.identifier === 'string'
    ) {
      referenced.add(node.identifier)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  const park = (node: DefinitionNode): void => {
    if (node.type === 'definition' && !referenced.has(String(node.identifier ?? ''))) {
      node.type = KEPT_DEFINITION
    }
    for (const child of node.children ?? []) park(child)
  }
  park(tree)
}

/**
 * Write the parked definitions back out as the source the author typed.
 *
 * `html` is the node that holds it: it keeps its value VERBATIM through the
 * serializer (the inline `<br>` markers in remark.ts rely on the same
 * property), so a label's spacing, a title's quoting and a URL's angle brackets
 * are the author's again. `readSource` is how the caller hands over the text of
 * a position range — remark.ts has to un-mask its own sentinels out of it,
 * which is knowledge this module has no business holding. The save's own
 * re-parse still applies the stringifier's canonical form to the result — a
 * definition written across two lines comes back on one, adjacent definitions
 * gain the blank line between blocks — exactly as it already did for a
 * definition this route never saw.
 */
export function restoreKeptDefinitions(
  tree: DefinitionNode,
  readSource: (start: number, end: number) => string,
): void {
  const children = tree.children
  if (!children) return
  // A definition is block content, so the html node needs the paragraph a block
  // container requires; inside a cell it goes in as-is.
  const phrasesOnly = tree.type === 'tableCell'
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === KEPT_DEFINITION) {
      const html: DefinitionNode = { type: 'html', value: definitionSource(child, readSource) }
      children[i] = phrasesOnly ? html : { type: 'paragraph', children: [html] }
      continue
    }
    restoreKeptDefinitions(child, readSource)
  }
}

/** The definition exactly as written, or rebuilt from its parts. */
function definitionSource(
  node: DefinitionNode,
  readSource: (start: number, end: number) => string,
): string {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start === 'number' && typeof end === 'number' && end > start) {
    return readSource(start, end)
  }
  const label = String(node.label ?? node.identifier ?? '')
  const title = typeof node.title === 'string' && node.title !== '' ? ` "${node.title}"` : ''
  return `[${label}]: ${String(node.url ?? '')}${title}`
}
