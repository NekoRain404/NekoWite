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
 * Timing: a 100ms ease-out, deliberately NOT the 150ms `--app-ease` design
 * token used for UI transitions in `styles/tokens.css`. Scroll sync has to read
 * as "already there" the moment the wheel stops, and the token's 150ms reads as
 * lag on a scroll position; scroll therefore keeps its own, shorter window.
 * Do not "fix" this by pointing it at the token.
 */

/**
 * Length of one easing leg, in ms. Short enough that the panes look locked
 * together, long enough that a jump between anchor positions reads as motion
 * rather than a teleport.
 */
export const SPLIT_SCROLL_DURATION_MS = 100

/**
 * Distances below this many pixels count as arrived: the loop writes the exact
 * target and stops instead of creeping the last fraction of a pixel frame by
 * frame. Matches the subpixel tolerance the pre-existing sync code already used
 * (`editorScrollSync.ts`, `SourcePane.vue`).
 */
export const SPLIT_SCROLL_SETTLE_PX = 0.5

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

/** Cubic ease-out: quick off the mark, gentle into the target. */
function easeOut(progress: number): number {
  const remaining = 1 - progress
  return 1 - remaining * remaining * remaining
}

export function createSplitScrollCoordinator(
  deps: SplitScrollCoordinatorDeps,
): SplitScrollCoordinator {
  let frame: number | null = null // at most one pending frame, ever
  let target: number | null = null // destination of the leg in flight
  let origin = 0 // where that leg started from
  let startedAt: number | null = null // the leg's clock base: its first frame's stamp
  let lastFrameAt: number | null = null // newest stamp seen, for re-anchoring mid-leg
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
    const progress = Math.max(0, Math.min((time - startedAt) / SPLIT_SCROLL_DURATION_MS, 1))
    const value = origin + (destination - origin) * easeOut(progress)

    if (Math.abs(destination - value) < SPLIT_SCROLL_SETTLE_PX) {
      // Close enough: land exactly and let the loop die here rather than
      // spending more frames on subpixel movement.
      clearLeg()
      deps.writeScroll(destination)
      return
    }

    // Re-arm before writing: a write that lands back in `schedule` synchronously
    // (a pane reacting to a programmatic write) has to find the next frame
    // already pending, or it would queue a second one behind this one.
    frame = deps.requestFrame(onFrame)
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
