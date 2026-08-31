import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { editorBridge } from '../services/editorBridge'

type EditorView = NonNullable<ReturnType<NekoEditor['getView']>>

export const useFloatStore = defineStore('float', () => {
  const selectedId = ref<string | null>(null)
  const activePos = ref<number | null>(null)

  function select(id: string | null, pos?: number | null): void {
    selectedId.value = id
    activePos.value = id == null ? null : (pos ?? null)
  }

  function bumpZ(step: number): void {
    const pos = activePos.value
    if (pos == null) return
    const view = editorBridge.getView()
    if (!view) return
    const node = view.state.doc.nodeAt(pos)
    if (!node) return
    const props = (node.attrs.props ?? {}) as Record<string, string>
    const z = Number(props.z ?? 1)
    updateNode(view, pos, { ...props, z: String(z + step) })
  }

  function updateNode(view: EditorView, pos: number, props: Record<string, string>): void {
    const node = view.state.doc.nodeAt(pos)
    if (!node) return
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        props,
      }),
    )
  }

  function bringForward(): void {
    bumpZ(1)
  }

  function sendBackward(): void {
    bumpZ(-1)
  }

  function removeSelected(): void {
    const pos = activePos.value
    if (pos == null) return
    const view = editorBridge.getView()
    if (!view) return
    const node = view.state.doc.nodeAt(pos)
    if (!node) return
    view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize))
    select(null)
  }

  return { selectedId, activePos, select, bringForward, sendBackward, removeSelected }
})