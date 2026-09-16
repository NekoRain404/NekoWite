/**
 * Drag sampling, and the two motions a released pet can be in.
 *
 * Ported from `references/desktop-pet/windows/src/roam/physics.ts` and the physics
 * constants of `roam/types.ts`, at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *
 *   - `recordSample` / `releaseVelocity` / `clearSamples` (`physics.ts:24-44`) with the
 *     120 ms window they keep (`types.ts:49`), and the throw flag with its cancellation
 *     (`physics.ts:46-48`)
 *   - `applyThrow` (`physics.ts:52-84`): friction, the 50 % edge reflection, the speed floor,
 *     the facing row per step
 *   - `applyFall` (`physics.ts:88-121`) and `findFloor` (`physics.ts:140-148`): gravity onto
 *     the nearest surface top; `bounceX` / `bounceY` (`physics.ts:123-135`)
 *   - the constants those functions are written in (`types.ts:39-41`, `46-57`), and the
 *     logical-pixel window seam of `roam/window.ts:14-28` as {@link LogicalWindow}
 *
 * What the port changed, and why:
 *   - The samples are an object and the throw flag a session passed in, instead of module
 *     state (`physics.ts:22`, `:46`): upstream had one pet per webview, so module scope *was*
 *     per-pet, while §7.1 allows three characters in one window and two of them sharing a
 *     buffer would throw each other across the screen.
 *   - The window, the clock and the sprite rows are arguments: upstream imported
 *     `@tauri-apps/api` (`physics.ts:5`, `:19`) and read `performance.now()` (`:25`), so no
 *     test could drive a throw.
 *   - A failed write still ends the throw, as upstream did (`:76`, `:113`), but it is
 *     *reported* through {@link PhysicsDeps.onPlatformError} rather than logged with an
 *     `invoke("log_debug")` this port has no command for.
 */

/** A point in logical pixels. Upstream `types.ts:7`. */
export interface Point {
  x: number
  y: number
}

/**
 * Screen bounds in logical pixels, as four edges — upstream `types.ts:9-14`, kept that way
 * because every clamp and reflection below is written against them.
 */
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Pixels per second. Upstream returned this shape inline (`physics.ts:30`). */
export interface Velocity {
  vx: number
  vy: number
}

/** The pet window, in logical pixels. Upstream `roam/window.ts`. */
export interface LogicalWindow {
  /**
   * Null when the position cannot be read now: the window is closing, or the desktop does not
   * hand a toplevel its own position (`window.ts:14-22` returns null on any failure, and both
   * callers below stop rather than guess).
   */
  currentPosition(): Promise<Point | null>
  /** Move the window. The caller has already clamped to the work area (`window.ts:26-28`). */
  moveTo(position: Point): Promise<void>
}

/**
 * The sprite rows a moving pet is drawn with. Upstream reached into the live `Pet` from both
 * the modes and here; those two calls are the whole dependency, so they are the interface.
 */
export interface PetMotionFrame {
  /** Override the current row (upstream `pet.setRow`, `pet.ts:248-256`). */
  setRow(row: number): void
  /** Drop the override and let the state's own animation resume. */
  clearRow(): void
}

/** The sheet's facing rows. Upstream `roam/modes.ts:20-21`; here because physics sets them too. */
export const ROW_RIGHT = 1
export const ROW_LEFT = 2

/** Window size in logical pixels. Upstream `types.ts:39-40` — the size every bound uses. */
export const WIN_W = 260
export const WIN_H = 320

/** One tick, and the fixed dt the physics integrates with. Upstream `types.ts:51-54`. */
export const TICK_MS = 30
export const DT_SEC = TICK_MS / 1000

/** Per-tick decay, the speed a throw ends below, and gravity in px/s². `types.ts:46-48`. */
export const PHYSICS_FRICTION = 0.9
export const PHYSICS_MIN_SPEED = 15
export const PHYSICS_GRAVITY = 1800

