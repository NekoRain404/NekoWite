import type { NekoEditor } from '@nekowite/editor-core'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

let editor: NekoEditor | null = null

export const editorBridge = {
  setEditor(e: NekoEditor | null): void {
    editor = e
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
