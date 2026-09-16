import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fitFrame,
  SpritePlayer,
  type FramePlacement,
  type SpritePlayerDeps,
  type Viewport,
} from './sprite-player'
import type { ImageFactory, LoadFailure, LoadableImage } from './sprite-sheet'
import type { Rect, SheetPixels, SheetPixelReader } from './sprite-slicer'

/** An image element the test drives by hand: nothing loads until `resolve` or `reject`. */
class FakeImage implements LoadableImage {
  naturalWidth = 0
  naturalHeight = 0
  crossOrigin: string | null = null
  src = ''
  onload: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  /** The browser sets the natural size while decoding; the fake is told instead. */
  resolve(width: number, height: number): void {
    this.naturalWidth = width
    this.naturalHeight = height
    this.onload?.(new Event('load'))
  }

  reject(): void {
    this.onerror?.(new Event('error'))
  }
}

/** A synthetic sheet: `rects` are opaque, everything else stays transparent. */
function sheetPixels(width: number, height: number, rects: Rect[]): SheetPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) data[(y * width + x) * 4 + 3] = 255
    }
  }
  return { width, height, data }
}

/** One clip of two cells spanning the sheet's full height, at x=0 and x=16. */
const twoCells: SheetPixelReader = (_img, width, height) =>
  sheetPixels(width, height, [
    { x: 0, y: 0, w: 8, h: height },
    { x: 16, y: 0, w: 8, h: height },
  ])

/** One frame, so nothing the frame counter does changes what would be drawn. */
const oneCell: SheetPixelReader = (_img, width, height) =>
  sheetPixels(width, height, [{ x: 0, y: 0, w: 8, h: height }])

/** Two clips: rows 0-23 and rows 32-55 of a 32x56 sheet. */
const twoBands: SheetPixelReader = (_img, width, height) =>
  sheetPixels(width, height, [
    { x: 0, y: 0, w: 8, h: 24 },
    { x: 16, y: 0, w: 8, h: 24 },
    { x: 0, y: 32, w: 8, h: 24 },
    { x: 16, y: 32, w: 8, h: 24 },
  ])

/** Unreadable pixels: every alpha stays 0, which is upstream's "no CORS" case. */
const transparent: SheetPixelReader = (_img, width, height) => sheetPixels(width, height, [])

interface Harness {
  player: SpritePlayer
  frames: FramePlacement[]
  created: FakeImage[]
  failures: LoadFailure[]
  view: Viewport
}

function build(overrides: Partial<SpritePlayerDeps> = {}): Harness {
  const view: Viewport = { width: 160, height: 180 }
  const created: FakeImage[] = []
  const frames: FramePlacement[] = []
  const failures: LoadFailure[] = []
  const createImage: ImageFactory = () => {
    const img = new FakeImage()
    created.push(img)
    return img
  }
  const player = new SpritePlayer({
    viewport: () => view,
    createImage,
    readPixels: twoCells,
    onLoadError: (failure) => failures.push(failure),
    ...overrides,
  })
  player.onFrame((frame) => frames.push(frame))
  return { player, frames, created, failures, view }
}

const last = (frames: FramePlacement[]): FramePlacement | undefined => frames.at(-1)

describe('fitFrame', () => {
  it('fits the widest frame of the clip and snaps the scale to a whole number', () => {
    // 100/16 = 6.25 on both axes, floored to 6, anchored bottom-centre.
    expect(fitFrame({ x: 0, y: 0, w: 16, h: 16 }, 16, { width: 100, height: 100 })).toEqual({
      scale: 6,
      dest: { x: 2, y: 4, w: 96, h: 96 },
      headroom: 0.04,
    })
  })

  it('keeps a fractional scale when the frame has to shrink to fit', () => {
    expect(fitFrame({ x: 0, y: 0, w: 16, h: 16 }, 200, { width: 100, height: 100 })).toEqual({
      scale: 0.5,
      dest: { x: 46, y: 92, w: 8, h: 8 },
      headroom: 0.92,
    })
  })

  it('has nothing to place on a canvas with no area', () => {
    // Upstream divided by the canvas height here and passed a NaN headroom on to the
    // bubble's offset.
    expect(fitFrame({ x: 0, y: 0, w: 16, h: 16 }, 16, { width: 100, height: 0 })).toBeNull()
    expect(fitFrame({ x: 0, y: 0, w: 16, h: 16 }, 16, { width: 0, height: 100 })).toBeNull()
  })

  it('has nothing to place for a frame or clip width of zero', () => {
    expect(fitFrame({ x: 0, y: 0, w: 16, h: 16 }, 0, { width: 100, height: 100 })).toBeNull()
    expect(fitFrame({ x: 0, y: 0, w: 0, h: 16 }, 16, { width: 100, height: 100 })).toBeNull()
  })
})

