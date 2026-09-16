/**
 * What a press on the floating ball means, and what the answer asks the desktop for.
 *
 * Ported from `references/desktop-pet/windows/src/floating-ball.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *
 *   - `:197-206` the press: only the primary button, a remembered origin, and a clock reading
 *   - `:208-224` the move that turns a press into a drag once the cursor passes
 *     `DRAG_THRESHOLD_PX` (`:17`), which then asks the compositor to drag the window
 *   - `:226-238` the release that decides: a cursor that moved further than that threshold, or
 *     a press that lasted longer than `CLICK_MAX_MS` (`:18`), is not a click
 *
 * Two things upstream established and this port keeps:
 *
 *   - The decision is made by hand, and the reason is in upstream's own comment (`:192-195`):
 *     `data-tauri-drag-region` "can be flaky on small Windows webviews and makes click
 *     detection unreliable", so the ball measures the movement itself and asks for the drag
 *     once the cursor has moved far enough. A click that is really a drag flashes the menu open
 *     under the user's hand, which is the failure this arithmetic exists to prevent.
 *   - The cursor is read in **screen** coordinates (`:202-203`, `:233-234`), not window
 *     coordinates. During a drag the window moves under the cursor, so window-relative deltas
 *     cancel themselves out and the ball would decide every long drag was a click.
 *
 * What the port changed, and why:
 *   - Time is a field of the point ({@link BallPointer.at}) instead of a `performance.now()` read
 *     (`:204`, `:236`), so the click window is testable without waiting 280 ms (§10.2).
 *   - The window is a parameter ({@link PetBallPlatform}) instead of an import of
 *     `@tauri-apps/api` (`:5-7`), which is §3's adaptation and what lets a machine that cannot
 *     drag say so rather than be routed around (§7.2).
 *   - The gesture is an object rather than five module-level variables (`:30-35`). Upstream had
 *     one ball per webview so module scope *was* that ball; §7.1 allows several characters, and
 *     two balls sharing one press would drag each other.
 */

/** How far the cursor may move and still count as a click. Upstream `floating-ball.ts:17`. */
export const DRAG_THRESHOLD_PX = 4

/** How long a press may last and still count as a click. Upstream `floating-ball.ts:18`. */
export const CLICK_MAX_MS = 280

/** A cursor reading: where (on the screen), and when. */
export interface BallPointer {
  /** Screen x, not window-relative — see this file's header on why that matters. */
  screenX: number
  /** Screen y. */
  screenY: number
  /** The clock, injected (§10.2). Milliseconds; only differences are read. */
  at: number
}

/** What one event meant. */
export type BallGestureOutcome =
  /** A press began and nothing has been decided yet. */
  | 'pressed'
  /** The cursor moved far enough: begin the drag (once). */
  | 'drag-start'
  /** Released where it started, inside the click window. */
  | 'click'
  /** Released after a drag, too late, or without a press this gesture knows about. */
  | 'no-click'
  /** A movement that decided nothing. */
  | 'none'

export interface BallGesture {
  down(pointer: BallPointer): BallGestureOutcome
  move(pointer: BallPointer): BallGestureOutcome
  up(pointer: BallPointer): BallGestureOutcome
  /**
   * Forget the press without deciding anything.
   *
   * A pointer the desktop took away fires `pointercancel` rather than a release — which is
   * exactly what happens once the compositor owns the drag — and a forgotten press must not
   * leave a stale origin for the next one to be measured against.
   */
  cancel(): void
  /** Whether a press is in progress. The ball draws its pressed state from this. */
  pressed(): boolean
}

/** Whether the cursor has moved further than the click threshold allows. Upstream `:212`, `:235`. */
function beyondThreshold(pointer: BallPointer, press: BallPointer): boolean {
  return (
    Math.abs(pointer.screenX - press.screenX) > DRAG_THRESHOLD_PX ||
    Math.abs(pointer.screenY - press.screenY) > DRAG_THRESHOLD_PX
  )
}

export function createBallGesture(): BallGesture {
  let press: BallPointer | null = null
  let dragging = false

  return {
    down(pointer: BallPointer): BallGestureOutcome {
      // A second press without a release is not a gesture: taking it would re-origin a cursor
      // that is already being measured, which is how a drag turns back into a click.
      if (press !== null) return 'none'
      press = pointer
      dragging = false
      return 'pressed'
    },

    move(pointer: BallPointer): BallGestureOutcome {
      if (press === null || dragging) return 'none'
      if (!beyondThreshold(pointer, press)) return 'none'
      dragging = true
      return 'drag-start'
    },

    up(pointer: BallPointer): BallGestureOutcome {
      const started = press
      press = null
      if (started === null) return 'no-click'
      // The movement is re-measured here rather than relied on from `move`, because a fast
      // cursor can release past the threshold with no move event having arrived in time
      // (upstream `:230-235`).
      if (beyondThreshold(pointer, started)) return 'no-click'
      if (pointer.at - started.at > CLICK_MAX_MS) return 'no-click'
      return 'click'
    },

    cancel(): void {
      press = null
      dragging = false
    },

    pressed(): boolean {
      return press !== null
    },
  }
}

/**
 * The desktop, as the ball's gestures need it.
 *
 * Two methods, both a continuation of a gesture, and both optional: a desktop that cannot do
 * one of them does not implement it, which is a stronger statement than a method that returns
 * nothing (§7.2's 「不伪装已支持」).
 */
export interface PetBallPlatform {
  /**
   * Begin an operating-system drag of the ball's window, resolving when that drag ends.
   *
   * Upstream called `getCurrentWindow().startDragging()` and snapped in its `finally`
   * (`:219-223`). The compositor does the moving, so §7.3's ban on per-frame IPC is satisfied by
   * construction rather than by discipline. Absent → the ball cannot be moved, and its hint says
   * so; a fallback that moved the window per pointer event would be the per-frame IPC that rule
   * forbids, and §7.2's position-reset affordance belongs to the host that owns the position.
   */
  startDrag?(): Promise<void>
  /** Park the ball against an edge once the drag is over. Upstream's `snap_floating_ball` (`:222`). */
  snap?(): Promise<void>
}
