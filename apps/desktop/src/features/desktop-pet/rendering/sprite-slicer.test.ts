import { describe, expect, it } from 'vitest'
import {
  ALPHA_THRESHOLD,
  clampRow,
  clipWidths,
  fallbackGridFrame,
  segments,
  sliceSheet,
  type Rect,
  type SheetPixels,
  type SheetPixelReader,
  type SpriteImageLike,
} from './sprite-slicer'

/** An image with dimensions but no pixels; the reader decides what the pixels are. */
function image(width: number, height: number): SpriteImageLike {
  return { naturalWidth: width, naturalHeight: height }
}

/** A synthetic sheet: `rects` are opaque, everything else stays transparent. */
function sheetPixels(width: number, height: number, rects: Rect[], alpha = 255): SheetPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) data[(y * width + x) * 4 + 3] = alpha
    }
  }
  return { width, height, data }
}

/** A reader that always returns the given pixels, whatever the image says. */
function readerOf(pixels: SheetPixels | null): SheetPixelReader {
  return () => pixels
}

const frame = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

describe('segments', () => {
  it('returns the contiguous runs of an occupancy array', () => {
    expect(segments(new Uint8Array([1, 1, 0, 1]))).toEqual([
      [0, 2],
      [3, 4],
    ])
  })

  it('closes a run that reaches the end of the array', () => {
    expect(segments(new Uint8Array([0, 1, 1, 1]))).toEqual([[1, 4]])
  })

  it('returns nothing for an empty or fully empty array', () => {
    expect(segments(new Uint8Array([]))).toEqual([])
    expect(segments(new Uint8Array([0, 0, 0]))).toEqual([])
  })
})

describe('sliceSheet', () => {
  it('splits a sheet into clips by transparent rows, then into frames by transparent columns', () => {
    // Two 8x8 sprites in the first band, a fully transparent band, one 8x8 sprite in the
    // third. The declared layout would be three rows of two cells; the sheet has two rows
    // with content and three frames in total.
    const pixels = sheetPixels(32, 24, [
      frame(0, 0, 8, 8),
      frame(16, 0, 8, 8),
      frame(8, 16, 8, 8),
    ])
    expect(sliceSheet(image(32, 24), readerOf(pixels))).toEqual([
      [frame(0, 0, 8, 8), frame(16, 0, 8, 8)],
      [frame(8, 16, 8, 8)],
    ])
  })

  it('slices a sparse row into the frames that are actually drawn', () => {
    // A sheet declaring eight columns, with three sprites drawn and gaps between them:
    // the empty cells simply do not exist, which is what keeps the pet from blinking out
    // on a sparse row.
    const pixels = sheetPixels(64, 8, [frame(0, 0, 8, 8), frame(16, 0, 8, 8), frame(48, 0, 8, 8)])
    const clips = sliceSheet(image(64, 8), readerOf(pixels))
    expect(clips).toHaveLength(1)
    expect(clips[0]).toHaveLength(3)
    expect(clips[0].every((cell) => cell.w > 0 && cell.h > 0)).toBe(true)
    expect(clips[0].map((cell) => cell.x)).toEqual([0, 16, 48])
  })

  it('returns no clips for a fully transparent sheet', () => {
    expect(sliceSheet(image(32, 24), readerOf(sheetPixels(32, 24, [])))).toEqual([])
  })

  it('returns no clips for an image with no dimensions', () => {
    expect(sliceSheet(image(0, 24), readerOf(sheetPixels(0, 24, [])))).toEqual([])
    expect(sliceSheet(image(32, 0), readerOf(sheetPixels(32, 0, [])))).toEqual([])
  })

  it('returns no clips when the pixels cannot be read', () => {
    expect(sliceSheet(image(32, 24), readerOf(null))).toEqual([])
  })

  it('refuses a pixel buffer that is short or sized differently from the image', () => {
    // A reader that hands back the wrong buffer would have its pixels indexed with the
    // image's row stride, producing clips at coordinates that mean nothing.
    expect(sliceSheet(image(32, 24), readerOf(sheetPixels(32, 12, [])))).toEqual([])
    expect(sliceSheet(image(32, 24), readerOf({ width: 16, height: 24, data: new Uint8ClampedArray(16 * 24 * 4) }))).toEqual([])
    expect(sliceSheet(image(32, 24), readerOf({ width: 32, height: 24, data: new Uint8ClampedArray(8) }))).toEqual([])
  })

  it('treats alpha at the threshold as transparent and above it as drawn', () => {
    // Upstream compares with `>`, so exactly ALPHA_THRESHOLD is a gap.
    const atThreshold = sheetPixels(8, 8, [frame(0, 0, 8, 8)], ALPHA_THRESHOLD)
    const above = sheetPixels(8, 8, [frame(0, 0, 8, 8)], ALPHA_THRESHOLD + 1)
    expect(sliceSheet(image(8, 8), readerOf(atThreshold))).toEqual([])
    expect(sliceSheet(image(8, 8), readerOf(above))).toEqual([[frame(0, 0, 8, 8)]])
  })

  it('degrades to no clips instead of throwing when the environment cannot supply pixels', () => {
    // The default reader needs a real 2D context; happy-dom has none, which is the same
    // shape as upstream's unreadable-pixels case (no CORS). The caller then draws from the
    // fixed grid rather than failing.
    const source = document.createElement('img')
    Object.defineProperty(source, 'naturalWidth', { value: 32 })
    Object.defineProperty(source, 'naturalHeight', { value: 24 })
    expect(sliceSheet(source)).toEqual([])
  })
})

