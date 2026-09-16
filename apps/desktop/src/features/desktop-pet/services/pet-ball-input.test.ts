/**
 * The ball's press arithmetic: what counts as a click, what counts as a drag, and the two
 * boundaries between them.
 *
 * Both boundaries are worth a test rather than a demo. A threshold that is off by one pixel
 * turns every deliberate drag into a menu flashing open under the user's hand, and a click
 * window that is off by one millisecond turns a considered click into nothing happening — and
 * neither is visible in a screenshot of a working ball.
 */
import { describe, expect, it } from 'vitest'
import {
  CLICK_MAX_MS,
  DRAG_THRESHOLD_PX,
  createBallGesture,
  type BallPointer,
} from './pet-ball-input'

function at(screenX: number, screenY: number, at: number): BallPointer {
  return { screenX, screenY, at }
}

/** A press at the origin, so each test states only the movement and the timing it is about. */
const PRESS = at(1000, 600, 0)

describe('a press on the ball', () => {
  it('is a click when it is released where it started, in time', () => {
    const gesture = createBallGesture()

    expect(gesture.down(PRESS)).toBe('pressed')
    expect(gesture.pressed()).toBe(true)
    expect(gesture.up(at(1000, 600, 120))).toBe('click')
    expect(gesture.pressed()).toBe(false)
  })

  it('is a drag once the cursor passes the threshold, and is not also a click', () => {
    const gesture = createBallGesture()
    gesture.down(PRESS)

    expect(gesture.move(at(1000 + DRAG_THRESHOLD_PX + 1, 600, 40))).toBe('drag-start')
    // Announced once: the drag is the platform's from here, and a second request would fight it.
    expect(gesture.move(at(1200, 700, 60))).toBe('none')
    expect(gesture.up(at(1000 + DRAG_THRESHOLD_PX + 1, 600, 80))).toBe('no-click')
  })

  it('keeps the threshold itself a click, the way upstream compared it', () => {
    // Upstream continued the press while `dx <= 4 && dy <= 4` (`floating-ball.ts:212`) and
    // rejected the click only past it (`:235`), so 4 px is still a click on both sides.
    const gesture = createBallGesture()
    gesture.down(PRESS)

    expect(gesture.move(at(1000 + DRAG_THRESHOLD_PX, 600 + DRAG_THRESHOLD_PX, 30))).toBe('none')
    expect(gesture.up(at(1000 + DRAG_THRESHOLD_PX, 600 + DRAG_THRESHOLD_PX, 60))).toBe('click')
  })

  it('is not a click when the cursor got there without a move event in time', () => {
    // The release is re-measured, so a fast cursor cannot slip a click through by outrunning the
    // move handler — upstream `:230-235`, kept because it is the case a test can produce and a
    // hand produces often.
    const gesture = createBallGesture()
    gesture.down(PRESS)

    expect(gesture.up(at(1000, 700, 90))).toBe('no-click')
  })

  it('is not a click when it is held past the click window', () => {
    const gesture = createBallGesture()
    gesture.down(PRESS)

    expect(gesture.up(at(1000, 600, CLICK_MAX_MS))).toBe('click')
    expect(gesture.down(PRESS)).toBe('pressed')
    expect(gesture.up(at(1000, 600, CLICK_MAX_MS + 1))).toBe('no-click')
  })

  it('ignores a release, a move or a second press it did not start', () => {
    const gesture = createBallGesture()

    expect(gesture.up(at(1000, 600, 20))).toBe('no-click')
    expect(gesture.move(at(1200, 600, 25))).toBe('none')
    expect(gesture.down(PRESS)).toBe('pressed')
    // The first press is still being measured: re-origining it here would let a drag become a
    // click halfway through.
    expect(gesture.down(at(1400, 800, 30))).toBe('none')
    expect(gesture.up(at(1000, 600, 40))).toBe('click')
  })

  it('forgets a press the desktop took away, and measures the next one from its own origin', () => {
    const gesture = createBallGesture()
    gesture.down(PRESS)
    gesture.move(at(1200, 700, 30))

    // `pointercancel` is what arrives once the compositor owns the drag.
    gesture.cancel()
    expect(gesture.pressed()).toBe(false)
    expect(gesture.up(at(1200, 700, 40))).toBe('no-click')

    expect(gesture.down(at(500, 500, 50))).toBe('pressed')
    expect(gesture.up(at(500, 500, 60))).toBe('click')
  })

  it('measures a drag in screen coordinates, so a window moving underneath does not cancel it', () => {
    // The point of screen coordinates: the window follows the cursor, so a window-relative
    // reading would be the same number on every event and the drag would read as a click.
    const gesture = createBallGesture()
    gesture.down(at(1000, 600, 0))
    expect(gesture.move(at(1010, 600, 30))).toBe('drag-start')
    expect(gesture.up(at(1010, 600, 60))).toBe('no-click')
  })
})
