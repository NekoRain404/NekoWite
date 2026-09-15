import { describe, expect, it } from 'vitest'
import {
  displaySize,
  intrinsicSize,
  lockRatio,
  pairForHeight,
  pairForWidth,
} from './image-panel-metrics'

/** Just the two fields `intrinsicSize` reads, so a test can hand it a literal. */
const px = (width: number, height: number) => ({ naturalWidth: width, naturalHeight: height })

/** The same picture as the rest of the file means it: its measured size. */
const A4 = { width: 1000, height: 500 } // 2:1

describe('intrinsicSize', () => {
  it('reads the file’s own pixels off the loaded image', () => {
    expect(intrinsicSize(px(1000, 550))).toEqual({ width: 1000, height: 550 })
  })

  it('is null while the image has not loaded, and when it failed', () => {
    // An unloaded (or failed) <img> reports 0/0: a size the panel may not print.
    expect(intrinsicSize(px(0, 0))).toBeNull()
    expect(intrinsicSize(null)).toBeNull()
  })
})

describe('displaySize', () => {
  it('is the file’s own size when neither attribute is set', () => {
    expect(displaySize(null, null, A4)).toEqual({ width: 1000, height: 500 })
  })

  it('derives the missing half from the file’s ratio', () => {
    // The browser draws a width-only image at that width and the intrinsic
    // ratio; pairing the custom width with the ORIGINAL height printed a size
    // the image does not have.
    expect(displaySize(400, null, A4)).toEqual({ width: 400, height: 200 })
    expect(displaySize(null, 200, A4)).toEqual({ width: 400, height: 200 })
  })

  it('reports a distorted pair as the pair it is', () => {
    expect(displaySize(400, 400, A4)).toEqual({ width: 400, height: 400 })
  })

  it('admits the half it cannot know', () => {
    expect(displaySize(400, null, null)).toEqual({ width: 400, height: null })
    expect(displaySize(null, null, null)).toBeNull()
  })
})

describe('the ratio a locked resize holds to', () => {
  it('is the pair on screen, so locking does not change the shape', () => {
    expect(lockRatio(600, 200, A4)).toBe(3)
  })

  it('falls back to the file’s own ratio when only one half is set', () => {
    expect(lockRatio(400, null, A4)).toBe(2)
    expect(lockRatio(null, null, A4)).toBe(2)
  })

  it('is unknown when neither half is: there is no ratio to lock', () => {
    expect(lockRatio(null, null, null)).toBeNull()
  })
})

describe('the locked pair', () => {
  it('keeps the ratio from either side, rounded once', () => {
    expect(pairForWidth(2, 500)).toEqual({ width: 500, height: 250 })
    expect(pairForHeight(2, 250)).toEqual({ width: 500, height: 250 })
    // 500/3 = 166.67 — rounded, not truncated, and never 0.
    expect(pairForWidth(3, 500)).toEqual({ width: 500, height: 167 })
    expect(pairForWidth(1000, 1)).toEqual({ width: 1, height: 1 })
  })

  it('clamps to the same band the drag and the width field use', () => {
    expect(pairForWidth(2, 99999).width).toBe(4000)
    expect(pairForHeight(2, 99999).height).toBe(4000)
  })
})
