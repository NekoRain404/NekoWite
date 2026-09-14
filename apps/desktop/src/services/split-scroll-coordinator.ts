/**
 * Animation coordinator for split-view scroll synchronization.
 *
 * Split mode shows a source pane beside a rendered pane and keeps the two in
 * step. Source and rendered text are laid out differently, so the two panes
 * move by different amounts and the mapping between their positions is the
 * caller's business (see `scrollSyncAnchors.ts`). This module owns only the
 * motion: a destination offset that changes faster than the display refreshes,
 * collapsed into one frame per tick and eased toward the newest value.
 *
 * Framework independent by construction — the frame loop, the clock, and the
 * scroll reads/writes all arrive as injected dependencies, so the module never
 * touches `window`, `document`, `performance` or `requestAnimationFrame` and
 * the tests drive it from a hand-cranked frame loop. `requestFrame` is shaped
 * exactly like `requestAnimationFrame` (it hands the callback a timestamp in
 * ms), so the real caller can pass it straight through.
 *
 * Timing: the `--app-ease` curve from `styles/tokens.css`
 * (`cubic-bezier(0.22, 1, 0.36, 1)`), over a window that scales with the
 * distance being crossed. The token is a CSS length and a CSS timing function —
 * neither is importable from here — so the curve is restated as a Bézier solver
 * and kept numerically identical to it. A split pane easing on a different
 * curve from every dialog around it is a seam the eye can find.
 *
 * The window spans `--app-motion` to `--app-motion-slow` of that file's motion
 * ladder, rather than sitting on one rung: a scroll sync has no single "how far
 * does it travel". Held at one duration it reads wrong at both ends — a
 * one-line nudge waiting out a fixed 300ms is lag, and a page-and-a-half jump
 * at a fixed 180ms is a teleport. `legDurationMs` grows with the distance and
 * saturates, so a nudge pays the low rung and a jump the high one.
 */

/**
 * Duration of the shortest leg, in ms — the `--app-motion` rung of the ladder
 * in `styles/tokens.css` ("a region changing state in place"). The floor
 * applies to a travel of no distance, and is what a one-line nudge pays: long
 * enough for the curve to read as motion, short enough that a wheel burst
 * re-targets it before it finishes rather than falling behind the input.
 */
export const SPLIT_SCROLL_MIN_DURATION_MS = 180

/**
 * Duration a leg approaches as its distance grows, in ms — the
 * `--app-motion-slow` rung ("a whole surface arriving"). An asymptote rather
 * than a cap: the curve approaches it smoothly, so a travel that crosses the
 * value below never changes its pacing by more than a few ms. A page-and-a-half
 * jump is a whole screenful of text arriving, which is what earns the top rung.
 */
export const SPLIT_SCROLL_MAX_DURATION_MS = 260

/**
 * Distance, in px, at which a leg is halfway between the floor and the ceiling.
 * It is the shape of the scaling law: a wheel notch (~100px) stays near the
 * floor, a page jump (~700px) is most of the way up, and the ceiling is left
 * for scrollbar drags and outline-scale moves that are already at the end.
 */
export const SPLIT_SCROLL_DURATION_SCALE_PX = 450

/**
 * Per-frame displacement below this, in px, that counts as arrived: the loop
 * writes the exact target and stops instead of spending more frames on
 * movement no display can show. Tighter than the 0.5px the pre-existing sync
 * code settled at (`editorScrollSync.ts`, `SourcePane.vue`) because that
 * tolerance is also what the panes use to recognise a document's own ends, and
 * the two ask different questions: a pane one engine-quantum short of an end
 * still belongs on the end, while a leg half a pixel short of its target has
 * not finished travelling. Pinned by the constants test.
 */
export const SPLIT_SCROLL_SETTLE_PX = 0.25

