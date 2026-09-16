/**
 * The component half of D2: the canvas, its device pixel ratio sizing, and the
 * destruction path.
 *
 * It lives in `rendering/` rather than next to the component on purpose. D2's gate is
 * `vitest run src/features/desktop-pet/rendering` (plan §11, V2), which selects by path:
 * a test in `components/` would not run under the command this task is verified with, and
 * an unrun test is not evidence. The component under test is the same rendering pipeline
 * these other files exercise.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, shallowRef, type App as VueApp } from 'vue'
import PetSprite from '../components/PetSprite.vue'
import type { ImageFactory, LoadableImage } from './sprite-sheet'
import type { Rect, SheetPixels, SheetPixelReader } from './sprite-slicer'

class FakeImage implements LoadableImage {
  naturalWidth = 0
  naturalHeight = 0
  crossOrigin: string | null = null
  src = ''
  onload: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  resolve(width: number, height: number): void {
    this.naturalWidth = width
    this.naturalHeight = height
    this.onload?.(new Event('load'))
  }
}

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

interface Draw {
  source: Rect
  dest: Rect
}

/** The exposed API of PetSprite, as the shell sees it. */
interface SpriteApi {
  hitTest: (x: number, y: number) => boolean
  geometry: () => { spriteRect: Rect | null; headroom: number }
}

interface Harness {
  host: HTMLElement
  app: VueApp
  api: SpriteApi | null
  canvas: HTMLCanvasElement
  draws: Draw[]
  clears: () => number
  created: FakeImage[]
}

const apps: VueApp[] = []
// Typed against the real overloaded method rather than `vi.spyOn`'s default
// signature: `getContext` takes `"2d" | "webgl" | …`, and the default
// `(this: unknown, ...args: unknown[]) => unknown` is not assignable to it. The method's
// own type is named rather than reached through `vi.spyOn<HTMLCanvasElement, 'getContext'>`:
// that instantiation expression resolves against `spyOn`'s *first* overload — the
// `accessType: "get"` one, whose constraint is the type's data properties — and `getContext`
// is a method, so it fails there before reaching the overload this call actually takes.
let getContextSpy: MockInstance<HTMLCanvasElement['getContext']> | null = null

/**
 * Mounts with a recording 2D context (happy-dom implements no canvas, so the same
 * technique the graph panel's tests use applies) and hands back the component's exposed
 * API the way the shell reaches it.
 */
function mount(
  props: Record<string, unknown>,
  options: { alpha?: number; noContext?: boolean } = {},
): Harness {
  const draws: Draw[] = []
  let clears = 0
  const ctx = {
    imageSmoothingEnabled: true,
    clearRect: () => {
      clears++
    },
    drawImage: (
      _image: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => {
      draws.push({ source: { x: sx, y: sy, w: sw, h: sh }, dest: { x: dx, y: dy, w: dw, h: dh } })
    },
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, options.alpha ?? 255]) }),
  } as unknown as CanvasRenderingContext2D
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(options.noContext ? null : ctx)

  const created: FakeImage[] = []
  const createImage: ImageFactory = () => {
    const img = new FakeImage()
    created.push(img)
    return img
  }
  const api = shallowRef<SpriteApi | null>(null)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(PetSprite, {
            ...props,
            createImage,
            // `props` is a loose reactive record so a test can drive any prop,
            // which makes every read `unknown`; `unknown ?? x` narrows to
            // `{} | x`, and `{}` does not satisfy the reader signature. The cast
            // restores the type the fixture deliberately gave up.
            readPixels: (props.readPixels as SheetPixelReader | undefined) ?? twoCells,
            ref: (value: unknown) => {
              api.value = value as SpriteApi
            },
          })
      },
    }),
  )
  app.mount(host)
  apps.push(app)
  const canvas = host.querySelector('canvas')
  if (!canvas) throw new Error('PetSprite rendered no canvas')
  return { host, app, api: api.value, canvas, draws, clears: () => clears, created }
}

/** happy-dom performs no layout, so the CSS box is stated rather than measured. */
function withLayout(canvas: HTMLCanvasElement, width: number, height: number): void {
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: height })
}

function setDpr(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value })
}

beforeEach(() => {
  vi.useFakeTimers()
  setDpr(1)
})

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  document.body.innerHTML = ''
  getContextSpy?.mockRestore()
  getContextSpy = null
  vi.useRealTimers()
})

