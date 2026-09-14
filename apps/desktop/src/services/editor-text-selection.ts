/**
 * Read and replace the current text selection in whichever pane owns the
 * document.
 *
 * A selection-scoped operation (an AI rewrite, a future "replace with…") has
 * to ask the live pane, not the rendered one: in source mode the rendered model
 * is hidden, stale, and about to be re-opened from the tab, so an edit applied
 * there is silently discarded.
 */

import { editorSessionManager } from '../features/editor'
import { selectionTextOf } from '../features/editor/model/selection-text'
import { sourcePaneOwnsInput } from './editor-ownership'
import { getSourceView } from './source-view'
import { insertSourceText } from './source-commands'

export interface TextSelection {
  /** Character offsets into the pane's own document. */
  from: number
  to: number
  text: string
}

/** The selected text, or null when there is no selection to operate on. */
export function getTextSelection(): TextSelection | null {
  if (sourcePaneOwnsInput()) {
    const view = getSourceView()
    if (!view) return null
    const range = view.state.selection.main
    if (range.empty) return null
    return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) }
  }
  const view = editorSessionManager.getView()
  if (!view) return null
  const { from, to, empty } = view.state.selection
  if (empty) return null
  // The shared payload builder, not `textBetween(from, to, '\n', ' ')`: a
  // STRING leafText replaces every atom with a space, so an AI rewrite of a
  // paragraph containing a formula was being handed the formula as a blank.
  return { from, to, text: selectionTextOf(view.state.doc, from, to) }
}

/**
 * Replace the selection with `text`.
 *
 * The offsets come from {@link getTextSelection}, so they are only valid for
 * the pane that produced them — this re-resolves the pane rather than trusting
 * a caller-held view, and reports false when it cannot apply.
 */
export function replaceTextSelection(
  text: string,
  expected?: { from: number; to: number; text: string } | null,
): boolean {
  if (expected) return replaceCapturedRange(text, expected)
  if (sourcePaneOwnsInput()) {
    const view = getSourceView()
    if (!view) return false
    insertSourceText(view, text)
    return true
  }
  const view = editorSessionManager.getView()
  if (!view) return false
  const { from, to } = view.state.selection
  view.dispatch(view.state.tr.insertText(text, from, to))
  view.focus()
  return true
}

/**
 * The verification half of a CAPTURED replacement.
 *
 * An AI rewrite is decided seconds (or, with a reasoning model, tens of seconds)
 * after the user selected the text, and re-reading the LIVE selection at that
 * point is wrong in three ways that all end with the wrong document being
 * edited: clicking elsewhere collapses the selection to a caret, so the answer
 * is INSERTED at the new spot while the original text stays (a duplicated,
 * misplaced paragraph); switching notes makes the live selection belong to a
 * DIFFERENT note, so one note answer is written into another; and any edit that
 * shifts the document moves the offsets, so the answer overwrites whatever now
 * sits there. None of those produced an error — `replaceTextSelection` returned
 * true.
 *
 * So the pane must still be the same one, the range must still exist, and the
 * text in it must be exactly what was sent. Otherwise the caller is told and the
 * answer is discarded rather than written somewhere the user did not ask for.
 */
function replaceCapturedRange(
  text: string,
  expected: { from: number; to: number; text: string },
): boolean {
  if (sourcePaneOwnsInput()) {
    const view = getSourceView()
    if (!view) return false
    const size = view.state.doc.length
    if (expected.to > size || expected.from >= expected.to) return false
    if (view.state.sliceDoc(expected.from, expected.to) !== expected.text) return false
    view.dispatch({
      changes: { from: expected.from, to: expected.to, insert: text },
      selection: { anchor: expected.from + text.length },
    })
    return true
  }
  const view = editorSessionManager.getView()
  if (!view) return false
  const size = view.state.doc.content.size
  if (expected.to > size || expected.from >= expected.to) return false
  if (view.state.doc.textBetween(expected.from, expected.to, '\n', ' ') !== expected.text) {
    return false
  }
  view.dispatch(view.state.tr.insertText(text, expected.from, expected.to))
  view.focus()
  return true
}
