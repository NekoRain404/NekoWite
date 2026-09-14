/**
 * Show the author’s `<br>` as a line break instead of as the text of the tag.
 *
 * The inline-break masking (`inline-break.ts`) keeps the marker in the model as an
 * `html` atom, which is what makes the file round-trip byte for byte: the atom’s
 * value is written back verbatim and neither the serializer nor a save has to
 * remember anything. But the preset renders an `html` atom as a `<span>` whose
 * text IS the tag, so every one of those documents showed the reader `<br />` as
 * characters — in a paragraph, in a heading, in a cell, and in every empty table
 * cell, where the serializer itself writes the marker. The break was in the file
 * and never on the screen.
 *
 * So the atom keeps its identity (`data-type="html"` with the source in
 * `data-value`, which is what the schema’s `parseDOM` and the clipboard read back)
 * and only its rendering changes: a break tag renders as the `<br>` a browser
 * would make of it, and every other inline tag keeps the source-text rendering the
 * atom was built for. Rendering arbitrary raw HTML is NOT the move here — the
 * exported document escapes raw HTML on purpose (see export/render.ts), and
 * showing the tag is the honest thing to do with a tag the editor does not
 * implement. A line break is the one tag the app does implement, in both panes.
 */
import { htmlSchema } from '@milkdown/preset-commonmark'
import { $view } from '@milkdown/utils'
import type { Node as ProseNode } from '@milkdown/prose/model'
import type { NodeViewConstructor } from '@milkdown/prose/view'

import { isInlineBreakValue } from './inline-break'

/** Fill the atom’s span with what its value means: a break, or its source text. */
function fill(span: HTMLElement, node: ProseNode): void {
  const value = String(node.attrs.value ?? '')
  span.setAttribute('data-type', 'html')
  span.setAttribute('data-value', value)
  // Rewriting the children in place (rather than handing ProseMirror a new root)
  // keeps the element the view registered: an edit that turns a break tag into
  // some other tag, or the undo of one, has to keep the same `dom` in the
  // document.
  span.textContent = ''
  if (isInlineBreakValue(value)) span.appendChild(document.createElement('br'))
  else span.textContent = value
}

const makeInlineBreakNodeView: NodeViewConstructor = (node) => {
  const span = document.createElement('span')
  fill(span, node)
  return {
    dom: span,
    update: (updated) => {
      if (updated.type !== node.type) return false
      node = updated
      fill(span, node)
      return true
    },
    destroy: () => undefined,
  }
}

// `htmlSchema.node` (not the schema) is what `$view` can key a node type by —
// the same shape every other node view in this package registers with.
export const inlineBreakNodeView = $view(htmlSchema.node, () => makeInlineBreakNodeView)
