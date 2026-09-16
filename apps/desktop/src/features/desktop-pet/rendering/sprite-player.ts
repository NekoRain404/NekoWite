/**
 * Sprite playback: which frame of which clip is on screen, and when that changes.
 *
 * Ported from `references/desktop-pet/windows/src/pet.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *   - the frame timer and its rationale (266-279)
 *   - the row precedence override > idle playlist > mood (285) and the frame reset on a
 *     row change (286, and 224 for a playlist restart)
 *   - clip clamping (261-264), frame selection (292) and per-clip scaling (293)
 *   - the fit, scale and headroom maths (303-311) and the fixed-grid fallback (295-301)
 *   - `setState` (200-210) and `setRow`/`clearRow` (248-256)
 *
 * The sheet's own lifetime - loading, the CORS retry, releasing it - is `sprite-sheet.ts`,
 * and the state-to-animation mapping is `animation-bindings.ts`. What is left here is the
 * playback state machine and the geometry.
 *
 * What the port changed, and why (plan §3, §3.1):
 *   - The clock is injected, so a test can hand-crank frames instead of sleeping, and the
 *     drawing is not done here at all: a tick resolves a placement and notifies only when
 *     that placement differs from the last one, so `drawImage` runs on an actual frame
 *     change rather than 3-8 times a second regardless of whether anything moved.
 *   - Upstream had no destruction path - the window lived as long as the app, so its timer
 *     was never released. A Vue component unmounts, so `destroy()` exists, and it is the
 *     only way the timer, the idle playlist and the listeners stop (§7.1, §10.2).
 */
import {
  DEFAULT_ANIMATION_CONFIG,
  IdlePlaylist,
  browserClock,
  normalizeAnimationConfig,
  resolveAnimation,
  type AnimationConfig,
  type SpriteClock,
} from './animation-bindings'
import { SheetLoader, type ImageFactory, type LoadFailure, type LoadableImage } from './sprite-sheet'
import {
  clampRow,
  clipWidths,
  fallbackGridFrame,
  type Rect,
  type SheetPixelReader,
} from './sprite-slicer'

/**
 * Upstream's floor between frames (line 271): the pet needs 3-8 fps, and a misconfigured
 * rate must not turn the timeout loop into a spin.
 */
export const MIN_FRAME_DELAY_MS = 80

/** Canvas size in backing-store pixels. */
export interface Viewport {
  width: number
  height: number
}

/** A frame resolved to the sheet rectangle it comes from and the rectangle to draw it in. */
export interface FramePlacement {
  source: Rect
  dest: Rect
  /** Unused space above the sprite, as a fraction of canvas height (upstream `headroom`). */
  headroom: number
  /** The active row (override ?? idle playlist ?? mood), before clamping to the sheet. */
  row: number
  /** The clip index the frame came from, or null when the fixed grid supplied it. */
  clip: number | null
}

export interface SpritePlayerDeps {
  /** Frame and idle scheduling. Defaults to the browser clock. */
  clock?: SpriteClock
  /** Canvas size in backing-store pixels, read on every tick (upstream read `canvas.width`). */
  viewport: () => Viewport
  /** Animation mapping and idle playlist settings; missing fields keep the upstream defaults. */
  config?: Partial<AnimationConfig>
  /** Randomness for the idle playlist's random mode. Defaults to `Math.random`. */
  random?: () => number
  /** Image factory for sheet loading. Defaults to `new Image()`. */
  createImage?: ImageFactory
  /** Sheet pixel reader. Defaults to the canvas-based one; injected for tests. */
  readPixels?: SheetPixelReader
  /** Both load attempts for a sheet failed. */
  onLoadError?: (failure: LoadFailure) => void
  /** Releases the URL of a sheet that is no longer displayed (§7.3). */
  releaseUrl?: (url: string) => void
}

export interface FrameFit {
  scale: number
  dest: Rect
  headroom: number
}

/**
 * Fit a frame into the canvas, anchored bottom-centre, snapped to an integer scale so pixel
 * art stays crisp (upstream 303-311). The scale comes from the clip's widest frame -
 * `scaleW` - rather than the frame being drawn, so an animation does not pulse and the
 * bubble above the pet does not bounce.
 *
 * Returns null for a canvas with no area. Upstream divided by a zero-height canvas
 * (`(H - dh) / H`, line 310) and put the resulting `NaN` into `headroom`, which the shell
 * then multiplied into the bubble's position; there is no sprite to place in a canvas that
 * has no size, so the answer is "nothing".
 */