/** How much of a drag is sampled for the release velocity. Upstream `types.ts:49`. */
export const SAMPLE_WINDOW_MS = 120

/**
 * Below this release speed (px/s) nothing is thrown and the pet simply stays: upstream
 * `types.ts:56-57`, and what keeps a careful placement from being read as a flick.
 */
export const THROW_MIN_SPEED = 15

interface DragSample {
  t: number
  x: number
  y: number
}

/**
 * The last 120 ms of a drag, and the velocity they imply. Upstream `physics.ts:21-44`: a sample
 * older than the window is dropped when a newer one arrives, so the velocity is the recent
 * gesture — a pet carried slowly across the screen and let go of quickly must not fly off with
 * the average of both.
 */
export class DragTrace {
  private readonly samples: DragSample[] = []

  /** Upstream `recordSample` (`physics.ts:24-28`), with the clock injected. */
  record(position: Point, now: number): void {
    this.samples.push({ t: now, x: position.x, y: position.y })
    while (this.samples.length > 0 && now - this.samples[0].t > SAMPLE_WINDOW_MS) this.samples.shift()
  }

  /** Upstream `releaseVelocity` (`physics.ts:30-40`): px/s, or null when there is no gesture. */
  releaseVelocity(): Velocity | null {
    if (this.samples.length < 2) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const dt = last.t - first.t
    // Two samples a millisecond apart divide by something near zero and produce a
    // velocity of thousands of pixels per second. Upstream refused the case (`:35`).
    if (dt < 20) return null
    return { vx: ((last.x - first.x) / dt) * 1000, vy: ((last.y - first.y) / dt) * 1000 }
  }

  /** Upstream `clearSamples` (`physics.ts:42-44`). */
  clear(): void {
    this.samples.length = 0
  }
}

/**
 * Whether a throw or a fall is in flight, and the handle that cancels it.
 *
 * Upstream's `throwing` flag (`physics.ts:46-48`) was module-level and read by the engine
 * for tick priority. Clearing `running` from outside is `cancelThrow`, and it is how a
 * drag takes over from a motion still in flight — §7.3's 「从当前状态反向运行，不排队」,
 * because the pet is where the drag found it rather than finishing the old motion first.
 */
export interface ThrowSession {
  running: boolean
}

/** Everything the two motions below reach outside themselves. */
export interface PhysicsDeps {
  window: LogicalWindow
  /** Pause between steps. Upstream `sleep(TICK_MS)`; injected so tests do not wait. */
  sleep: (ms: number) => Promise<void>
  /** Sprite rows while airborne; null when nothing is being drawn. */
  frame: PetMotionFrame | null
  /** Upstream logged these through `log_debug` (`physics.ts:76`, `:113`). */
  onPlatformError?: (error: unknown) => void
  /** Upstream's `stop` parameter (`physics.ts:58`, `:95`): the engine is going away. */
  stopped: () => boolean
}

/**
 * Inertia after a drag release. Upstream `applyThrow` (`physics.ts:52-84`).
 *
 * Friction decays the velocity each tick and an edge reflects it at half speed, so the
 * pet feels like it is sliding rather than teleporting when it hits the screen edge. The
 * loop ends on the speed floor, on a cancelled session, on the engine stopping, or on the
 * first write the platform refuses — it never keeps stepping a pet it cannot move.
 */
export async function applyThrow(
  deps: PhysicsDeps,
  session: ThrowSession,
  velocity: Velocity,
  bounds: Rect,
): Promise<void> {
  session.running = true
  let pos = await deps.window.currentPosition()
  if (!pos) {
    session.running = false
    return
  }
  let { vx, vy } = velocity

  while (!deps.stopped() && session.running) {
    if (Math.hypot(vx, vy) < PHYSICS_MIN_SPEED) break

    vx *= PHYSICS_FRICTION
    vy *= PHYSICS_FRICTION

    const bouncedX = bounceX(vx, pos.x + vx * DT_SEC, bounds)
    const bouncedY = bounceY(vy, pos.y + vy * DT_SEC, bounds)
    vx = bouncedX[0]
    vy = bouncedY[0]
    pos = { x: bouncedX[1], y: bouncedY[1] }

    try {
      await deps.window.moveTo(pos)
    } catch (error) {
      deps.onPlatformError?.(error)
      break
    }

    deps.frame?.setRow(vx > 0 ? ROW_RIGHT : ROW_LEFT)
    await deps.sleep(TICK_MS)
  }

  session.running = false
  deps.frame?.clearRow()
}

