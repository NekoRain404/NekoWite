import { describe, expect, it } from 'vitest'
import { placeImagePanel, IMAGE_PANEL_GAP } from './image-panel-placement'
// `Rect` lives in the table toolbar's module, and this one borrows it rather
// than declaring its own: the two placements are arithmetic over the same
// vocabulary, and a second `Rect` would be the same six numbers under a second
// name. The test names that home directly instead of asking the module under
// test to re-export something it only passes through.
import type { Rect } from './table-toolbar-placement'

const rect = (top: number, left: number, width: number, height: number): Rect => ({
  top,
  left,
  right: left + width,
  bottom: top + height,
  width,
  height,
})

/** The pane `.rendered-pane` is: 780×620 with its top at y=100 (a tab bar above it). */
const PANEL = rect(100, 500, 780, 620)
/** The panel's own measured box — a column of fields, not a strip of buttons. */
const SIZE = { width: 240, height: 330 }

describe('placeImagePanel', () => {
  it('sits beside the image, on its right, with the two tops level', () => {
    const image = rect(300, 520, 300, 200)
    expect(placeImagePanel({ image, panel: PANEL, size: SIZE })).toEqual({
      top: 300,
      left: 520 + 300 + IMAGE_PANEL_GAP,
    })
  })

  it('takes the image’s left side when the right side has no room in the pane', () => {
    // The image reaches the pane's right edge, so there is nothing to its right.
    const image = rect(300, 1000, 300, 200)
    expect(placeImagePanel({ image, panel: PANEL, size: SIZE })).toEqual({
      top: 300,
      left: 1000 - IMAGE_PANEL_GAP - SIZE.width,
    })
  })

  it('clears the image when it has to overlap it: below, when below fits', () => {
    // A full-width image: neither side of it has room for the panel.
    const image = rect(200, 520, 760, 150)
    const place = placeImagePanel({ image, panel: PANEL, size: SIZE })
    expect(place.top).toBe(200 + 150 + IMAGE_PANEL_GAP)
    // Overlapping is unavoidable here; it overlaps the image's own right edge,
    // which is where the panel sat before it floated at all.
    expect(place.left).toBe(PANEL.right - IMAGE_PANEL_GAP - SIZE.width)
  })

  it('clears the image when it has to overlap it: above, when below does not fit', () => {
    const image = rect(500, 520, 760, 150)
    const place = placeImagePanel({ image, panel: PANEL, size: SIZE })
    // Below would run past the pane's floor, so the panel sits above the image
    // instead of level with its top — 382 is what the clamp alone would give.
    expect(place.top).toBe(500 - IMAGE_PANEL_GAP - SIZE.height)
  })

  it('levels with the image’s top when neither side of it has room', () => {
    // Room below and room above are both gone, but the image's own top is high
    // enough that the panel still fits under it.
    const image = rect(300, 520, 760, 150)
    const place = placeImagePanel({ image, panel: PANEL, size: SIZE })
    expect(place.top).toBe(300)
  })

  it('never covers the image from the side, however low the image sits', () => {
    // Beside placement is free to ignore the image's height: the panel is pulled
    // up into the pane, and it still sits beside the image rather than over it.
    const image = rect(650, 520, 300, 100)
    const place = placeImagePanel({ image, panel: PANEL, size: SIZE })
    expect(place.left).toBe(520 + 300 + IMAGE_PANEL_GAP)
    expect(place.top).toBe(PANEL.bottom - IMAGE_PANEL_GAP - SIZE.height)
  })

  it('stays inside the pane when the image has scrolled out of it', () => {
    // The image is above the pane (scrolled past) and below it. The panel is not
    // hidden by either: it clamps to the pane's edge, and follows the image back
    // into view on the next frame.
    const above = placeImagePanel({ image: rect(-200, 520, 300, 100), panel: PANEL, size: SIZE })
    expect(above.top).toBe(PANEL.top + IMAGE_PANEL_GAP)
    const below = placeImagePanel({ image: rect(900, 520, 300, 100), panel: PANEL, size: SIZE })
    expect(below.top).toBe(PANEL.bottom - IMAGE_PANEL_GAP - SIZE.height)
  })

  it('never leaves the pane on either axis', () => {
    for (const top of [-500, 100, 300, 650, 900]) {
      for (const left of [400, 520, 900, 1200, 1400]) {
        const place = placeImagePanel({ image: rect(top, left, 400, 160), panel: PANEL, size: SIZE })
        expect(place.left, `left for image at ${left}`).toBeGreaterThanOrEqual(PANEL.left + IMAGE_PANEL_GAP)
        expect(place.left + SIZE.width).toBeLessThanOrEqual(PANEL.right - IMAGE_PANEL_GAP)
        expect(place.top, `top for image at ${top}`).toBeGreaterThanOrEqual(PANEL.top + IMAGE_PANEL_GAP)
        expect(place.top + SIZE.height).toBeLessThanOrEqual(PANEL.bottom - IMAGE_PANEL_GAP)
      }
    }
  })

  it('keeps the title reachable when the pane is too small to hold the panel', () => {
    // A pane narrower and shorter than the panel: both clamps invert, and the
    // top-left corner wins — the title and the first fields are what a reader
    // has to be able to see.
    const pane = rect(0, 0, 200, 300)
    const place = placeImagePanel({ image: rect(40, 20, 100, 60), panel: pane, size: SIZE })
    expect(place).toEqual({ top: IMAGE_PANEL_GAP, left: IMAGE_PANEL_GAP })
  })
})
