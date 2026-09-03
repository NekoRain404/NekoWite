import type { NekoEditor } from '@nekowite/editor-core'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

let editor: NekoEditor | null = null
const editorListeners = new Set<(e: NekoEditor | null) => void>()

export const editorBridge = {
  setEditor(e: NekoEditor | null): void {
    editor = e
    editorListeners.forEach((cb) => cb(e))
  },
  getEditor(): NekoEditor | null {
    return editor
  },
  getView(): EditorView | null {
    if (!editor) return null
    try {
      return editor.getView()
    } catch {
      return null
    }
  },
  /**
   * Subscribe to editor (re)creation. The editor is created lazily after the
   * first tab opens, so panels that need it must subscribe rather than probe
   * once at mount.
   */
  onEditorChange(cb: (e: NekoEditor | null) => void): () => void {
    editorListeners.add(cb)
    return () => {
      editorListeners.delete(cb)
    }
  },
}

export function insertCiteAtCursor(key: string): void {
  const view = editorBridge.getView()
  if (!view) return
  const { state } = view
  const type = state.schema.nodes.cite
  if (!type) return
  const node = type.create({ key })
  view.dispatch(state.tr.replaceSelectionWith(node))
}
