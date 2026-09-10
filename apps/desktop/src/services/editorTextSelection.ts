/**
 * Read and replace the current text selection in whichever pane owns the
 * document.
 *
 * A selection-scoped operation (an AI rewrite, a future "replace with…") has
 * to ask the live pane, not the rendered one: in source mode the rendered model
 * is hidden, stale, and about to be re-opened from the tab, so an edit applied
 * there is silently discarded.
 */

import { editorSessionManager } from '../features/editor/sessionManager'
import { sourcePaneOwnsInput } from './editorOwnership'
import { getSourceView } from './sourceView'
import { insertSourceText } from './sourceCommands'

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
  return { from, to, text: view.state.doc.textBetween(from, to, '\n', ' ') }
}

/**
 * Replace the selection with `text`.
 *
 * The offsets come from {@link getTextSelection}, so they are only valid for
 * the pane that produced them — this re-resolves the pane rather than trusting
 * a caller-held view, and reports false when it cannot apply.
 */
export function replaceTextSelection(text: string): boolean {
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
