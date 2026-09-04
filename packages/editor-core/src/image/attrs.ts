/**
 * Attribute-writing helpers for the image property panel.
 *
 * Every operation here dispatches exactly ONE transaction, so a panel edit
 * (alt/title/link/width/align, restore-size, replace, delete) is a single undo
 * step — matching the resize drag's single-undo-per-gesture policy. The panel
 * calls these against the live EditorView; they are pure transaction builders
 * over ProseMirror state, which keeps them unit-testable in isolation.
 *
 * The image node is an atom and a NodeSelection gives us its exact `pos`.
 * `pos` from NodeSelection points at the node itself (its start), so
 * `view.state.tr` operations below are valid for that position.
 */

import type { EditorView } from '@milkdown/prose/view'
import type { Node } from '@milkdown/prose/model'

export interface ImagePatch {
  src?: string
  alt?: string
  title?: string
  width?: number | null
  height?: number | null
  align?: 'left' | 'center' | 'right' | null
}

/** The node id at `pos` is an image or we cannot safely patch it. */
function imageNodeAt(view: EditorView, pos: number): Node | null {
  const node = view.state.doc.nodeAt(pos)
  return node && node.type.name === 'image' ? node : null
}

/**
 * Set a single attribute transaction for the image at `pos` in a way that is
 * always a single undo step. Returns the node id patched, or null when the
 * position is not an image.
 */
export function updateImageAttrs(
  view: EditorView,
  pos: number,
  patch: ImagePatch,
): Node | null {
  const node = imageNodeAt(view, pos)
  if (!node) return null
  const next = { ...node.attrs, ...patch }
  view.dispatch(
    view.state.tr
      .setNodeMarkup(pos, undefined, next)
      .scrollIntoView(),
  )
  return node
}

/** Reset width/height to the intrinsic dimensions (null attrs). Single undo. */
export function restoreImageSize(view: EditorView, pos: number): Node | null {
  return updateImageAttrs(view, pos, { width: null, height: null })
}

/** Replace the image src with a new path/url. Single undo. */
export function replaceImageSrc(view: EditorView, pos: number, src: string): Node | null {
  return updateImageAttrs(view, pos, { src })
}

/** Delete the image node at `pos`. Single undo. */
export function deleteImageNode(view: EditorView, pos: number): boolean {
  const node = imageNodeAt(view, pos)
  if (!node) return false
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView())
  return true
}

/** Read the current image attrs at `pos` (for the panel's initial values). */
export function getImageAttrs(view: EditorView, pos: number): ImagePatch | null {
  const node = imageNodeAt(view, pos)
  if (!node) return null
  return {
    src: node.attrs.src,
    alt: node.attrs.alt,
    title: node.attrs.title,
    width: node.attrs.width,
    height: node.attrs.height,
    align: node.attrs.align,
  }
}