export function fitFrame(source: Rect, scaleW: number, view: Viewport): FrameFit | null {
  if (view.width <= 0 || view.height <= 0) return null
  if (scaleW <= 0 || source.w <= 0 || source.h <= 0) return null
  const fit = Math.min(view.width / scaleW, view.height / source.h)
  const scale = fit >= 1 ? Math.floor(fit) : fit
  const w = source.w * scale
  const h = source.h * scale
  return {
    scale,
    dest: { x: (view.width - w) / 2, y: view.height - h, w, h },
    headroom: (view.height - h) / view.height,
  }
}

export class SpritePlayer {
  private readonly deps: SpritePlayerDeps
  private readonly idle: IdlePlaylist
  private readonly sheet: SheetLoader
  private readonly listeners = new Set<(frame: FramePlacement) => void>()

  private config: AnimationConfig
  private widths: number[] = []
  private frame = 0
  private fps: number
  private moodRow: number
  private overrideRow: number | null = null
  private lastRow = 0
  private lastIdleGeneration = -1
  private lastKey: string | null = null
  // The handle the clock handed back, in the clock's own type — `number` under the DOM
  // lib, `Timeout` under Node's. `SpriteClock` names it and says why.
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null
  private destroyed = false
  private rect: Rect | null = null
  private headroomValue = 0

  constructor(deps: SpritePlayerDeps) {
    this.deps = deps
    this.config = normalizeAnimationConfig(deps.config, DEFAULT_ANIMATION_CONFIG)
    this.fps = this.config.fallbackFps
    this.moodRow = this.config.fallbackRow
    this.idle = new IdlePlaylist({
      clock: this.clock,
      random: deps.random ?? Math.random,
      config: this.config,
    })
    this.sheet = new SheetLoader({
      createImage: deps.createImage,
      readPixels: deps.readPixels,
      onLoadError: deps.onLoadError,
      releaseUrl: deps.releaseUrl,
    })
    // A new sheet is a new animation: start it at its first frame and paint it now, rather
    // than waiting up to one frame interval for the next tick (upstream 272-278 did wait,
    // which leaves the window on the old sheet through a character switch).
    this.sheet.onChange(() => {
      this.widths = clipWidths(this.sheet.currentClips)
      this.frame = 0
      this.repaint()
    })
    // Upstream started the loop from its constructor (157) and never stopped it.
    this.schedule()
  }

  /** Last drawn sprite bounds in backing-store pixels - the pet's true bounds, or null. */
  get spriteRect(): Rect | null {
    return this.rect
  }

  /** Unused space above the sprite; the bubble sits in it (upstream field `headroom`). */
  get headroom(): number {
    return this.headroomValue
  }

  /** The loaded sheet, for whoever draws it. */
  get currentImage(): LoadableImage | null {
    return this.sheet.currentImage
  }

  private get clock(): SpriteClock {
    return this.deps.clock ?? browserClock
  }

