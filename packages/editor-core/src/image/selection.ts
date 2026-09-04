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
  view: (view: EditorView) => {
    const sync = (): void => {
      const sel = view.state.selection
      emit(sel instanceof NodeSelection ? selectionToImage(sel) : null)
    }
    sync()
    return { update: sync, destroy: () => emit(null) }
  },
})
