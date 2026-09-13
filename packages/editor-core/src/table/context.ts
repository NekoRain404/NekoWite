import { Fragment } from '@milkdown/prose/model'
import type { Node as ProseNode, ResolvedPos } from '@milkdown/prose/model'
import { TextSelection } from '@milkdown/prose/state'
import type { EditorState } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

/**
 * True when the selection sits inside a GFM table cell.
 *
 * A cell's content is a single `paragraph` (`cellContent: 'paragraph'` in the GFM
 * preset), so a BLOCK node can never go there: ProseMirror's fitter lifts it out
 * and SPLITS the table in two, leaving a phantom row behind. The document still
 * passes `doc.check()`, so nothing warns the user before the next save writes the
 * split to disk. Every block-producing insert therefore asks this first and either
 * keeps the change inline or refuses it.
 *
 * The check walks UP from each endpoint to the nearest cell. (`inSameTable` is not
 * usable here: it compares depths and positions, which is true for any two
 * positions in the same paragraph.) Both endpoints are checked, so a selection that
 * starts in a cell but reaches past it still counts as in-cell.
 */
export function isInTableCell(state: EditorState): boolean {
  const { $from, $to } = state.selection
  return isInCell($from) || isInCell($to)
}

/** True when the position resolves into a cell. */
function isInCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name
    if (name === 'table_cell' || name === 'table_header') return true
  }
  return false
}


/**
 * Insert the inline part of a parsed Markdown snippet into the caret's cell.
 *
 * The cell's paragraph is replaced with the FIRST text block's inline content —
 * the one thing a cell can hold. Everything else in the snippet is dropped, and
 * deliberately so: there is no place in a cell for it, and inserting it after the
 * table would put content where the user did not point. Returns false when the
 * snippet has no inline-representable first block (an `hr`, a table, a fence) or
 * when the content does not fit, so a caller can report that nothing was inserted
 * instead of pretending it worked.
 */
export function insertMarkdownInCell(view: EditorView, parsed: ProseNode): boolean {
  const { state } = view
  const block = firstTextBlock(parsed)
  if (!block) return false
  const content = block.content
  const { $from } = state.selection
  const start = $from.start()
  const end = $from.end()
  if (content.size > 0 && !$from.parent.canReplace(0, $from.parent.content.size, Fragment.from(content))) {
    return false
  }
  const tr = state.tr.replaceWith(start, end, content)
  const caret = Math.min(start + content.size, tr.doc.content.size)
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView())
  return true
}

/** The first child of `parsed` whose content can live in a cell. */
function firstTextBlock(parsed: ProseNode): ProseNode | null {
  let found: ProseNode | null = null
  parsed.forEach((child) => {
    if (found || !child.isTextblock) return
    found = child
  })
  return found
}
