/**
 * The settings dialog's size: the arithmetic a drag is, the window it is held inside, and the two
 * keys it survives a restart in.
 *
 * Three things are asserted here and they are the three a wrong implementation could also satisfy
 * on the screen:
 *
 *  - **Where the corner lands.** The dialog is centred, so a pointer at the corner is twice the
 *    centre's distance away in each axis; a drag that added the pointer's delta to the size instead
 *    (the obvious implementation, and the one the panes' own handle uses because they are *not*
 *    centred) would move the handle at half the pointer's speed and stop short of where the user
 *    let go. The equality asserted is between two independently computed numbers: the size the
 *    model reports, and twice the distance from the centre to the pointer.
 *  - **That a size the window cannot hold is not a size.** `tauri.conf.json:17-18` gives the main
 *    window `minWidth: 860` / `minHeight: 560`, and a window can be shrunk after a size was
 *    stored — so the clamp runs on the way in *and* on the way out.
 *  - **That the two keys round-trip, and that a corrupt one does not.** These are hand-editable
 *    localStorage keys in the same store as every other setting, so a half-written one has to land
 *    on the default rather than on a NaN width.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  DIALOG_BOUNDS_FALLBACK,
  DIALOG_HEIGHT_DEFAULT,
  DIALOG_HEIGHT_MIN,
  DIALOG_SIZE_KEY_HEIGHT,
  DIALOG_SIZE_KEY_WIDTH,
  DIALOG_WIDTH_DEFAULT,
  DIALOG_WIDTH_MIN,
  clampDialogSize,
  readStoredDialogSize,
  sizeFromPointer,
} from './use-dialog-size'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

afterEach(() => {
  localStorage.clear()
})

describe('the size a centred dialog takes when its corner is dragged', () => {
  it('is twice the pointer’s distance from the centre, so the corner stays under the pointer', () => {
    const centre = { x: 640, y: 400 }
    // The corner of a 720x520 dialog centred at 640,400.
    const corner = { x: 640 + 360, y: 400 + 260 }

    // The equality: the size the model reports, and the distance walked back
    // out to the pointer. A drag that used the pointer's *delta* reports 720
    // here and is 360px short of where the user let go.
    const size = sizeFromPointer(corner, centre)
    expect(size.width).toBe(720)
    expect(size.height).toBe(520)

    // And at a second position, so the relation is not an identity that only
    // holds at the default: 300 out from the centre is a 600px-wide dialog.
    // Both axes are kept above the floor, because below it the floor answers
    // instead and the reading would be about the floor rather than the relation.
    const wider = sizeFromPointer({ x: 640 + 300, y: 400 + 200 }, centre)
    expect(wider.width).toBe(2 * 300)
    expect(wider.height).toBe(2 * 200)
  })

  it('reads the same size in every quadrant, because the dialog is centred', () => {
    const centre = { x: 640, y: 400 }
    const far = { x: 900, y: 700 }
    const mirrored = { x: 640 - 260, y: 400 - 300 }
    expect(sizeFromPointer(far, centre)).toEqual(sizeFromPointer(mirrored, centre))
  })

  it('never reports a size below the floor, however far inside the centre the pointer is', () => {
    const centre = { x: 640, y: 400 }
    const atCentre = sizeFromPointer(centre, centre)
    expect(atCentre.width).toBeGreaterThanOrEqual(DIALOG_WIDTH_MIN)
    expect(atCentre.height).toBeGreaterThanOrEqual(DIALOG_HEIGHT_MIN)
  })
})

describe('the window a size is held inside', () => {
  it('clamps downward to the floor and upward to the window, in both axes', () => {
    const bounds = { width: 1232, height: 752 }
    expect(clampDialogSize({ width: 10, height: 10 }, bounds)).toEqual({
      width: DIALOG_WIDTH_MIN,
      height: DIALOG_HEIGHT_MIN,
    })
    expect(clampDialogSize({ width: 5000, height: 5000 }, bounds)).toEqual(bounds)
    expect(clampDialogSize({ width: 900, height: 600 }, bounds)).toEqual({ width: 900, height: 600 })
  })

  it('gives the floor priority when the window is smaller than the floor', () => {
    // A window narrower than the dialog's own minimum is a window this product
    // cannot be in (`tauri.conf.json`'s 860x560), and the honest answer there is
    // the floor — a dialog rendered below the size its content needs is the
    // defect the floor exists for, and a negative width is worse than either.
    const tiny = { width: 200, height: 120 }
    expect(clampDialogSize({ width: 600, height: 400 }, tiny)).toEqual({
      width: DIALOG_WIDTH_MIN,
      height: DIALOG_HEIGHT_MIN,
    })
  })
})

describe('the stored size', () => {
  it('is the clean-install default until something writes one', () => {
    expect(readStoredDialogSize()).toEqual({
      width: DIALOG_WIDTH_DEFAULT,
      height: DIALOG_HEIGHT_DEFAULT,
    })
  })

  it('round-trips both axes through the persistence port', () => {
    localStorage.setItem(DIALOG_SIZE_KEY_WIDTH, '1040')
    localStorage.setItem(DIALOG_SIZE_KEY_HEIGHT, '660')
    expect(readStoredDialogSize()).toEqual({ width: 1040, height: 660 })
  })

  it('falls back per axis, so a half-written pair keeps the half that survived', () => {
    localStorage.setItem(DIALOG_SIZE_KEY_WIDTH, '1040')
    localStorage.setItem(DIALOG_SIZE_KEY_HEIGHT, 'not-a-number')
    expect(readStoredDialogSize()).toEqual({
      width: 1040,
      height: DIALOG_HEIGHT_DEFAULT,
    })
  })

  it('clamps a stored size the window can no longer hold', () => {
    localStorage.setItem(DIALOG_SIZE_KEY_WIDTH, '99999')
    localStorage.setItem(DIALOG_SIZE_KEY_HEIGHT, '-40')
    expect(readStoredDialogSize()).toEqual({
      width: DIALOG_BOUNDS_FALLBACK.width,
      height: DIALOG_HEIGHT_MIN,
    })
  })
})
