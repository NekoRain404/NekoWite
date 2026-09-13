import type { NekoEditor } from '@nekowite/editor-core'
import { citeToMarkdown } from '@nekowite/editor-core'
import {
  editorSessionManager,
  EDITOR_BRIDGE_LEGACY_TAB,
} from '../features/editor/sessionManager'
import { getSourceView } from './sourceView'
import { insertSourceText } from './sourceCommands'
import { sourcePaneOwnsInput } from './editorInsert'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

/**
 * Backward-compat shim over the {@link editorSessionManager}.
 *
 * New code should depend on the session manager directly (or on the active-tab
 * editor) instead of this module. This module is kept ONLY for the app
 * bootstrap (which lives in `app/` and is out of scope for this migration) and
 * for tests that register a fake editor through `setEditor`. It forwards every
 * accessor to the session manager so business code and the compat surface never
 * diverge.
 */
export const editorBridge = {
  /** Register (or clear) the "current" editor. When given a real editor it is
   * registered under a reserved tab id and promoted to active; `null` tears
   * down everything. */
  setEditor(e: NekoEditor | null): void {
    if (e) {
      editorSessionManager.createSession(EDITOR_BRIDGE_LEGACY_TAB, () => e)
    } else {
      editorSessionManager.destroyAll()
    }
  },
  getEditor(): NekoEditor | null {
    return editorSessionManager.getActiveEditor()
  },
  getView(): EditorView | null {
    return editorSessionManager.getView()
  },
  /**
   * Subscribe to editor (re)creation. The editor is created lazily after the
   * first tab opens, so panels that need it must subscribe rather than probe
   * once at mount.
   */
  onEditorChange(cb: (e: NekoEditor | null) => void): () => void {
    return editorSessionManager.subscribe(cb)
  },
}

export function insertCiteAtCursor(key: string): void {
  // Source mode: the rendered model is stale, so the citation's Markdown form
  // goes at the CodeMirror caret instead of into the hidden document.
  if (sourcePaneOwnsInput()) {
    const sourceView = getSourceView()
    if (sourceView) insertSourceText(sourceView, citeToMarkdown(key))
    return
  }
  const view = editorSessionManager.getView()
  if (!view) return
  const { state } = view
  const type = state.schema.nodes.cite
  if (!type) return
  const node = type.create({ key })
  view.dispatch(state.tr.replaceSelectionWith(node))
}