export interface SplitScrollCoordinatorDeps {
  /** Schedule a single frame; the callback receives that frame's timestamp in
   *  ms on the same clock every time. `requestAnimationFrame` fits directly. */
  requestFrame: (callback: (time: number) => void) => number
  /** Cancel a handle returned by `requestFrame`. */
  cancelFrame: (handle: number) => void
  /** Current scroll offset of the destination pane. */
  readScroll: () => number
  /** Write a scroll offset into the destination pane. */
  writeScroll: (value: number) => void
  /** Clamp an offset into the destination's scrollable range. Only the adapter
   *  knows that range, so the coordinator assumes no bounds of its own. */
  clampScroll: (value: number) => number
}

export interface SplitScrollCoordinator {
  /**
   * Move the destination to `target` px.
   *
   * `animated === false` writes it in this call, synchronously, and queues no
   * frame: that is the path for mode changes, divider-resize completion, outline
   * jumps and reduced motion, all of which must never animate.
   *
   * `animated === true` eases toward it, and any number of calls before the next
   * frame collapse into that one frame aiming at the last target.
   */
  schedule(target: number, animated: boolean): void
  /** Stop animating and drop the pending target; the pane stays where it is. */
  cancel(): void
  /** `cancel()`, permanently: later `schedule` calls do nothing. Idempotent. */
  dispose(): void
}

/**
 * The `--app-ease` token's curve, `cubic-bezier(0.22, 1, 0.36, 1)`, as a
 * function of normalised time.
 *
 * Both control points sit at y = 1, so the curve has zero slope at t = 1: the
 * motion decelerates all the way into the target instead of stopping on a
 * still-visible velocity, which is what makes the landing read as settled. The
 * cost is that its tail is long and flat — the last fifth of the window covers
 * 0.15% of the distance — so the tail is truncated by the arrival tolerance
 * rather than animated out.
 *
 * The x-component is inverted by Newton-Raphson, then bisection when the
 * derivative is too small for Newton to converge. Both halves matter: at the
 * flat end of the curve the derivative approaches zero and Newton alone takes
 * unbounded steps (or divides by zero), which is exactly where the loop spends
 * its last frames.
 */
function easeOut(progress: number): number {
  if (progress <= 0) return 0
  if (progress >= 1) return 1

  const x1 = 0.22
  const x2 = 0.36
  const bezier = (t: number, a: number, b: number): number => {
    const u = 1 - t
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
  }
  const dx = (t: number): number =>
    3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2)

  let t = progress
  for (let i = 0; i < 8; i += 1) {
    const slope = dx(t)
    if (Math.abs(slope) < 1e-6) break
    const error = bezier(t, x1, x2) - progress
    if (Math.abs(error) < 1e-9) break
    t -= error / slope
  }
  // Newton can leave [0, 1] on the flat end; bisection is guaranteed to land.
  if (t < 0 || t > 1 || Math.abs(bezier(t, x1, x2) - progress) > 1e-7) {
    let low = 0
    let high = 1
    for (let i = 0; i < 40; i += 1) {
      t = (low + high) / 2
      if (bezier(t, x1, x2) < progress) low = t
      else high = t
    }
  }
  return bezier(t, 1, 1)
}

/**
 * Length of one easing leg, in ms, for a travel of `distance` px.
 *
 * `min + span * d / (d + scale)`: it leaves the floor with no step (a leg one
 * pixel longer than the next is one millisecond longer), saturates without a
 * knee, and is monotone in distance, so a longer travel can never finish
 * sooner than a shorter one. Distance is the size of the move, not its
 * direction — a re-target behind the pane is as long a travel as its mirror.
 */
export function legDurationMs(distance: number): number {
  const span = SPLIT_SCROLL_MAX_DURATION_MS - SPLIT_SCROLL_MIN_DURATION_MS
  const travel = Math.abs(distance)
  if (!Number.isFinite(travel)) return SPLIT_SCROLL_MAX_DURATION_MS
  return SPLIT_SCROLL_MIN_DURATION_MS + (span * travel) / (travel + SPLIT_SCROLL_DURATION_SCALE_PX)
}

