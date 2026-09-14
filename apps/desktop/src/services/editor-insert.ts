/**
 * Mode-aware insertion at the caret.
 *
 * The app has two editors over one document: the rendered ProseMirror pane and
 * the CodeMirror source pane. `NekoEditor.insertMarkdownAtCursor` parses the
 * snippet and replaces the ProseMirror selection, which is correct only while
 * the rendered pane owns the text. In source mode that editor is hidden and its
 * model is stale, so routing an insert there either does nothing visible or
 * replaces the raw Markdown the user is typing with the serializer's canonical
 * form — data loss.
 *
 * Every feature that inserts Markdown (image intake, the attachment library,
 * chat, citation insert) goes through here so it lands in the pane that
 * actually owns the document.
 */

import { editorSessionManager } from '../features/editor/session-manager'
import { getSourceView } from './source-view'
import { insertSourceText } from './source-commands'
import { sourcePaneOwnsInput } from './editor-ownership'

export { sourcePaneOwnsInput }

/**
 * Insert `markdown` at the caret of whichever pane owns the document.
 *
 * Returns false when there is no pane that can accept it, so callers can
 * surface an error instead of appearing to succeed while dropping the content.
 */
export async function insertMarkdownAtCursor(markdown: string): Promise<boolean> {
  if (sourcePaneOwnsInput()) {
    const sourceView = getSourceView()
    if (!sourceView) return false
    insertSourceText(sourceView, markdown)
    return true
  }
  const editor = editorSessionManager.getActiveEditor()
  if (!editor) return false
  await editor.insertMarkdownAtCursor(markdown)
  return true
}
