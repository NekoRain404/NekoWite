import { describe, expect, it } from 'vitest'
import { placeTableToolbar, TABLE_TOOLBAR_GAP, type Rect } from './table-toolbar-placement'

const rect = (top: number, left: number, width: number, height: number): Rect => ({
  top,
  left,
  right: left + width,
  bottom: top + height,
  width,
  height,
})

/** A 1280×720 panel with its top at y=100 (a tab bar above it). */
const PANEL = rect(100, 500, 780, 620)
const TOOLBAR = { width: 240, height: 32 }

describe('placeTableToolbar', () => {
  it('sits above the table, aligned with its left edge', () => {
    const table = rect(300, 600, 400, 200)
    const place = placeTableToolbar({
      table,
      panel: PANEL,
      cell: rect(320, 620, 100, 30),
      toolbar: TOOLBAR,
    })
    expect(place).toEqual({ top: 300 - TABLE_TOOLBAR_GAP - 32, left: 600, pinned: false })
  })

  it('pins to the panel top edge when the table’s top has scrolled out of view', () => {
    // The table starts above the panel; the reader is deep inside it.
    const table = rect(40, 600, 400, 900)
    const place = placeTableToolbar({
      table,
      panel: PANEL,
      cell: rect(300, 620, 100, 30),
      toolbar: TOOLBAR,
    })
    expect(place).toEqual({ top: PANEL.top, left: 600, pinned: true })
  })

  it('flips below when there is not enough room above', () => {
    const table = rect(110, 600, 400, 90)
    const place = placeTableToolbar({
      table,
      panel: PANEL,
      cell: rect(150, 620, 100, 30),
      toolbar: TOOLBAR,
    })
    expect(place).toEqual({ top: 110 + 90 + TABLE_TOOLBAR_GAP, left: 600, pinned: false })
  })

  it('flips below when sitting above would cover the cell in a tall first row', () => {
    const table = rect(300, 600, 400, 300)
    // A cell that reaches up into where the toolbar would land.
    const cell = rect(290, 620, 100, 60)
    const place = placeTableToolbar({ table, panel: PANEL, cell, toolbar: TOOLBAR })
    expect(place?.top).toBe(300 + 300 + TABLE_TOOLBAR_GAP)
  })

  it('clamps to the panel’s right edge when the table starts near it', () => {
    const table = rect(300, 1200, 300, 120)
    const place = placeTableToolbar({
      table,
      panel: PANEL,
      cell: rect(320, 1210, 80, 30),
      toolbar: TOOLBAR,
    })
    expect(place?.left).toBe(PANEL.right - TOOLBAR.width)
  })

  it('never leaves the panel on either side', () => {
    // All inside the panel (a table outside it is the hide case, above).
    for (const left of [500, 520, 900, 1100, 1240]) {
      const table = rect(300, left, 300, 120)
      const place = placeTableToolbar({
        table,
        panel: PANEL,
        cell: rect(310, left, 60, 30),
        toolbar: TOOLBAR,
      })
      expect(place!.left).toBeGreaterThanOrEqual(PANEL.left)
      expect(place!.left + TOOLBAR.width).toBeLessThanOrEqual(PANEL.right)
    }
  })

  it('hides when the current cell is fully out of view (either axis)', () => {
    const table = rect(40, 600, 400, 2000)
    // Above the panel.
    expect(
      placeTableToolbar({ table, panel: PANEL, cell: rect(10, 620, 100, 40), toolbar: TOOLBAR }),
    ).toBeNull()
    // Below it.
    expect(
      placeTableToolbar({ table, panel: PANEL, cell: rect(760, 620, 100, 40), toolbar: TOOLBAR }),
    ).toBeNull()
    // Scrolled out sideways (a wide table in a narrow panel).
    expect(
      placeTableToolbar({ table, panel: PANEL, cell: rect(300, 20, 100, 40), toolbar: TOOLBAR }),
    ).toBeNull()
  })
})