export function createSplitScrollCoordinator(
  deps: SplitScrollCoordinatorDeps,
): SplitScrollCoordinator {
  let frame: number | null = null // at most one pending frame, ever
  let target: number | null = null // destination of the leg in flight
  let origin = 0 // where that leg started from
  let legMs = 0 // that leg's window, from its own distance
  let startedAt: number | null = null // the leg's clock base: its first frame's stamp
  let lastFrameAt: number | null = null // newest stamp seen, for re-anchoring mid-leg
  let quietFrom = 0 // where the pane last sat still, for the arrival check
  let disposed = false

  function stopFrame(): void {
    if (frame === null) return
    deps.cancelFrame(frame)
    frame = null
  }

  function clearLeg(): void {
    target = null
    startedAt = null
  }

  function onFrame(time: number): void {
    frame = null
    if (target === null) return // cancelled while the frame was in the air
    lastFrameAt = time

    if (startedAt === null) {
      // A frame timestamp is the only clock in play, so the first frame of a leg
      // pins its base rather than measuring a window it cannot know.
      startedAt = time
      frame = deps.requestFrame(onFrame)
      return
    }

    const destination = target
    const progress = Math.max(0, Math.min((time - startedAt) / legMs, 1))
    // How far this frame moves the pane, from wherever the leg last left it.
    // Signed only by direction: a re-target behind the pane moves the value
    // backwards, and a step that is small is small either way.
    const travelled = origin + (destination - origin) * easeOut(progress)
    const value =
      destination >= origin ? Math.min(travelled, destination) : Math.max(travelled, destination)
    const step = Math.abs(value - quietFrom)

    if (progress >= 1 || step < SPLIT_SCROLL_SETTLE_PX) {
      // Land exactly and let the loop die here. Two ways to arrive: the
      // window closed (`progress === 1`, which also covers a frame that
      // arrives late), or this frame would move the pane by less than the
      // arrival tolerance should ever be visible as — the curve has
      // flattened, which is what its long tail spends frames on.
      clearLeg()
      deps.writeScroll(destination)
      return
    }

    // Re-arm before writing: a write that lands back in `schedule` synchronously
    // (a pane reacting to a programmatic write) has to find the next frame
    // already pending, or it would queue a second one behind this one.
    frame = deps.requestFrame(onFrame)
    quietFrom = value
    deps.writeScroll(value)
  }

  function schedule(rawTarget: number, animated: boolean): void {
    if (disposed) return
    if (Number.isNaN(rawTarget)) return // a NaN has no position to ease toward
    const destination = deps.clampScroll(rawTarget)

    if (!animated) {
      // Unconditional write, even when the pane already sits within the settle
      // tolerance: an immediate caller is aligning the layout and gets exactly
      // the offset it asked for.
      stopFrame()
      clearLeg()
      deps.writeScroll(destination)
      return
    }

    if (target === null) {
      // Fresh leg. Nothing to do when the pane is already there: a no-op write
      // would only fire a scroll event the caller has to ignore.
      const current = deps.readScroll()
      if (Math.abs(destination - current) < SPLIT_SCROLL_SETTLE_PX) return
      origin = current
      startedAt = null // the pending frame pins the clock
      quietFrom = current
    } else {
      // A leg is already running and its target moved. Re-anchor at the position
      // the pane actually holds: keeping the stale origin would swing the eased
      // value straight past a target that moved behind us. Restart the window
      // from the last frame seen, but only once this leg has a clock — re-basing
      // to "not started" on every event would make each frame of a scroll burst
      // pin a new base and never move at all.
      origin = deps.readScroll()
      if (startedAt !== null) startedAt = lastFrameAt
    }

    // Re-derived on every schedule, from the distance this leg now has to
    // cross: a re-target both re-anchors and re-times the leg.
    legMs = legDurationMs(destination - origin)
    target = destination
    if (frame === null) frame = deps.requestFrame(onFrame)
  }

  function cancel(): void {
    stopFrame()
    clearLeg()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancel()
  }

  return { schedule, cancel, dispose }
}
