/**
 * Keyboard width adjust for a selected image.
 *
 * When the image is selected (NodeSelection) and the user presses the arrow
 * keys, the width (and optionally height, holding Shift for a proportional
 * lock) steps by KEY_STEP px. Each key press dispatches exactly one transaction
 * -> one undo step, preserving the single-undo-per-gesture policy.
 *
 * The pure math lives in resize.ts so the step/ratio logic is unit-testable;
 * this module only wires it to the ProseMirror keydown pipeline. Where the step
 * STARTS, and the ratio a Shift lock holds, are ./measure's `resizeBasis` — the
 * same call the drag makes off its own element, so one gesture cannot form two
 * ratios — and a resize that cannot establish the size at all is refused rather
 * than stepped from a stand-in.
 *
 * The commit itself is ./resize-commit, which keeps the image selected: without
 * it each press ended the selection it was acting on, so only the first arrow of
 * a selection did anything.
 */

import { Plugin, NodeSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { KEY_STEP, proportionalSize } from './resize'
import { imageElementAt, resizeBasis } from './measure'
import { commitImageResize } from './resize-commit'

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

      // Both answers — the width the step starts from, and the pair a Shift
      // lock holds to — come from ./measure's `resizeBasis`, the same call the
      // drag makes off its own element: answering them separately is how the
      // drag came to lock 300/300 where this path locked 1200/300 for the very
      // same picture.
      const { baseWidth, lock } = resizeBasis(node.attrs, imageElementAt(view, pos))

      // Nothing to step from: consume the keystroke (no caret jump, no scroll)
      // and change nothing. The alternative is what this used to do — step from
      // a stand-in of 1 and write that size into the file.
      if (baseWidth === null) return true

      const target = Math.max(1, baseWidth + dir * step)

      if (!event.shiftKey) {
        commitImageResize(view, pos, { ...node.attrs, width: target })
        return true
      }

      // Shift+arrow locks the aspect ratio so the height follows proportionally
      // (a full two-dimension, single-undo step). No ratio to hold means no
      // resize: an invented one reshapes the picture and is persisted as a real
      // height.
      if (!lock) return true
      const { width, height } = proportionalSize(lock.width, lock.height, target)
      commitImageResize(view, pos, { ...node.attrs, width, height })
      return true
    },
  },
})
