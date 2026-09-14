/**
 * Where the table toolbar goes, as arithmetic.
 *
 * Pure so the four positioning rules can be tested without a browser, and so
 * the component that renders the toolbar only converts the answer into styles.
 * Every rect arrives in viewport coordinates (`getBoundingClientRect`), which is
 * also what the toolbar is positioned in (`position: fixed`), so no scroll
 * offset is added or subtracted anywhere down here.
 */

export interface Rect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface PlacementInput {
  /** The table the caret is in. */
  table: Rect
  /** The panel that table lives in: the toolbar may never leave it. */
  panel: Rect
  /** The cell the caret is in — what the toolbar must not cover. */
  cell: Rect
  /** The toolbar's own size (it is rendered to be measured, then placed). */
  toolbar: { width: number; height: number }
  /** Gap between the toolbar and the edge it is anchored to. */
  gap?: number
}

export interface Placement {
  /** Viewport coordinates of the toolbar's top-left corner. */
  top: number
  left: number
  /** True while the toolbar is pinned to the panel's top edge because the
   *  table's own top has scrolled out of view. */
  pinned: boolean
}

/** Pixels between the toolbar and the table / panel edges. */
export const TABLE_TOOLBAR_GAP = 6

/**
 * Place the toolbar for one frame, or null when it must not be shown at all.
 *
 * The rules, in the order they decide:
 *
 * 1. **The current cell fully out of view → null.** A toolbar floating beside a
 *    table whose cell the user cannot see is a control for something they are
 *    not looking at; the brief asks for it to be hidden rather than left there.
 * 2. **Above the table**, horizontally aligned with it — and when the table's
 *    top has scrolled out of the panel, pinned to the panel's TOP EDGE instead,
 *    still aligned with that table's horizontal position.
 * 3. **Below the table** when there is not enough room above, or when sitting
 *    above would cover the cell the caret is in.
 * 4. **Clamped inside the panel**, always — whichever of the three placements
 *    was chosen, the toolbar never leaves its own column.
 */
export function placeTableToolbar(input: PlacementInput): Placement | null {
  const gap = input.gap ?? TABLE_TOOLBAR_GAP
  const { table, panel, cell, toolbar } = input

  // 1. The cell is gone from the panel's viewport: nothing to act on.
  if (cell.bottom <= panel.top || cell.top >= panel.bottom) return null
  if (cell.right <= panel.left || cell.left >= panel.right) return null

  // Horizontal: aligned with the table's own left edge, clamped into the panel.
  const maxLeft = Math.max(panel.left, panel.right - toolbar.width)
  const left = Math.min(Math.max(table.left, panel.left), maxLeft)

  const roomAbove = table.top - panel.top
  const above = table.top - gap - toolbar.height
  const below = table.bottom + gap
  const fitsAbove = roomAbove >= toolbar.height + gap
  // Would sitting above cover the cell? (A tall table whose first row is the
  // cell: the toolbar lands on top of the text being edited.)
  const aboveCoversCell = above < cell.bottom && above + toolbar.height > cell.top

  if (fitsAbove && !aboveCoversCell) {
    return { top: Math.max(panel.top, above), left, pinned: false }
  }

  // Below, if it fits inside the panel; otherwise pinned to the panel's top
  // edge (the table is taller than the panel, so neither side has room).
  if (below + toolbar.height <= panel.bottom) {
    return { top: below, left, pinned: false }
  }

  return { top: panel.top, left, pinned: true }
}
