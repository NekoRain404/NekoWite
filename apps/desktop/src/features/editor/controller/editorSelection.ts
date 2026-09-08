import { useFloatStore } from '../../../stores/float'
import type { NekoEditor } from '@nekowite/editor-core'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

export interface SelectionDto {
  kind: 'image' | 'table' | 'floatbox' | 'text' | 'none'
  pos: number | null
  nodeType: string | null
}

export interface EditorSelectionDeps {
  getEditor: () => NekoEditor | null
}

export interface EditorSelection {
  /** Clear the floating-box / image / table selection. */
  clearSelection(): void
  /** Pointerdown capture handler that clears the float selection unless the
   *  target is inside a `.float-box` (so dragging a FloatBox keeps it). */
  handlePointerDown(e: PointerEvent): void
  /** The current float/sidebar-composite selection id (nullable). */
  selectedId(): string | null
  /** Derive an image/table/floatbox/text DTO from the editor selection. */
  derive(): SelectionDto
}

/**
 * Selection DTO for the rendered pane's image/table/float-toolbar.
 *
 * The float store owns the "which floating box is selected" verdict; this
 * controller wraps it and additionally derives a lightweight descriptor
 * (image / table / floatbox / text / none) that toolbars and property panels
 * can consume without probing ProseMirror internals themselves.
 */
export function createEditorSelection(deps: EditorSelectionDeps): EditorSelection {
  const floatStore = useFloatStore()

  function clearSelection(): void {
    floatStore.select(null)
  }

  function handlePointerDown(e: PointerEvent): void {
    const target = e.target as Element | null
    if (target && target.closest('.float-box')) return
    floatStore.select(null)
  }

  function selectedId(): string | null {
    return floatStore.selectedId
  }

  function derive(): SelectionDto {
    const editor = deps.getEditor()
    const view: EditorView | null = editor ? (() => { try { return editor.getView() } catch { return null } })() : null
    if (!view) return { kind: 'none', pos: null, nodeType: null }
    const { state } = view
    const from = state.selection.from
    for (let d = state.selection.$from.depth; d >= 0; d--) {
      const n = state.selection.$from.node(d)
      const ty = n.type.name
      const pos = state.selection.$from.before(d)
      if (ty === 'mdxComponent' && n.attrs.name === 'FloatBox') {
        return { kind: 'floatbox', pos, nodeType: ty }
      }
      if (ty === 'image') return { kind: 'image', pos, nodeType: ty }
      if (ty === 'table') return { kind: 'table', pos, nodeType: ty }
    }
    return { kind: 'text', pos: from, nodeType: state.selection.empty ? 'text' : 'text' }
  }

  return { clearSelection, handlePointerDown, selectedId, derive }
}
