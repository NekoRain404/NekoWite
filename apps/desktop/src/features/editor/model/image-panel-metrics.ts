/**
 * The numbers in the image panel's form, as arithmetic.
 *
 * They live here rather than in the component because the answer to "what size
 * is this image" has three sources that disagree, and a read-out that picks the
 * wrong one prints a size the picture does not have:
 *
 *  - the two attributes the schema stores (`width`, `height`),
 *  - the file's own pixels, which are what the browser draws at when neither is
 *    set, and what `height` is derived from when only one is,
 *  - and the panel's own displayed pair, which is the ratio the resize lock has
 *    to hold to — locking a distorted image must not silently undo the
 *    distortion the reader made on purpose.
 *
 * `clampWidth` is editor-core's, the same 1..4000 band the resize drag and the
 * width field already clamp to, so a pair produced here is in the range the rest
 * of the image code agrees on. `height` rounds the way `proportionalSize` does,
 * for the same reason: the two write the same attribute.
 */

import { clampWidth } from '@nekowite/editor-core'

export interface PanelSize {
  width: number
  height: number
}

/** Half a size: the attribute is absent (null) when the file does not say. */
export interface PanelSizePair {
  width: number | null
  height: number | null
}

/** Just the two fields read off an image element, so a caller need not hold a
 *  real one (and a test can hand over a literal). */
export type IntrinsicSource = Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>

/**
 * The file's own pixels, read from the `<img>` the node view already loaded.
 *
 * Reading that element rather than probing `attrs.src` is the whole point: the
 * document keeps the vault-relative src, which the webview cannot load, so a
 * probe of it always failed and 原始尺寸 showed `—` for every real image (with
 * the ratio the resize needs going with it). The node view's own element has
 * the resolved display URL and is already decoded.
 *
 * 0/0 is an image that has not loaded or failed, and is reported as unknown
 * rather than as a size.
 */
export function intrinsicSize(img: IntrinsicSource | null): PanelSize | null {
  if (!img) return null
  const { naturalWidth: width, naturalHeight: height } = img
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/** The width/height pair the browser draws, given the attrs and the file's size. */
export function displaySize(
  width: number | null,
  height: number | null,
  natural: PanelSize | null,
): PanelSizePair | null {
  if (width === null && height === null) {
    // Neither is set: the picture is drawn at its own size, or — with no size
    // known at all — at nothing the panel can name.
    return natural ? { ...natural } : null
  }
  const ratio = natural ? natural.width / natural.height : null
  if (width !== null && height === null) {
    return { width, height: ratio ? Math.max(1, Math.round(width / ratio)) : null }
  }
  if (width === null && height !== null) {
    return { width: ratio ? Math.max(1, Math.round(height * ratio)) : null, height }
  }
  return { width, height }
}

/**
 * The width/height ratio a locked resize holds to.
 *
 * The pair ON SCREEN wins: the reader may have set a height on purpose, and
 * turning the lock on is not a request to undo that. The file's own ratio is
 * what is left when only one half is set — and null, meaning "no lock
 * available", when neither is: a lock with no ratio to hold is a control that
 * would do nothing.
 */
export function lockRatio(
  width: number | null,
  height: number | null,
  natural: PanelSize | null,
): number | null {
  if (width !== null && height !== null) return width / height
  if (natural) return natural.width / natural.height
  return null
}

/** The pair for a width the reader typed, with the ratio held. */
export function pairForWidth(ratio: number, width: number): PanelSize {
  const next = clampWidth(width)
  return { width: next, height: Math.max(1, Math.round(next / ratio)) }
}

/** The pair for a height the reader typed, with the ratio held. */
export function pairForHeight(ratio: number, height: number): PanelSize {
  const next = clampWidth(height)
  return { width: Math.max(1, Math.round(next * ratio)), height: next }
}
