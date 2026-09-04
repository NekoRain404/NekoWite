/**
 * Keyboard width adjust for a selected image.
 *
 * When the image is selected (NodeSelection) and the user presses the arrow
 * keys, the width (and optionally height, holding Shift for a proportional
 * lock) steps by KEY_STEP px. Each key press dispatches exactly one transaction
 * -> one undo step, preserving the single-undo-per-gesture policy.
 *
 * The pure math lives in resize.ts so the step/ratio logic is unit-testable;
 * this module only wires it to the ProseMirror keydown pipeline.
 */

import { Plugin, NodeSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { KEY_STEP, proportionalSize } from './resize'

export const IMAGE_KEYMAP_PLUGIN_KEY = 'nekowite.imageKeymap'

export const imageKeymapPlugin = new Plugin({
  props: {
    handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
      if (!(view.state.selection instanceof NodeSelection)) return false
      const sel = view.state.selection as NodeSelection
      const node = sel.node
      if (node.type.name !== 'image') return false
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return false
      event.preventDefault()

      const pos = sel.from
      const step = KEY_STEP
      const dir = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
      const currentWidth = Number(node.attrs.width)
      const currentHeight = Number(node.attrs.height)
      const baseWidth = Number.isFinite(currentWidth) && currentWidth > 0 ? currentWidth : 1
      const baseHeight = Number.isFinite(currentHeight) && currentHeight > 0 ? currentHeight : 400

      // Step a width-only resize. Shift+arrow locks the aspect ratio so the
      // height follows proportionally (a full two-dimension, single-undo step).
      const target = Math.max(1, baseWidth + dir * step)
      if (event.shiftKey) {
        const { width, height } = proportionalSize(baseWidth, baseHeight, target)
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width, height }),
        )
      } else {
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: target }),
        )
      }
      return true
    },
  },
})
