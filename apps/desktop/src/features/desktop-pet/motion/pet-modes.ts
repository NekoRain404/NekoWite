/**
 * The four ways the pet moves itself, one step at a time.
 *
 * Ported from `references/desktop-pet/windows/src/roam/modes.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *
 *   - the facing rows (`:20-21`), the context a mode reads (`:23-27`) and the dispatch
 *     (`:32-40`)
 *   - `followCursor` (`:43-57`), `wander` (`:78-98`) and `climb` (`:103-128`)
 *   - `moveToward` (`:130-143`), `inBounds` (`:70-73`), `randomTarget` (`:145-149`)
 *   - `findSurfaceBelow` (`:153-165`) and `pickClimbDirection` (`:167-172`)
 * The shared constants it used to read from that file — `pxPerSec` (`types.ts:133-135`),
 * `clampToBounds` (`types.ts:126-131`) and the rest and margin constants (`types.ts:41`,
 * `:43-44`) — are in `pet-motion-types.ts` with the rest of `types.ts`.
 *
 * What the port changed, and why:
 *   - The wander target and the rest deadline travel in {@link RoamModeState} instead of
 *     module scope (`modes.ts:62`, `:68`). Upstream had one pet per webview, so module
 *     scope *was* per-pet; §7.1 allows three characters in one window, and two of them
 *     sharing a target would walk to each other's destination.
 *   - The speed and the clock arrive in the context instead of each mode re-reading
 *     `loadConfig()` (`modes.ts:80`, `:112`, `:135`) and `Date.now()` (`:81`, `:93`): the
 *     same values, read once by the engine that already has them.
 *   - The dispatch is total over the behaviours rather than falling through to `wander`
 *     (`modes.ts:38-39`), so a mode added without a strategy is a type error instead of a
 *     pet that wanders — the contract's own reason for total tables (`pet-contracts.ts`).
 *   - `climb` stands still when there is nothing to climb. Upstream fell back to `wander`
 *     (`:105`), but the configured mode was still `climb`, so `wander`'s own guard (`:80`)
 *     returned the unchanged position: the fallback never walked. §7.2 prefers staying to
 *     imitating another mode, so this does deliberately what upstream did by accident.
 *
 * Which of these modes a machine may actually run is `pet-mode-gate.ts`'s business, not this
 * file's: these four are written as upstream wrote them, and the gate decides whether one of
 * them is allowed to run at all (§7.2).
 */
import {
  DT_SEC,
  ROW_LEFT,
  ROW_RIGHT,
  WIN_H,
  WIN_W,
  type PetMotionFrame,
  type Point,
  type Rect,
} from './pet-physics'
import {
  IDLE_MS_MAX,
  IDLE_MS_MIN,
  MARGIN,
  clampToBounds,
  pxPerSec,
  type PetRoamBehaviour,
} from './pet-motion-types'
import type { MotionEnvironment } from './pet-platform'

/**
 * What a mode carries between ticks. Upstream's module-level `wanderTarget` and `restUntil`
 * (`modes.ts:62`, `:68`), per engine.
 */
export interface RoamModeState {
  /** Where a wandering pet is walking; null between destinations. */
  target: Point | null
  /** A deadline (epoch ms) the pet rests until. Set by `wander` and `climb`. */
  restUntil: number
}

export function createRoamModeState(): RoamModeState {
  return { target: null, restUntil: 0 }
}

/** Everything a mode reads. Upstream's `ModeContext` (`modes.ts:23-27`) plus the injected parts. */
export interface ModeContext {
  env: MotionEnvironment
  /** The pet window's top-left, logical px. */
  pos: Point
  /** Row overrides while walking; null when nothing is drawn. */
  frame: PetMotionFrame | null
  /** 1..10, already validated by the engine. */
  speed: number
  /** 0 <= r < 1. */
  random: () => number
  /** Epoch ms. */
  now: () => number
  /** The pointer in logical px, or null when it cannot be read (`modes.ts:44-56`). */
  pointer: () => Promise<Point | null>
}

/**
 * One step of a mode, returning where it wants the pet to be.
 *
 * The modes are as close to pure as upstream made them: what they decide depends on the
 * position, the environment and {@link RoamModeState}, and where the pet actually ends up
 * is the engine's business.
 */
export async function runMode(
  behaviour: PetRoamBehaviour,
  ctx: ModeContext,
  state: RoamModeState,
): Promise<Point> {
  switch (behaviour) {
    case 'stay':
      return ctx.pos
    case 'follow-pointer':
      return followPointer(ctx)
    case 'climb':
      return climb(ctx, state)
    case 'wander':
      return wander(ctx, state)
  }
}

/** Chase the pointer, aiming under it so the cursor is not covered. `modes.ts:43-57`. */
async function followPointer(ctx: ModeContext): Promise<Point> {
  const pointer = await ctx.pointer()
  if (!pointer) return ctx.pos
  return moveToward({ x: pointer.x - WIN_W / 2, y: pointer.y - WIN_H + 20 }, ctx)
}

