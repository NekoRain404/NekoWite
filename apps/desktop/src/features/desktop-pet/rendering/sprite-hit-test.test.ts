import { describe, expect, it, vi } from 'vitest'
import { contextAlphaReader, hitTestSprite, type HitSurface } from './sprite-hit-test'
import type { Rect } from './sprite-slicer'

const rect: Rect = { x: 10, y: 10, w: 80, h: 80 }

/** A surface whose backing store matches its CSS box. */
const surface1x: HitSurface = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 }
/** The same CSS box on a 2x display: twice the backing store, same layout size. */
const surface2x: HitSurface = { width: 200, height: 200, clientWidth: 100, clientHeight: 100 }

describe('hitTestSprite', () => {
  it('misses when nothing has been drawn', () => {
    const readAlpha = vi.fn(() => 255)
    expect(
      hitTestSprite({ x: 20, y: 20 }, { spriteRect: null, surface: surface1x, readAlpha }),
    ).toBe(false)
    // No rect means no pixel to look at either.
    expect(readAlpha).not.toHaveBeenCalled()
  })

  it('misses outside the sprite rect without reading a pixel', () => {
    const readAlpha = vi.fn(() => 255)
    expect(
      hitTestSprite({ x: 95, y: 95 }, { spriteRect: rect, surface: surface1x, readAlpha }),
    ).toBe(false)
    expect(readAlpha).not.toHaveBeenCalled()
  })

  it('hits a drawn pixel inside the rect', () => {
    expect(
      hitTestSprite(
        { x: 20, y: 20 },
        { spriteRect: rect, surface: surface1x, readAlpha: () => 255 },
      ),
    ).toBe(true)
  })

  it('misses a transparent pixel inside the rect', () => {
    expect(
      hitTestSprite({ x: 20, y: 20 }, { spriteRect: rect, surface: surface1x, readAlpha: () => 0 }),
    ).toBe(false)
  })

  it('treats alpha at the threshold as a miss and above it as a hit', () => {
    expect(
      hitTestSprite({ x: 20, y: 20 }, { spriteRect: rect, surface: surface1x, readAlpha: () => 16 }),
    ).toBe(false)
    expect(
      hitTestSprite({ x: 20, y: 20 }, { spriteRect: rect, surface: surface1x, readAlpha: () => 17 }),
    ).toBe(true)
  })

  it('falls back to the rect when the canvas pixels cannot be read', () => {
    // A tainted canvas throws on getImageData; the reader reports null and the rect alone
    // decides, rather than the point never hitting.
    expect(
      hitTestSprite({ x: 20, y: 20 }, { spriteRect: rect, surface: surface1x, readAlpha: () => null }),
    ).toBe(true)
  })

  it('reads the pixel in backing-store coordinates', () => {
    const readAlpha = vi.fn(() => 255)
    hitTestSprite({ x: 20, y: 30 }, { spriteRect: rect, surface: surface1x, readAlpha })
    expect(readAlpha).toHaveBeenCalledWith(20, 30)
  })

  it('degrades to a miss instead of NaN when the canvas has no layout box yet', () => {
    // happy-dom (and an unlaid-out element) reports 0 for clientWidth/Height. Upstream's
    // `|| 1` keeps the ratio finite: the point misses, which is the safe answer for a
    // canvas the user cannot see, and it never reaches the alpha read with NaN.
    const unlaidOut: HitSurface = { width: 100, height: 100, clientWidth: 0, clientHeight: 0 }
    const readAlpha = vi.fn(() => 255)
    expect(
      hitTestSprite({ x: 20, y: 20 }, { spriteRect: rect, surface: unlaidOut, readAlpha }),
    ).toBe(false)
    expect(readAlpha).not.toHaveBeenCalled()
  })
})

describe('hitTestSprite across device pixel ratios', () => {
  // The same sprite on the same 100x100 CSS box, drawn at 1x and at 2x: the sprite's true
  // bounds double with the backing store, and so does the alpha map the display shows.
  const spriteAt1x: Rect = { x: 10, y: 10, w: 80, h: 80 }
  const spriteAt2x: Rect = { x: 20, y: 20, w: 160, h: 160 }
  // The pet's drawn pixels cover the left half of its bounds, in backing-store pixels.
  const alphaAt = (scale: number) => (x: number) => (x < 50 * scale ? 255 : 0)

  it('hits the same CSS point on a 1x and a 2x display', () => {
    const onSprite = { x: 20, y: 20 }
    expect(
      hitTestSprite(onSprite, {
        spriteRect: spriteAt1x,
        surface: surface1x,
        readAlpha: (x) => alphaAt(1)(x),
      }),
    ).toBe(true)
    expect(
      hitTestSprite(onSprite, {
        spriteRect: spriteAt2x,
        surface: surface2x,
        readAlpha: (x) => alphaAt(2)(x),
      }),
    ).toBe(true)
  })

  it('misses the same CSS point on both displays when the sprite pixel there is empty', () => {
    const onGap = { x: 70, y: 70 }
    expect(
      hitTestSprite(onGap, {
        spriteRect: spriteAt1x,
        surface: surface1x,
        readAlpha: (x) => alphaAt(1)(x),
      }),
    ).toBe(false)
    expect(
      hitTestSprite(onGap, {
        spriteRect: spriteAt2x,
        surface: surface2x,
        readAlpha: (x) => alphaAt(2)(x),
      }),
    ).toBe(false)
  })
})

describe('contextAlphaReader', () => {
  function contextWith(getImageData: () => { data: Uint8ClampedArray }): CanvasRenderingContext2D {
    return { getImageData } as unknown as CanvasRenderingContext2D
  }

  it('returns the alpha byte of the requested pixel', () => {
    const ctx = contextWith(() => ({ data: new Uint8ClampedArray([0, 0, 0, 200]) }))
    expect(contextAlphaReader(ctx)(3, 4)).toBe(200)
  })

  it('reports unreadable pixels when the context throws', () => {
    const ctx = contextWith(() => {
      throw new Error('tainted canvas')
    })
    expect(contextAlphaReader(ctx)(3, 4)).toBeNull()
  })
})