describe('SpritePlayer frames', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('draws nothing until a sheet has loaded', () => {
    const { frames } = build()
    vi.advanceTimersByTime(2000)
    expect(frames).toEqual([])
  })

  it('paints the first frame as soon as the sheet loads', () => {
    const { player, frames, created } = build()
    player.load('a.png')
    expect(frames).toEqual([])
    created[0].resolve(32, 24)
    expect(frames).toHaveLength(1)
    expect(last(frames)).toEqual({
      source: { x: 0, y: 0, w: 8, h: 24 },
      dest: { x: 52, y: 12, w: 56, h: 168 },
      headroom: 12 / 180,
      row: 0,
      clip: 0,
    })
    expect(player.spriteRect).toEqual({ x: 52, y: 12, w: 56, h: 168 })
    expect(player.headroom).toBe(12 / 180)
  })

  it('advances a frame per tick at the rate the state asks for', () => {
    // 8 fps is upstream's `working` rate: one frame every 125ms.
    const { player, frames, created } = build({ config: { fallbackFps: 8 } })
    player.load('a.png')
    created[0].resolve(32, 24)
    expect(last(frames)?.source.x).toBe(0)

    vi.advanceTimersByTime(124)
    expect(last(frames)?.source.x).toBe(0)
    vi.advanceTimersByTime(1)
    expect(last(frames)?.source.x).toBe(16)
    vi.advanceTimersByTime(125)
    expect(last(frames)?.source.x).toBe(0)
  })

  it('floors the frame delay at 80ms however high the rate is set', () => {
    // 30 fps would be a 33ms timeout loop; upstream floored the delay at 80ms.
    const { player, frames, created } = build({ config: { fallbackFps: 30 } })
    player.load('a.png')
    created[0].resolve(32, 24)
    vi.advanceTimersByTime(79)
    expect(frames).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(frames).toHaveLength(2)
  })

  it('does not redraw a clip that has only one frame', () => {
    // Nothing changes between ticks, so nothing is drawn: this is the port's
    // "draw on an actual frame change" rule (plan §3).
    const { player, frames, created } = build({ readPixels: oneCell })
    player.load('a.png')
    created[0].resolve(32, 24)
    expect(frames).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(frames).toHaveLength(1)
    // The frame counter still ran; only the drawing was skipped.
    expect(player.spriteRect).toEqual({ x: 52, y: 12, w: 56, h: 168 })
  })

  it('does not repaint when the same state is set again', () => {
    // The host polls the mood, so an unconditional repaint here would draw every poll.
    const { player, frames, created } = build()
    player.load('a.png')
    created[0].resolve(32, 24)
    player.setState('working')
    const seen = frames.length
    player.setState('working')
    player.setState('working')
    expect(frames).toHaveLength(seen)
  })

  it('scales a clip by its widest frame rather than by the frame being drawn', () => {
    // Frames 8px and 12px wide: both are drawn at the same scale, so the pet does not
    // pulse and the bubble above it does not bounce.
    const uneven: SheetPixelReader = (_img, width, height) =>
      sheetPixels(width, height, [
        { x: 0, y: 0, w: 8, h: height },
        { x: 16, y: 0, w: 12, h: height },
      ])
    const { player, frames, created } = build({ readPixels: uneven, config: { fallbackFps: 8 } })
    player.load('a.png')
    created[0].resolve(32, 24)
    const first = last(frames)
    vi.advanceTimersByTime(125)
    const second = last(frames)
    expect(first?.dest.w).toBe(56)
    expect(second?.dest.w).toBe(84)
    expect(second?.dest.h).toBe(first?.dest.h)
  })

  it('repaints on invalidate even when the frame has not changed', () => {
    const { player, frames, created, view } = build({ readPixels: oneCell })
    player.load('a.png')
    created[0].resolve(32, 24)
    vi.advanceTimersByTime(1000)
    expect(frames).toHaveLength(1)

    view.width = 320
    player.invalidate()
    expect(frames).toHaveLength(2)
    // The canvas height is still what limits the scale, so a wider canvas only re-centres
    // the sprite; the point is that the repaint happened at all.
    expect(last(frames)?.dest).toEqual({ x: 132, y: 12, w: 56, h: 168 })
  })
})

