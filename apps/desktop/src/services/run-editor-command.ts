/**
 * Run an editor command against the pane that owns the document.
 *
 * Builtin commands are ProseMirror commands, and plugin commands resolve the
 * rendered view themselves. Either way they write to the **rendered** model,
 * which stops being the live document the moment the source pane takes over:
 * the edit lands in a hidden, stale model and is lost (or is later overwritten
 * when the model is re-opened from the tab).
 *
 * The toolbar, its registry buttons and the command palette all dispatch
 * through here so a button behaves the same in every view mode:
 *
 *   - source mode (and split mode while CodeMirror has focus) uses the
 *     Markdown-level implementation — a text transform for the formatting
 *     commands, a Markdown template for the node-inserting ones;
 *   - anything else falls through to the registry, i.e. the rendered editor.
 */

import { getCommand, getMarkdownCommand, getToolbar } from '@nekowite/editor-core'
import { sourcePaneOwnsInput } from './editor-ownership'
import { getSourceView } from './source-view'
import { insertSourceText, runSourceCommand } from './source-commands'

/**
 * Run `id`. Returns false when nothing handled it, so a caller can tell a real
 * dispatch from a silent no-op.
 */
export function runEditorCommand(id: string): boolean {
  if (sourcePaneOwnsInput()) {
    const sourceView = getSourceView()
    if (sourceView) {
      // A node-inserting command publishes its Markdown equivalent; prefer it
      // over the text transforms, which do not know about it.
      const produce = getMarkdownCommand(id)
      if (produce) {
        const produced = produce()
        if (typeof produced === 'string') insertSourceText(sourceView, produced)
        else insertSourceText(sourceView, produced.text, produced.caret)
        return true
      }
      if (runSourceCommand(sourceView, id)) return true
    }
  }
  const cmd = getCommand(id)
  if (cmd) {
    cmd.run()
    return true
  }
  // A plugin may contribute a toolbar button without registering a command
  // (the callout and floatbox do). Those ids only exist in the toolbar
  // registry, so the lookup has to fall back to it or the button would stop
  // working entirely.
  const item = getToolbar().find((entry) => entry.id === id)
  if (!item) return false
  item.run()
  return true
}