  /** Subscribe to frame changes. Returns an unsubscribe function. */
  onFrame(listener: (frame: FramePlacement) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The host's mood changed (upstream `setState`, 200-210). Only the idle mood starts the
   * playlist; every other mood stops it.
   *
   * The repaint is conditional because the host polls this - upstream's caller ran it every
   * 500ms and its guard at 218 exists for the same reason - and an unconditional repaint
   * would draw on every poll, which is exactly what "draw on an actual frame change" rules
   * out. A state whose row, rate and playlist are unchanged changes nothing on screen.
   */
  setState(state: string): void {
    const binding = resolveAnimation(state, this.config)
    const changed = binding.row !== this.moodRow || binding.fps !== this.fps
    const generation = this.idle.generation
    this.fps = binding.fps
    this.moodRow = binding.row
    this.idle.setActive(state === 'idle')
    if (changed || this.idle.generation !== generation) this.repaint()
  }

  /**
   * Roam override (upstream `setRow`/`clearRow`, 248-256): the override outranks the idle
   * playlist and the mood, and changing it restarts the clip. Passing the value that is
   * already set is a no-op, as upstream's equality check made it.
   */
  setOverrideRow(row: number | null): void {
    if (this.overrideRow === row) return
    this.overrideRow = row
    this.frame = 0
    this.repaint()
  }

  /** A new animation config arrived; validated and merged over the current one. */
  setConfig(config: Partial<AnimationConfig>): void {
    this.config = normalizeAnimationConfig(config, this.config)
    this.idle.setConfig(this.config)
    this.repaint()
  }

  /** Load a spritesheet; the previous one stays on screen until the new one has decoded. */
  load(url: string): void {
    this.sheet.load(url)
  }

  /** Forget the current sheet: the caller clears the canvas, no frame is drawn. */
  unload(): void {
    this.sheet.unload()
    this.frame = 0
    // The pet's bounds are gone with the sheet: a hit test on a cleared canvas must find
    // nothing rather than the last sprite's rectangle.
    this.rect = null
    this.headroomValue = 0
  }

  /**
   * Stop everything this player owns: the frame timer, the idle playlist, a load in
   * flight, the loaded image and its URL, and every subscriber (§7.1: 禁用桌宠销毁动画/
   * 监听/计时器; §10.2: 无遗留监听). Idempotent, and afterwards no tick can fire and no
   * frame can be announced - which is what a Vue `onBeforeUnmount` needs.
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopTimer()
    this.idle.stop()
    this.sheet.destroy()
    this.listeners.clear()
    this.rect = null
    this.headroomValue = 0
  }

  /** The canvas changed size (or its device pixel ratio did): repaint even if the frame did not. */
  invalidate(): void {
    this.repaint()
  }

  /**
   * Frame loop, on `setTimeout` rather than `requestAnimationFrame` (upstream 266-279): the
   * pet needs 3-8 fps, and rAF's 60 Hz wakeups were pure waste - each tick rescheduled the
   * next one ~16ms later even when 300ms of idle time was available.
   */
  private schedule(): void {
    const delay = Math.max(MIN_FRAME_DELAY_MS, 1000 / this.fps)
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      if (this.destroyed) return
      if (this.sheet.isLoaded) {
        this.frame++
        this.emitFrame()
      }
      this.schedule()
    }, delay)
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Resolve the current row, frame and canvas into what to draw, or null for nothing. */
  private placement(): FramePlacement | null {
    const image = this.sheet.currentImage
    if (!image) return null
    const view = this.deps.viewport()
    const idleGeneration = this.idle.generation
    // Upstream 285: a roam override outranks the idle playlist, which outranks the mood.
    const row = this.overrideRow ?? this.idle.row ?? this.moodRow
    // Upstream 286: the clip starts over when the row being drawn changes.
    if (row !== this.lastRow || idleGeneration !== this.lastIdleGeneration) {
      this.lastRow = row
      this.lastIdleGeneration = idleGeneration
      this.frame = 0
    }

    let source: Rect | null = null
    let scaleW = 0
    let clipIndex: number | null = null
    const clips = this.sheet.currentClips
    if (clips.length) {
      const index = clampRow(row, clips.length)
      const clip = clips[index]
      if (clip.length) {
        clipIndex = index
        source = clip[this.frame % clip.length]
        scaleW = this.widths[index] || source.w
      }
    }
    if (!source) {
      // Pixels unreadable: the fixed 8x9 grid (upstream 295-301). The sheet itself is still
      // displayable, so the pet shows up rather than vanishing.
      source = fallbackGridFrame(image, this.frame, row)
      scaleW = source ? source.w : 0
    }
    if (!source) return null

    const fit = fitFrame(source, scaleW, view)
    if (!fit) return null
    return { source, dest: fit.dest, headroom: fit.headroom, row, clip: clipIndex }
  }

  /**
   * Resolve and, if anything about the drawn result changed, announce it. This is where
   * "draw on an actual frame change" (plan §3) happens: a one-frame clip, a stopped sheet,
   * or a tick that lands on the same frame as the last one produces no callback and
   * therefore no `drawImage`.
   */
  private emitFrame(): void {
    const placement = this.placement()
    if (!placement) return
    this.rect = placement.dest
    this.headroomValue = placement.headroom
    const key = frameKey(placement)
    if (key === this.lastKey) return
    this.lastKey = key
    for (const listener of [...this.listeners]) listener(placement)
  }

  /** Announce the current placement unconditionally - for a change the frame counter cannot see. */
  private repaint(): void {
    this.lastKey = null
    this.emitFrame()
  }
}

function frameKey(frame: FramePlacement): string {
  const { source, dest } = frame
  return `${source.x},${source.y},${source.w},${source.h}|${dest.x},${dest.y},${dest.w},${dest.h}`
}