/**
 * Random walk inside the work area (`modes.ts:78-98`).
 *
 * The target has to outlive the tick, or the pet picks a new destination 33 times a second
 * and jitters in place. Idling is a deadline rather than a blocking sleep, so a drag or a
 * mood change is still noticed while the pet rests.
 */
async function wander(ctx: ModeContext, state: RoamModeState): Promise<Point> {
  if (ctx.now() < state.restUntil) return ctx.pos
  if (!state.target || !inBounds(state.target, ctx.env.workArea)) {
    state.target = randomTarget(ctx.env.workArea, ctx.random)
  }
  const target = state.target
  const dx = target.x - ctx.pos.x
  const dy = target.y - ctx.pos.y

  if (Math.hypot(dx, dy) < 6) {
    state.target = null
    state.restUntil = ctx.now() + IDLE_MS_MIN + ctx.random() * (IDLE_MS_MAX - IDLE_MS_MIN)
    ctx.frame?.clearRow()
    return ctx.pos
  }
  return moveToward(target, ctx)
}

/**
 * Walk along the top edges of other windows, resting when one runs out (`modes.ts:103-128`).
 *
 * Only reachable where `window-climb` was verified: on Linux the window list does not exist
 * and the gate keeps this mode from being selected at all (§7.2).
 */
async function climb(ctx: ModeContext, state: RoamModeState): Promise<Point> {
  if (ctx.env.surfaces.length === 0) return ctx.pos
  if (ctx.now() < state.restUntil) return ctx.pos

  const surface = findSurfaceBelow(ctx.pos, ctx.env)
  const direction = pickClimbDirection(ctx.pos, surface, ctx.random)
  const nextX = ctx.pos.x + direction * pxPerSec(ctx.speed) * DT_SEC
  if (nextX < surface.left - 2 || nextX > surface.right + 2) {
    state.restUntil = ctx.now() + IDLE_MS_MIN + ctx.random() * (IDLE_MS_MAX - IDLE_MS_MIN)
    ctx.frame?.clearRow()
    return ctx.pos
  }
  ctx.frame?.setRow(direction > 0 ? ROW_RIGHT : ROW_LEFT)
  return clampToBounds({ x: nextX, y: surface.top - WIN_H }, ctx.env.workArea)
}

/** `modes.ts:130-143`: walk at the configured speed, stop within 8 px, face the way you go. */
function moveToward(target: Point, ctx: ModeContext): Point {
  const dx = target.x - ctx.pos.x
  const dy = target.y - ctx.pos.y
  const dist = Math.hypot(dx, dy)
  if (dist < 8) {
    ctx.frame?.clearRow()
    return ctx.pos
  }
  const move = Math.min(dist, pxPerSec(ctx.speed) * DT_SEC)
  ctx.frame?.setRow(dx > 0 ? ROW_RIGHT : ROW_LEFT)
  return clampToBounds(
    { x: ctx.pos.x + (dx / dist) * move, y: ctx.pos.y + (dy / dist) * move },
    ctx.env.workArea,
  )
}

/** `modes.ts:70-73`: is a point a position the pet could be parked at? */
function inBounds(position: Point, bounds: Rect): boolean {
  return (
    position.x >= bounds.left &&
    position.x <= bounds.right - WIN_W &&
    position.y >= bounds.top &&
    position.y <= bounds.bottom - WIN_H
  )
}

/** A destination inset from every edge. Upstream `randomTarget` (`modes.ts:145-149`). */
function randomTarget(bounds: Rect, random: () => number): Point {
  return {
    x: bounds.left + MARGIN + random() * Math.max(1, bounds.right - bounds.left - WIN_W - MARGIN * 2),
    y: bounds.top + MARGIN + random() * Math.max(1, bounds.bottom - bounds.top - WIN_H - MARGIN * 2),
  }
}

/**
 * The surface under the pet's centre, the work area otherwise (`modes.ts:153-165`).
 *
 * Upstream also carried an `isWindow` flag nothing read, and a `null` return that could not
 * happen because the work area was always the fallback.
 */
function findSurfaceBelow(position: Point, env: MotionEnvironment): Rect {
  let best = env.workArea
  let bestTop = env.workArea.bottom
  const centerX = position.x + WIN_W / 2
  for (const surface of env.surfaces) {
    if (centerX < surface.left || centerX > surface.right) continue
    if (surface.top >= position.y + WIN_H && surface.top < bestTop) {
      bestTop = surface.top
      best = surface
    }
  }
  return best
}

/** Walk toward the middle of the surface, or off an edge at random. `modes.ts:167-172`. */
function pickClimbDirection(position: Point, surface: Rect, random: () => number): number {
  const center = position.x + WIN_W / 2
  const surfaceCenter = (surface.left + surface.right) / 2
  if (Math.abs(center - surfaceCenter) < 10) return random() < 0.5 ? -1 : 1
  return center < surfaceCenter ? 1 : -1
}
