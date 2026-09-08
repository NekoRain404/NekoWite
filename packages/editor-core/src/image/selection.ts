/**
 * Image selection tracking for the property panel.
 *
 * The image property panel needs to know (a) that an image is selected and
 * (b) the exact ProseMirror position so attrs can be written back with a
 * single transaction. A ProseMirror Plugin watches the selection on every
 * transaction and push + clears state whenever a NodeSelection lands on an
 * `image` node. Subscribers in the desktop layer (the ImagePanel) react to
 * open/close the panel; the position is the source of truth for attr writes.
 *
 * This module is deliberately side-effect free apart from its own listener
 * set, so the open/close contract is unit-testable without a full editor.
 */

import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { NodeSelection } from '@milkdown/prose/state'
import type { Node } from '@milkdown/prose/model'

export interface ImageSelectionState {
  /** ProseMirror position of the selected image node. */
  pos: number
  /** The selected image node. */
  node: Node
}

export const IMAGE_SELECTION_PLUGIN_KEY = new PluginKey('nekowite.imageSelection')

type Listener = (state: ImageSelectionState | null) => void

const listeners = new Set<Listener>()
let current: ImageSelectionState | null = null

/** Subscribe to image selection changes; returns an unsubscribe function. */
export function onImageSelectionChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current selection (or null). */
export function getSelectedImage(): ImageSelectionState | null {
  return current
}

/** Clear the selection and notify (used on destroy / editor switch). */
export function clearImageSelection(): void {
  current = null
  for (const l of listeners) l(null)
}

function emit(state: ImageSelectionState | null): void {
  if (current === state) return
  current = state
  for (const l of listeners) l(state)
}

function selectionToImage(selection: NodeSelection): ImageSelectionState | null {
  const node = selection.node
  if (node.type.name !== 'image') return null
  return { pos: selection.from, node }
}

/**
 * The ProseMirror plugin that keeps `current` (and the listener set) in sync
 * with the live selection. When the selection moves away from an image (or the
 * editor is destroyed) it emits `null` so the panel closes.
 */
export const imageSelectionPlugin = new Plugin({
  key: IMAGE_SELECTION_PLUGIN_KEY,
  props: {
    // Click-to-select: the image is an atom, so ProseMirror's default click
    // would place a text caret NEXT to it (and never reach a NodeSelection,
    // which is what opens the property panel — only the arrow-key image keymap
    // produced one before). The click-position `pos` is the text position BESIDE
    // the atom, so detect the click by its DOM target (the image node view's
    // `.neko-image` figure), resolve the node's real position via posAtDOM, and
    // select it. Returning `true` (handled) stops PM's default caret placement.
    handleClick: (view, _pos, event) => {
      const target = event.target as Element | null
      const figure = target?.closest?.('.neko-image')
      if (!figure) return false
      const nodePos = view.posAtDOM(figure, 0)
      const node = view.state.doc.nodeAt(nodePos)
      if (!node || node.type.name !== 'image') return false
      const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos))
      if (!tr.selection.eq(view.state.selection)) view.dispatch(tr)
      return true
    },
  },
  view: (view: EditorView) => {
    const sync = (): void => {
      const sel = view.state.selection
      emit(sel instanceof NodeSelection ? selectionToImage(sel) : null)
    }
    sync()
    return { update: sync, destroy: () => emit(null) }
  },
})
