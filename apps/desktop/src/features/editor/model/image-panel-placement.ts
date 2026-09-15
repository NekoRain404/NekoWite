/**
 * Where the image property panel goes, as arithmetic.
 *
 * A sibling of `table-toolbar-placement.ts` rather than a reuse of it. The rules
 * are the same two the table toolbar established — sit next to the thing you are
 * editing, and never leave your own panel — but the geometry they are asked
 * about is not: the toolbar is a one-line strip of buttons that must not cover
 * the cell the CARET is in, and it is re-placed as the caret moves; the panel is
 * a 240px column of fields anchored to a SELECTED node, and it is taller than
 * most of the images it edits.
 *
 * What `placeTableToolbar` would answer for an image is not a smaller version of
 * this: it anchors horizontally to the table's left edge and falls back to
 * pinning to the panel's top edge whenever neither side above nor below has
 * room — which is the defect this module exists to remove, since "the top edge"
 * is where the panel used to live (`absolute; top: 0`) and what the report was
 * about. The image case needs the two things that module does not do: prefer a
 * SIDE of the anchor over its top, and clear the anchor vertically when it has
 * to overlap it.
 *
 * Every rect arrives in viewport coordinates (`getBoundingClientRect`), which is
 * also what the panel is positioned in (`position: fixed`), so no scroll offset
 * is added or subtracted anywhere down here.
 */

import type { Rect } from './table-toolbar-placement'

export interface ImagePanelPlacement {
  /** Viewport coordinates of the panel's top-left corner. */
  top: number
  left: number
}

export interface ImagePanelPlacementInput {
  /** The image's own box: the node view's `figure.neko-image`, which is
   *  inline-sized, so this is the picture rather than the line it sits on. */
  image: Rect
  /** The pane the panel may never leave: its editing column (`.rendered-pane`). */
  panel: Rect
  /** The panel's own measured size (it is rendered to be measured, then placed). */
  size: { width: number; height: number }
  /** Pixels between the panel and the image / pane edges. */
  gap?: number
}

/** Pixels between the panel and the image / pane edges. */
export const IMAGE_PANEL_GAP = 8

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max))

/**
 * Place the panel for one frame.
 *
 * The rules, in the order they decide:
 *
 * 1. **Beside the image: its right side, else its left side**, whichever one the
 *    pane has room for. The right is preferred because that is where the panel
 *    already sat (`right: 8px` inside the column), so a reader who knows it keeps
 *    their bearings; the left is what an image that reaches the pane's right edge
 *    leaves.
 * 2. **When neither side has room** — a full-width image in an editing column,
 *    which is the common case — the panel has to overlap the image's column. It
 *    then clears the image vertically instead of covering it: below it when below
 *    fits in the pane, above it when that is where the room is, and otherwise
 *    level with the image's top (nothing fits, so the overlap is accepted).
 * 3. **Clamped inside the pane on both axes, always.** An image scrolled out of
 *    the pane does NOT hide the panel the way the table toolbar hides itself: a
 *    toolbar belongs to a caret and this belongs to a selection, which survives
 *    scrolling — and a panel that vanished and came back would re-run its focus
 *    trap on every pass. It clamps to the edge it left through and follows the
 *    image back.
 */
export function placeImagePanel(input: ImagePanelPlacementInput): ImagePanelPlacement {
  const gap = input.gap ?? IMAGE_PANEL_GAP
  const { image, panel, size } = input

  // 1. Horizontal, at the anchor's right edge or its left, whichever fits.
  const besideRight = image.right + gap
  const besideLeft = image.left - gap - size.width
  let left: number
  if (besideRight + size.width <= panel.right - gap) left = besideRight
  else if (besideLeft >= panel.left + gap) left = besideLeft
  // 2. No room either side: overlap the image's own right edge, which is where
  //    the panel sat before it floated at all.
  else left = image.right - size.width

  // The clamp is what the overlap test below reads, so it runs first: a pane
  // narrow enough to push the panel back over the image has to be seen as an
  // overlap, or the panel would cover the picture it is editing.
  const maxLeft = Math.max(panel.left + gap, panel.right - gap - size.width)
  left = clamp(left, panel.left + gap, maxLeft)

  const overlaps = left < image.right && left + size.width > image.left
  let top = image.top
  if (overlaps) {
    const below = image.bottom + gap
    const above = image.top - gap - size.height
    if (below + size.height <= panel.bottom - gap) top = below
    else if (above >= panel.top + gap) top = above
  }

  // 3. Inside the pane, whichever of the placements was chosen. When the pane is
  //    too small to hold the panel at all both clamps invert, and the top-left
  //    corner wins: the title and the first fields are what has to stay reachable.
  const maxTop = Math.max(panel.top + gap, panel.bottom - gap - size.height)
  return {
    top: clamp(top, panel.top + gap, maxTop),
    left,
  }
}