describe('SpritePlayer row selection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('draws the roam override, else the idle clip, else the mood row', () => {
    const { player, frames, created } = build({
      readPixels: twoBands,
      config: { idleClips: [1], idleIntervalMs: 1000 },
    })
    player.load('a.png')
    created[0].resolve(32, 56)
    expect(last(frames)?.clip).toBe(0)

    player.setOverrideRow(1)
    expect(last(frames)?.clip).toBe(1)
    player.setOverrideRow(null)
    expect(last(frames)?.clip).toBe(0)

    // The idle playlist outranks the mood row, and the override outranks both.
    player.setState('idle')
    expect(last(frames)?.clip).toBe(1)
    player.setOverrideRow(0)
    expect(last(frames)?.clip).toBe(0)
  })

  it('clamps a row past the end of the sheet instead of reading a frame it does not have', () => {
    const { player, frames, created } = build({
      readPixels: twoBands,
      config: { stateRows: { working: 7 } },
    })
    player.load('a.png')
    created[0].resolve(32, 56)

    player.setState('working')
    // `working` is row 7 of the macOS layout; this sheet has two clips.
    expect(last(frames)?.row).toBe(7)
    expect(last(frames)?.clip).toBe(1)
    expect(last(frames)?.source.y).toBe(32)
  })

  it('clamps a negative, fractional or huge override row into the sheet', () => {
    const { player, frames, created } = build({ readPixels: twoBands })
    player.load('a.png')
    created[0].resolve(32, 56)

    player.setOverrideRow(99)
    expect(last(frames)?.clip).toBe(1)
    player.setOverrideRow(1.9)
    expect(last(frames)?.clip).toBe(1)
    player.setOverrideRow(-4)
    expect(last(frames)?.clip).toBe(0)
  })

  it('restarts the clip when the row changes', () => {
    const { player, frames, created } = build({ readPixels: twoBands, config: { fallbackFps: 8 } })
    player.load('a.png')
    created[0].resolve(32, 56)
    vi.advanceTimersByTime(125)
    expect(last(frames)?.source.x).toBe(16)

    player.setOverrideRow(1)
    expect(last(frames)?.source).toEqual({ x: 0, y: 32, w: 8, h: 24 })
  })
})

describe('SpritePlayer sheet loading', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the previous character animating when a switch fails to load', () => {
    const { player, frames, created, failures } = build({ config: { fallbackFps: 8 } })
    player.load('a.png')
    created[0].resolve(32, 24)
    const before = frames.length

    player.load('b.png')
    created[1].reject()
    created[2].reject()
    expect(failures).toEqual([
      { url: 'b.png', phase: 'cors' },
      { url: 'b.png', phase: 'plain' },
    ])

    // Upstream left the pet frozen here with no way back.
    vi.advanceTimersByTime(125)
    expect(frames.length).toBeGreaterThan(before)
    expect(player.spriteRect).toEqual({ x: 52, y: 12, w: 56, h: 168 })
  })

  it('shows nothing when the first load fails, rather than a stale one', () => {
    const { player, frames, created, failures } = build()
    player.load('a.png')
    created[0].reject()
    created[1].reject()
    expect(failures.map((failure) => failure.phase)).toEqual(['cors', 'plain'])

    vi.advanceTimersByTime(2000)
    expect(frames).toEqual([])
    expect(player.spriteRect).toBeNull()
  })

  it('does not let a slow load paint over a newer one', () => {
    const { player, frames, created } = build()
    player.load('a.png')
    player.load('b.png')
    expect(created).toHaveLength(2)
    expect(created[0].onload).toBeNull()

    // The newer sheet decodes first.
    created[1].resolve(32, 48)
    expect(frames).toHaveLength(1)
    expect(last(frames)?.dest).toEqual({ x: 68, y: 36, w: 24, h: 144 })

    // The older one arrives late and must commit nothing.
    created[0].resolve(32, 24)
    expect(frames).toHaveLength(1)
    expect(player.spriteRect).toEqual({ x: 68, y: 36, w: 24, h: 144 })
  })

  // The loader's contract, and not a thing the pet window does: `DesktopPetRoot` refuses the
  // sprite branch on the first report, which unmounts the loader before the retry's callbacks
  // land (`sprite-sheet.ts`'s `retryPlain`). What this case drives is an `http(s)` sheet - the
  // only kind the retry can rescue, and a kind no product path produces.
  it('retries an http(s) sheet with the plain URL after a CORS failure, disabling the cache-bust', () => {
    const { player, frames, created, failures } = build()
    player.load('https://example.test/pet.png')
    expect(created[0].crossOrigin).toBe('anonymous')
    expect(created[0].src).toBe('https://example.test/pet.png?cors=1')

    created[0].reject()
    expect(failures).toEqual([{ url: 'https://example.test/pet.png', phase: 'cors' }])
    expect(created[1].src).toBe('https://example.test/pet.png')

    // The retry displays, but its pixels are unreadable, so the fixed grid supplies frames.
    created[1].resolve(32, 36)
    expect(last(frames)?.clip).toBeNull()
    expect(last(frames)?.source).toEqual({ x: 0, y: 0, w: 4, h: 4 })
  })

  it('cache-busts only URLs that have an HTTP cache', () => {
    // A query on a blob: or asset: URL is not a cache key and is not guaranteed to resolve.
    const { player, created } = build()
    player.load('blob:nekowite/pet')
    player.load('data:image/png;base64,AAAA')
    player.load('https://example.test/pet.png?size=2')
    expect(created.map((img) => img.src)).toEqual([
      'blob:nekowite/pet',
      'data:image/png;base64,AAAA',
      'https://example.test/pet.png?size=2&cors=1',
    ])
  })

  it('falls back to the fixed 8x9 grid when the sheet pixels cannot be read', () => {
    const { player, frames, created } = build({ readPixels: transparent })
    player.load('a.png')
    created[0].resolve(32, 36)
    // 32/8 x 36/9 = a 4x4 cell, scaled to fill the 160x180 canvas.
    expect(last(frames)).toEqual({
      source: { x: 0, y: 0, w: 4, h: 4 },
      dest: { x: 0, y: 20, w: 160, h: 160 },
      headroom: 20 / 180,
      row: 0,
      clip: null,
    })
  })
})