describe('clipWidths', () => {
  it('keeps the widest frame of each clip, so a clip does not pulse', () => {
    const clips = [
      [frame(0, 0, 8, 8), frame(16, 0, 12, 8)],
      [frame(0, 16, 4, 4)],
    ]
    expect(clipWidths(clips)).toEqual([12, 4])
  })

  it('reports zero for an empty clip rather than -Infinity', () => {
    expect(clipWidths([[]])).toEqual([0])
  })
})

describe('clampRow', () => {
  it('keeps a row that exists', () => {
    expect(clampRow(0, 3)).toBe(0)
    expect(clampRow(2, 3)).toBe(2)
  })

  it('clamps a row past the end to the last clip', () => {
    expect(clampRow(99, 3)).toBe(2)
  })

  it('clamps a negative, fractional or non-finite row into range', () => {
    expect(clampRow(-4, 3)).toBe(0)
    expect(clampRow(1.5, 3)).toBe(1)
    expect(clampRow(Number.NaN, 3)).toBe(0)
    expect(clampRow(Number.POSITIVE_INFINITY, 3)).toBe(0)
  })

  it('returns zero when there is no row to clamp to', () => {
    expect(clampRow(2, 0)).toBe(0)
  })
})

describe('fallbackGridFrame', () => {
  it('takes the cell from the fixed 8x9 grid', () => {
    // 80/8 = 10 wide, 90/9 = 10 high.
    expect(fallbackGridFrame(image(80, 90), 3, 2)).toEqual(frame(30, 20, 10, 10))
  })

  it('wraps the frame index across the columns', () => {
    expect(fallbackGridFrame(image(80, 90), 9, 0)).toEqual(frame(10, 0, 10, 10))
  })

  it('clamps the row at both ends, so no cell outside the grid is read', () => {
    expect(fallbackGridFrame(image(80, 90), 0, 99)).toEqual(frame(0, 80, 10, 10))
    expect(fallbackGridFrame(image(80, 90), 0, -3)).toEqual(frame(0, 0, 10, 10))
    expect(fallbackGridFrame(image(80, 90), 0, Number.NaN)).toEqual(frame(0, 0, 10, 10))
  })

  it('has no cell for an image with no dimensions', () => {
    expect(fallbackGridFrame(image(0, 90), 0, 0)).toBeNull()
    expect(fallbackGridFrame(image(80, 0), 0, 0)).toBeNull()
  })
})
