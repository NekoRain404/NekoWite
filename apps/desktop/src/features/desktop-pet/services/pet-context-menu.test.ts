/**
 * Where the pet's menu goes, as arithmetic rather than as an impression.
 *
 * The pet window is small and frameless, so the menu hangs off the point that was right-clicked
 * and has nowhere to go when that point is at the window's edge: unclamped, a menu opened near the
 * bottom-right corner is drawn mostly outside the window, and a right-click on the pet appears to
 * do nothing at all. The window has no scrollbar to recover it with, which is what makes this an
 * assertion rather than a judgement call.
 *
 * The rule is the one `src/ui/ContextMenu.vue` already uses in the editor window — clamp with a
 * padding, and treat "the clamp pushed the menu past the point it opened at" as a flip so the
 * entrance grows out of the edge the menu is actually anchored to. It is restated here because
 * that component imports the application's whole i18n dictionary, which §7.1's graph test forbids
 * from this window (`app/desktop-pet-entry.test.ts`, the `ui/` entry). Same arithmetic, own copy,
 * because the alternative is a pet window that carries the editor's dictionary to place a menu.
 */
import { describe, expect, it } from 'vitest'
import { PET_MENU_PAD, placePetMenu } from './pet-context-menu'

const VIEWPORT = { width: 300, height: 240 }

describe('placing the menu at a point', () => {
  it('opens where the click was when there is room', () => {
    const placement = placePetMenu({
      anchor: { x: 40, y: 30 },
      size: { width: 160, height: 120 },
      viewport: VIEWPORT,
    })

    expect(placement.left).toBe(40)
    expect(placement.top).toBe(30)
    expect(placement.flipped).toBe(false)
  })

  it('keeps a menu opened at the right edge inside the window', () => {
    const placement = placePetMenu({
      anchor: { x: 299, y: 30 },
      size: { width: 160, height: 120 },
      viewport: VIEWPORT,
    })

    expect(placement.left).toBe(VIEWPORT.width - 160 - PET_MENU_PAD)
    expect(placement.left + 160).toBeLessThanOrEqual(VIEWPORT.width)
  })

  it('keeps a menu opened at the bottom edge inside the window, and says it had to flip', () => {
    const placement = placePetMenu({
      anchor: { x: 40, y: 239 },
      size: { width: 160, height: 120 },
      viewport: VIEWPORT,
    })

    expect(placement.top).toBe(VIEWPORT.height - 120 - PET_MENU_PAD)
    expect(placement.top + 120).toBeLessThanOrEqual(VIEWPORT.height)
    // The menu now sits above the point it was opened at, so its entrance has to grow from its
    // bottom edge rather than its top — otherwise it arrives from the gap underneath, which is
    // where nothing happened.
    expect(placement.flipped).toBe(true)
  })

  it('does not call a couple of clamped pixels a flip', () => {
    const size = { width: 160, height: 120 }
    const placement = placePetMenu({
      anchor: { x: 10, y: VIEWPORT.height - 124 },
      size,
      viewport: VIEWPORT,
    })

    expect(placement.top).toBeLessThan(VIEWPORT.height - 124)
    expect(placement.flipped).toBe(false)
  })

  it('keeps the padding at the top-left, where the clamp has nowhere to push', () => {
    const placement = placePetMenu({
      anchor: { x: -20, y: -5 },
      size: { width: 160, height: 120 },
      viewport: VIEWPORT,
    })

    expect(placement.left).toBe(PET_MENU_PAD)
    expect(placement.top).toBe(PET_MENU_PAD)
  })

  it('never returns a negative offset when the menu is bigger than the window', () => {
    // A long Chinese menu label in a 300px window. The menu is not going to fit; what it must not
    // do is start off-screen, where the first item cannot be clicked at all.
    const placement = placePetMenu({
      anchor: { x: 20, y: 20 },
      size: { width: 420, height: 400 },
      viewport: VIEWPORT,
    })

    expect(placement.left).toBe(PET_MENU_PAD)
    expect(placement.top).toBe(PET_MENU_PAD)
  })

  it('rounds to whole pixels, so a menu is never drawn on a half pixel', () => {
    const placement = placePetMenu({
      anchor: { x: 10.6, y: 20.2 },
      size: { width: 160, height: 120 },
      viewport: VIEWPORT,
    })

    expect(Number.isInteger(placement.left)).toBe(true)
    expect(Number.isInteger(placement.top)).toBe(true)
  })
})
