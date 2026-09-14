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
 * The selection is replaced with the FIRST text block's inline content — the one
 * thing a cell can hold. Everything else in the snippet is dropped, and
 * deliberately so: there is no place in a cell for it, and inserting it after the
 * table would put content where the user did not point. Returns false when the
 * snippet has no inline-representable first block (an `hr`, a table, a fence) or
 * when the content does not fit, so a caller can report that nothing was inserted
 * instead of pretending it worked.
 *
 * The range is the SELECTION, not the enclosing paragraph: this is the in-cell
 * half of `insertMarkdownAtCursor`, which the image intake and the AI insert
 * call, and "insert at the cursor" has to leave the rest of the cell alone.
 * Replacing the paragraph instead turned that same insert into "replace the
 * cell" — an AI reply landing before "hello" in a cell holding "h hello world"
 * left the cell as "h X", and the next save wrote the loss to disk. A selection
 * that reaches past the caret's paragraph (a `CellSelection`, a range spanning
 * blocks) is clipped to the caret's own paragraph, because the rest of it holds
 * nodes a cell's single paragraph cannot be replaced by.
 */
export function insertMarkdownInCell(view: EditorView, parsed: ProseNode): boolean {
  const { state } = view
  const block = firstTextBlock(parsed)
  if (!block) return false
  const content = block.content
  const { $from } = state.selection
  const start = $from.start()
  const size = $from.parent.content.size
  const from = Math.min(Math.max(state.selection.from - start, 0), size)
  const to = Math.min(Math.max(state.selection.to - start, from), size)
  // The question a cell asks is whether this fragment can live in its one
  // paragraph at all. `canReplace`/`canReplaceWith` take CHILD INDICES rather
  // than content offsets, so the old whole-paragraph form was only safe while
  // its range began at index 0: `contentMatchAt(from)` walks `from` children
  // into the paragraph, and a range starting inside the text indexes a child
  // that is not there ("Index 1 out of range for <…>"). Ask the content model
  // directly — which is what that call computed on the runs where it did not
  // throw.
  if (content.size > 0 && !$from.parent.type.contentMatch.matchFragment(content)) {
    return false
  }
  const tr = state.tr.replaceWith(start + from, start + to, content)
  const caret = Math.min(start + from + content.size, tr.doc.content.size)
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
