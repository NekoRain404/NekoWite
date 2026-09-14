import type { Node as ProseNode } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'

/**
 * Load `doc` as a brand-new editor state.
 *
 * The load is applied to an EMPTY document first, purely to let ProseMirror
 * place the caret: `replaceWith` maps the selection to the end of the inserted
 * content, so the caret ends up where a normal "open a note" leaves it (after
 * the last character of the first line for a one-line note) without this code
 * having to reason about node sizes. The resulting state is then rebuilt from
 * scratch, which is the point: dispatching the replace with `addToHistory:
 * false` kept the PREVIOUS note's edits on the undo stack, so the first Cmd+Z
 * after switching notes consumed one of those stale events — `undoDepth` went
 * from 1 to 0 while the new note did not change, which reads as "undo is
 * broken". `EditorState.create` starts with an empty history.
 */
export function openState(prev: EditorState, doc: ProseNode): EditorState {
  const seed = EditorState.create({
    doc: prev.schema.topNodeType.createAndFill() ?? doc,
    plugins: prev.plugins,
  })
  const seeded = seed.tr.replaceWith(0, seed.doc.content.size, doc)
  const selection = seeded.selection
  return EditorState.create({
    doc,
    selection,
    storedMarks: seed.storedMarks ?? undefined,
    plugins: prev.plugins,
  })
}
