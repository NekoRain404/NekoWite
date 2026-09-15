/**
 * Committing an image resize without ending the selection that asked for it.
 *
 * `setNodeMarkup` on a leaf node is a ReplaceStep AT the selection's anchor, and
 * ProseMirror reads that anchor boundary as deleted: `NodeSelection.map` answers
 * with `Selection.near()`, which the image's parent paragraph (inline content)
 * resolves to a text CARET beside the picture. So the app's own change ended the
 * selection the reader had made — the property panel closed on the resize it
 * came from, and the next arrow key found a caret, declined, and moved the caret
 * instead of the image. A keyboard resize worked ONCE per click; every further
 * step needed the image clicked again.
 *
 * Both resize paths commit through here, so neither can take the selection away:
 * the width step and the drag's final commit are the same write, and both leave
 * the image selected the way the reader left it.
 *
 * Setting the selection on the SAME transaction is what keeps it: the map never
 * runs, and the step is still one dispatch and one undo step. The selection is
 * built from the post-step document via ./selection's `imageSelectionAt`, so it
 * can only name the image the step actually left at `pos` — never the node that
 * replaced it, and never a position belonging to a document this one is not.
 */

import type { EditorView } from '@milkdown/prose/view'

import { imageSelectionAt } from './selection'

/**
 * Write `attrs` onto the image at `pos`, leaving that image selected.
 *
 * `setNodeMarkup` throws on a position with no node, exactly as it did at every
 * call site before; a position that holds something that is not an image is
 * written as asked but is not made into an image selection.
 */
export function commitImageResize(
  view: EditorView,
  pos: number,
  attrs: Record<string, unknown>,
): void {
  const tr = view.state.tr.setNodeMarkup(pos, undefined, attrs)
  const selection = imageSelectionAt(tr.doc, pos)
  if (selection) tr.setSelection(selection)
  view.dispatch(tr)
}
