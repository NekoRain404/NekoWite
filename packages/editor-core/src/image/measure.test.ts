import { describe, expect, it } from 'vitest'

import { intrinsicSize, lockPair } from './measure'

/** Just the two fields `intrinsicSize` reads, so a test can hand a literal. */
const px = (width: number, height: number) => ({ naturalWidth: width, naturalHeight: height })

/** A measured pair, the shape `intrinsicSize` answers with. */
const size = (width: number, height: number) => ({ width, height })

describe('intrinsicSize', () => {
  it('reads the file’s own pixels off the loaded element', () => {
    expect(intrinsicSize(px(1200, 300))).toEqual({ width: 1200, height: 300 })
  })

  it('is unknown while the image has not loaded, and after it failed', () => {
    // 0/0 is "not decoded", never a 0px picture: a resize that treats it as a
    // size writes that size to the document.
    expect(intrinsicSize(px(0, 0))).toBeNull()
    expect(intrinsicSize(null)).toBeNull()
  })
})

describe('the pair an aspect-locked resize holds to', () => {
  it('is the pair the document already states when both halves are set', () => {
    // The reader may have set a height on purpose; locking must not undo it.
    expect(lockPair(600, 200, size(1200, 300))).toEqual({ width: 600, height: 200 })
  })

  it('is the file’s own pair when only one half is stated', () => {
    // Returned whole rather than as a height to pair with the stored width: the
    // ratio is what the caller divides, and 300 mixed with the pixel height 300
    // would be 1:1 for a 4:1 file (1200x300).
    expect(lockPair(300, null, size(1200, 300))).toEqual({ width: 1200, height: 300 })
    expect(lockPair(null, 300, size(1200, 300))).toEqual({ width: 1200, height: 300 })
  })

  it('is null when neither the document nor the file states a size', () => {
    // No ratio to hold: the caller must refuse the locked resize, not invent one.
    expect(lockPair(null, null, null)).toBeNull()
    expect(lockPair(300, null, null)).toBeNull()
    expect(lockPair(null, 300, null)).toBeNull()
  })
})
