import type { NekoEditor } from '@nekowite/editor-core'
import { blockIndexForLine, blockLineFor, blockProgress, parseSourceBlocks } from './document-blocks'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

/**
 * The caret's route through the note's own blocks: a source line to the
 * document position it names, and back.
 *
 * This is the half of the caret that does not go through pixels. The line↔offset
 * mapping measures the pane — where the viewport is, how much of the pane the
 * note fills — and a caret is a point in the DOCUMENT: for a note with headings
 * the mapping's anchors carry it exactly, and for a note without them it falls
 * back to a fraction of the pane's scrollable extent, which is nothing at all
 * when the note is shorter than the pane. Every line then maps to the top.
 *
 * The blocks are what is left when the pane is taken out of the question (see
 * `document-blocks`): the note's paragraphs, headings, lists and tables, paired
 * by index with the model's own top-level nodes. Both directions read positions
 * and the note's text, so neither needs the pane to be visible, scrolled or
 * measurable — which is the state a handoff reads a caret in, its own flush
 * being the one that hides the pane.
 */

/** Where each top-level node starts, in the model's own position space: every
 *  node's start is the sum of the sizes before it. */
function nodeStarts(view: EditorView): number[] {
  const count = view.state.doc.childCount
  const starts: number[] = new Array<number>(count)
  let at = 0
  for (let i = 0; i < count; i += 1) {
    starts[i] = at
    at += view.state.doc.child(i).nodeSize
  }
  return starts
}

/**
 * The note's blocks, paired with the model's own top-level nodes — or null when
 * the two cannot be paired.
 *
 * The blocks are read from the note's text and the nodes from the model's parse
 * of it, so a length mismatch means the two readings are out of step and nothing
 * can be paired: the caller uses the line↔offset mapping instead. Pair them
 * anyway and a line lands in the wrong paragraph, which is precisely the failure
 * this exists to remove.
 *
 * `content` is the caller's to supply because only it knows whether the model
 * holds the open tab's document at all; an empty string has no blocks, and the
 * pairing refuses exactly as it does for a mismatch.
 */
function pairedBlocks(view: EditorView, content: string) {
  const blocks = parseSourceBlocks(content)
  if (blocks.length === 0 || blocks.length !== view.state.doc.childCount) return null
  return blocks
}

/**
 * The document position a source line names: the block that line belongs to, and
 * how far into that block it sits.
 *
 * In NODE space rather than in pixels, deliberately. A block's own size is what
 * both directions can agree on without measuring anything, and it is the only
 * measure that holds for a block whose positions and whose text differ — a
 * table's rows and cells carry positions its text does not. The position this
 * places is therefore the position `documentLineFor` reports back.
 *
 * Null when the blocks and the nodes cannot be paired, which is the caller's
 * signal to use the line↔offset mapping instead.
 */
export function documentPositionFor(
  view: EditorView,
  content: string,
  line: number,
): number | null {
  const blocks = pairedBlocks(view, content)
  if (!blocks) return null
  const index = blockIndexForLine(blocks, line)
  if (index === null) return null
  const node = view.state.doc.child(index)
  const start = nodeStarts(view)[index]
  const within = Math.max(
    1,
    Math.min(Math.round(blockProgress(blocks, index, line) * node.nodeSize), node.nodeSize - 2),
  )
  return caretInside(view, start, start + within)
}

/**
 * `pos`, walked back to the nearest place the block can actually hold a caret.
 *
 * A position between a block's own children — the gap after a table's last row —
 * is inside the block and inside no text block at all, and `TextSelection.near`
 * settles such a position forward into the NEXT block, which is the failure this
 * route exists to remove. So the walk goes back instead, to the end of the last
 * text the block holds.
 *
 * `start + 1` is the last resort, since it is inside the block by construction; a
 * block with nothing to hold a caret in (a thematic break) has no earlier
 * position to offer, and the next text after it is the honest answer there.
 */
function caretInside(view: EditorView, start: number, pos: number): number {
  let at = pos
  while (at > start + 1 && !view.state.doc.resolve(at).parent.inlineContent) at -= 1
  return at
}

/**
 * The source line the caret sits on: the block the caret is in, and how far into
 * that block it is.
 *
 * Reads the selection rather than a pixel position, so it answers for a caret
 * whose place on screen cannot be read. Null when the blocks and the nodes cannot
 * be paired — the caller's signal to read the caret the pixel way instead.
 */
export function documentLineFor(view: EditorView, content: string): number | null {
  const blocks = pairedBlocks(view, content)
  if (!blocks) return null
  const doc = view.state.doc
  if (doc.childCount === 0) return null
  const head = view.state.selection.head
  // A caret at the very end of the document resolves past its last node, and the
  // last block's own end is what that means.
  const index = Math.min(doc.resolve(head).index(0), doc.childCount - 1)
  const size = doc.child(index).nodeSize
  const within = head - nodeStarts(view)[index]
  return blockLineFor(blocks, index, size > 0 ? within / size : 0)
}
