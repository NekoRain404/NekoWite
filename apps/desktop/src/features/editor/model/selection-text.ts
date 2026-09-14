/**
 * The text of a document selection — what a copy should carry.
 *
 * Why this exists, measured on this tree: the rendered pane draws maths, code
 * blocks, tables and wiki-links through node views whose DOM is marked
 * `contenteditable="false"`, and the engine copies the DOM SELECTION. Copying a
 * paragraph with inline maths produced `Inline maths  sits here.` (the formula
 * gone); copying the maths node, a code block or a table alone produced the
 * EMPTY STRING; and Cut did the same while deleting the paragraph, so the source
 * was destroyed and the payload was already wrong.
 *
 * `textBetween` reads the DOCUMENT instead. That is the same in every engine and
 * holds every node's own text, so the payload stops depending on how a given
 * engine serialises a `contenteditable="false"` subtree — the defect was in the
 * serialiser being used, not in the document.
 *
 * The one thing the document cannot answer is what a node VIEW draws, so
 * `leafText` answers for atoms from their attributes. Where a formula's rendering
 * differs from its source (`\frac{1}{3}`), the payload carries the source the
 * user typed — stated as a limit rather than smoothed over.
 *
 * One implementation, shared with `services/editor-text-selection`'s mode-aware
 * accessor, because two serialisers that must agree is the shape this programme
 * refuses to keep.
 */

import type { Node as ProseMirrorNode } from '@milkdown/prose/model'

/** Between two top-level blocks: what a reader sees as a paragraph break. */
export const SELECTION_BLOCK_SEPARATOR = '\n'

/**
 * A ProseMirror node. The REAL type, not a hand-written stand-in.
 *
 * An earlier version declared `{ textBetween(from, to, blockSeparator?, leafText?) }`
 * structurally "to keep the dependency out" — and got the API wrong by doing so:
 * the signature lost `| string | null`, and `leafText`'s parameter became
 * `never`. `vue-tsc` caught it; `vitest` and `eslint` cannot (types are stripped,
 * and eslint does not typecheck), which is exactly why a structural re-statement
 * of someone else's API is a claim that has to be paid for. The dependency was
 * already here — the app builds on this package — so the honest version costs
 * nothing.
 */
export type SelectionNode = ProseMirrorNode

/**
 * What an atom node contributes to the text.
 *
 * The attribute names are the ones this app's node views draw from — maths
 * (`latex`), MDX and widget-ish nodes (`value`/`text`), wiki-links
 * (`label`/`target`/`page`) — with the node's own text content as the last
 * resort, so a node type nobody anticipated still contributes something rather
 * than vanishing from the clipboard.
 */
export function leafTextOf(node: SelectionNode): string {
  const attrs = node.attrs ?? {}
  for (const key of ['latex', 'label', 'value', 'text', 'page', 'target', 'title', 'href']) {
    const value = attrs[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return node.textContent ?? ''
}

/** The payload for `doc`'s selection, from `from` to `to`. */
export function selectionTextOf(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, SELECTION_BLOCK_SEPARATOR, (node) => leafTextOf(node))
}
