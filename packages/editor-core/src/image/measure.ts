/**
 * The real size of the image a resize is about to change.
 *
 * `width`/`height` absent mean "the file's own size" — not zero, and not 1. Both
 * resize paths therefore have to answer "how big is this picture really" before
 * they change anything, or they write a size the picture never had into the
 * user's document (and, with Shift, persist a ratio that belongs to no image).
 *
 * There is exactly one source for that answer: the `<img>` the node view
 * rendered. It is the only element that carries the resolved display URL — the
 * document keeps the vault-relative src, which the webview cannot load — so its
 * `naturalWidth`/`naturalHeight` are the file's pixels as decoded.
 *
 * 0/0 is an element that has not loaded, or failed; it is "unknown", never a
 * size. What a caller does with "unknown" is its own call: the drag must stay
 * usable mid-gesture and keeps its stand-in, while the keyboard resize refuses
 * (a no-op the reader can see beats a document quietly reshaped).
 */

import type { EditorView } from '@milkdown/prose/view'

export interface ImageSize {
  width: number
  height: number
}

/** Just the two fields read off an `<img>`, so a caller need not hold a real
 *  element (and a test can hand over a literal). */
export type IntrinsicSource = Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>

/**
 * The file's own pixels, or null when the element has not loaded (0/0) or there
 * is no element at all.
 */
export function intrinsicSize(img: IntrinsicSource | null): ImageSize | null {
  if (!img) return null
  const { naturalWidth: width, naturalHeight: height } = img
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * The node view's own `<img>` for the node at `pos`, or null when it renders
 * none.
 *
 * The drag reads its element off the pointer event; the keyboard has no such
 * target, so it asks the view for the node's DOM and takes the image inside it —
 * the same lookup the image panel's form does. `nodeDOM` can throw on a stale
 * position, and a position that is not an image renders no `<img>`; both are
 * "no element", which the callers already treat as "size unknown".
 */
export function imageElementAt(view: EditorView, pos: number): HTMLImageElement | null {
  try {
    const dom = view.nodeDOM(pos)
    return dom instanceof HTMLElement ? dom.querySelector('img') : null
  } catch {
    return null
  }
}

/**
 * The width/height pair an aspect-locked (Shift) resize holds to, or null when
 * there is no ratio to hold.
 *
 * The pair the document already states wins when both halves are set: the reader
 * may have set one on purpose, and locking the ratio must not undo that. The
 * file's own pixels are what is left when only one half is — pairing a stored
 * width with a pixel height (or the reverse) mixes two different pictures and
 * locks a ratio neither of them has, which is what a stand-in for the missing
 * half used to do.
 */
export function lockPair(
  width: number | null,
  height: number | null,
  natural: ImageSize | null,
): ImageSize | null {
  if (width !== null && height !== null) return { width, height }
  if (natural) return { width: natural.width, height: natural.height }
  return null
}