describe('SpritePlayer destruction', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops the frame timer, the idle playlist and every callback', () => {
    const { player, frames, created } = build({
      config: { fallbackFps: 8, idleClips: [0], idleIntervalMs: 1000 },
    })
    player.load('a.png')
    created[0].resolve(32, 24)
    player.setState('idle')
    // Both loops are armed: the frame timer and the idle playlist.
    expect(vi.getTimerCount()).toBe(2)

    player.destroy()
    expect(vi.getTimerCount()).toBe(0)
    const seen = frames.length
    vi.advanceTimersByTime(10_000)
    expect(frames).toHaveLength(seen)
  })

  it('releases the loaded image and its URL, and any load in flight', () => {
    const released: string[] = []
    const { player, created } = build({ releaseUrl: (url) => released.push(url) })
    player.load('a.png')
    created[0].resolve(32, 24)

    player.destroy()
    expect(released).toEqual(['a.png'])
    expect(created[0].onload).toBeNull()
    expect(player.currentImage).toBeNull()
  })

  it('commits nothing when a load in flight resolves after destruction', () => {
    const { player, frames, created } = build()
    player.load('a.png')
    player.destroy()
    created[0].resolve(32, 24)
    expect(frames).toEqual([])
    expect(player.spriteRect).toBeNull()
  })

  it('is idempotent', () => {
    const released: string[] = []
    const { player, created } = build({ releaseUrl: (url) => released.push(url) })
    player.load('a.png')
    created[0].resolve(32, 24)
    player.destroy()
    player.destroy()
    expect(released).toEqual(['a.png'])
  })

  it('stops drawing when the sheet is unloaded, without a new one to replace it', () => {
    const { player, frames, created } = build({ config: { fallbackFps: 8 } })
    player.load('a.png')
    created[0].resolve(32, 24)
    player.unload()
    const seen = frames.length
    vi.advanceTimersByTime(1000)
    expect(frames).toHaveLength(seen)
    expect(player.spriteRect).toBeNull()
    expect(player.currentImage).toBeNull()
  })

  it('stops calling a listener that unsubscribed', () => {
    const { player, created } = build({ config: { fallbackFps: 8 } })
    const seen: FramePlacement[] = []
    const off = player.onFrame((frame) => seen.push(frame))
    player.load('a.png')
    created[0].resolve(32, 24)
    expect(seen).toHaveLength(1)
    off()
    vi.advanceTimersByTime(500)
    expect(seen).toHaveLength(1)
  })
})
