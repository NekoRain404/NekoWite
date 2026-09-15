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
 * STARTS is not pure math: an absent `width` means the file's own size, so the
 * real size is measured off the node view's element first (see ./measure) — the
 * same source the drag reads its start width from — and a resize that cannot
 * establish it is refused rather than stepped from a stand-in.
 */

import { Plugin, NodeSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { KEY_STEP, proportionalSize } from './resize'
import { imageElementAt, intrinsicSize, lockPair } from './measure'

export const IMAGE_KEYMAP_PLUGIN_KEY = 'nekowite.imageKeymap'

/** A positive, finite dimension, or null — absent, 0 and NaN all mean the
 *  document states no size (the schema's default is null, not 0). */
function stated(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

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

      // The size the step starts from: the attribute the document states, else
      // the width the browser draws, else the file's own pixels — the order the
      // drag's start width uses, so a step matches what the reader sees.
      const img = imageElementAt(view, pos)
      const natural = intrinsicSize(img)
      const storedWidth = stated(node.attrs.width)
      const drawnWidth = img && img.clientWidth > 0 ? img.clientWidth : null
      const baseWidth = storedWidth ?? drawnWidth ?? natural?.width ?? null

      // Nothing to step from: consume the keystroke (no caret jump, no scroll)
      // and change nothing. The alternative is what this used to do — step from
      // a stand-in of 1 and write that size into the file.
      if (baseWidth === null) return true

      const target = Math.max(1, baseWidth + dir * step)

      if (!event.shiftKey) {
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: target }),
        )
        return true
      }

      // Shift+arrow locks the aspect ratio so the height follows proportionally
      // (a full two-dimension, single-undo step). No ratio to hold — see
      // ./measure — means no resize: an invented one reshapes the picture and
      // is persisted as a real height.
      const lock = lockPair(storedWidth, stated(node.attrs.height), natural)
      if (!lock) return true
      const { width, height } = proportionalSize(lock.width, lock.height, target)
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width, height }),
      )
      return true
    },
  },
})