/**
 * Gravity after a drag release, Shimeji-style: the pet accelerates downward until it
 * lands on a surface — the work area's bottom edge or a window top. Upstream `applyFall`
 * (`physics.ts:88-121`).
 *
 * Horizontal motion is kept from the throw (the release's `vx`), so a fall still carries
 * the pet the way it was thrown, but nothing reflects: a falling pet lands.
 */
export async function applyFall(
  deps: PhysicsDeps,
  session: ThrowSession,
  vx: number,
  bounds: Rect,
  surfaces: readonly Rect[],
): Promise<void> {
  session.running = true
  let pos = await deps.window.currentPosition()
  if (!pos) {
    session.running = false
    return
  }
  let vy = 0

  while (!deps.stopped() && session.running) {
    vy += PHYSICS_GRAVITY * DT_SEC
    // Both are annotated because `pos` is assigned from them further down: read as `pos.x`
    // and `pos.y` they depend on `pos`, and written as `pos`'s next value they are depended
    // on by it, so with neither type named the inference for the three runs in a circle.
    const nx: number = pos.x + vx * DT_SEC
    let ny: number = pos.y + vy * DT_SEC

    const floorY = findFloor(pos.x, nx, bounds, surfaces)
    if (ny >= floorY) {
      ny = floorY
      session.running = false
    }

    // Only x is clamped here: y is settled by the floor above, and clamping it would
    // stop the pet short of a surface it is falling onto. Upstream `:111`.
    pos = { x: Math.max(bounds.left, Math.min(bounds.right - WIN_W, nx)), y: ny }
    try {
      await deps.window.moveTo(pos)
    } catch (error) {
      deps.onPlatformError?.(error)
      break
    }

    deps.frame?.setRow(vx > 0 ? ROW_RIGHT : ROW_LEFT)
    await deps.sleep(TICK_MS)
  }

  session.running = false
  deps.frame?.clearRow()
}

/** Upstream `bounceX` (`physics.ts:123-128`): reflect at half speed, then clamp. */
function bounceX(vx: number, nx: number, bounds: Rect): [number, number] {
  if (nx < bounds.left || nx > bounds.right - WIN_W) {
    return [-vx * 0.5, Math.max(bounds.left, Math.min(bounds.right - WIN_W, nx))]
  }
  return [vx, nx]
}

/** Upstream `bounceY` (`physics.ts:130-135`). */
function bounceY(vy: number, ny: number, bounds: Rect): [number, number] {
  if (ny < bounds.top || ny > bounds.bottom - WIN_H) {
    return [-vy * 0.5, Math.max(bounds.top, Math.min(bounds.bottom - WIN_H, ny))]
  }
  return [vy, ny]
}

/**
 * The highest surface under the pet's horizontal range, as the pet's *top* y when it
 * rests on it. Upstream `findFloor` (`physics.ts:140-148`).
 *
 * `pos.y` is the window's top-left, so resting on a surface means `top = surface.top -
 * WIN_H`. A surface above the work area's top is ignored, which is what keeps a window
 * dragged off-screen from parking the pet above the screen.
 */
function findFloor(x1: number, x2: number, bounds: Rect, surfaces: readonly Rect[]): number {
  let floor = bounds.bottom - WIN_H
  for (const surface of surfaces) {
    if (x2 < surface.left || x1 > surface.right) continue
    const top = surface.top - WIN_H
    if (top < floor && top >= bounds.top) floor = top
  }
  return floor
}