describe('PetSprite', () => {
  it('draws the loaded sheet at the size its props ask for', () => {
    const { canvas, draws, created } = mount({ imageUrl: 'a.png', width: 160, height: 180 })
    expect(draws).toEqual([])

    created[0].resolve(32, 24)
    expect(canvas.width).toBe(160)
    expect(canvas.height).toBe(180)
    expect(canvas.style.width).toBe('160px')
    expect(canvas.style.height).toBe('180px')
    expect(draws).toEqual([
      {
        source: { x: 0, y: 0, w: 8, h: 24 },
        dest: { x: 52, y: 12, w: 56, h: 168 },
      },
    ])
  })

  it('sizes the backing store by the device pixel ratio and repaints when it changes', async () => {
    const { canvas, draws, created } = mount({ imageUrl: 'a.png', width: 160, height: 180 })
    created[0].resolve(32, 24)
    expect(draws).toHaveLength(1)

    setDpr(2)
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    // The CSS box is unchanged; only the backing store grows, so the sheet is drawn at
    // device resolution instead of being resampled by the compositor.
    expect(canvas.width).toBe(320)
    expect(canvas.height).toBe(360)
    expect(draws).toHaveLength(2)
    expect(draws[1].dest).toEqual({ x: 100, y: 0, w: 120, h: 360 })
  })

  it('advances frames on the clock and stops when it is unmounted', () => {
    const { app, draws, created } = mount({ imageUrl: 'a.png' })
    created[0].resolve(32, 24)
    expect(draws).toHaveLength(1)

    vi.advanceTimersByTime(1000)
    expect(draws.length).toBeGreaterThan(1)

    app.unmount()
    const seen = draws.length
    vi.advanceTimersByTime(10_000)
    window.dispatchEvent(new Event('resize'))
    // The destruction path: the frame timer is gone, so not one further callback arrives
    // and nothing is drawn (§7.1, case "no frame callbacks after unmount").
    expect(draws).toHaveLength(seen)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the canvas when the character goes away', async () => {
    // The props object is reactive, so the shell can switch characters while mounted.
    const props = reactive<Record<string, unknown>>({ imageUrl: 'a.png' })
    const { draws, clears, created } = mount(props)
    created[0].resolve(32, 24)
    expect(draws).toHaveLength(1)
    // Each draw clears first (upstream 283), so one frame is one clear.
    expect(clears()).toBe(1)

    props.imageUrl = null
    await nextTick()
    // No frame is drawn for "no character", so without the explicit clear the last sprite
    // would stay painted on the canvas forever.
    expect(draws).toHaveLength(1)
    expect(clears()).toBe(2)
  })

  it('reports a canvas with no 2D context instead of blanking the window', () => {
    const onUnavailable = vi.fn()
    const { draws, created } = mount({ imageUrl: 'a.png', onUnavailable }, { noContext: true })
    created[0].resolve(32, 24)
    expect(onUnavailable).toHaveBeenCalledWith('no-2d-context')
    // Upstream threw from its constructor here, which in a Vue mount would take the pet
    // window down; the component draws nothing and says so instead.
    expect(draws).toEqual([])
  })

  it('hit-tests a CSS point against the sprite it actually drew', () => {
    const { canvas, api, created } = mount({ imageUrl: 'a.png', width: 160, height: 180 })
    created[0].resolve(32, 24)
    withLayout(canvas, 160, 180)
    if (!api) throw new Error('no exposed API')

    // The sprite sits at x 52..108, y 12..180 of the canvas.
    expect(api.hitTest(80, 90)).toBe(true)
    expect(api.hitTest(4, 4)).toBe(false)
    expect(api.geometry().spriteRect).toEqual({ x: 52, y: 12, w: 56, h: 168 })
    expect(api.geometry().headroom).toBe(12 / 180)
  })

  it('hit-tests the same CSS point on a 2x display', () => {
    // The sprite's backing-store bounds double with the ratio, and so does the surface the
    // component hands the hit test; the verdict must not change.
    setDpr(2)
    const { canvas, api, created } = mount({ imageUrl: 'a.png', width: 160, height: 180 })
    created[0].resolve(32, 24)
    withLayout(canvas, 160, 180)
    if (!api) throw new Error('no exposed API')

    expect(canvas.width).toBe(320)
    expect(api.geometry().spriteRect).toEqual({ x: 100, y: 0, w: 120, h: 360 })
    expect(api.hitTest(80, 90)).toBe(true)
    expect(api.hitTest(4, 4)).toBe(false)
  })

  it('ignores a point when no sprite has been drawn', () => {
    const { canvas, api } = mount({ imageUrl: 'a.png' })
    withLayout(canvas, 160, 180)
    if (!api) throw new Error('no exposed API')
    expect(api.hitTest(80, 90)).toBe(false)
    expect(api.geometry().spriteRect).toBeNull()
  })
})
