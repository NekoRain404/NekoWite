import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SPLIT_SCROLL_MAX_DURATION_MS,
  SPLIT_SCROLL_MIN_DURATION_MS,
  SPLIT_SCROLL_SETTLE_PX,
  createSplitScrollCoordinator,
  legDurationMs,
  type SplitScrollCoordinatorDeps,
} from './splitScrollCoordinator'

/** One display frame at 60Hz, the cadence the coordinator was tuned against. */
const FRAME_MS = 16

interface Harness {
  deps: SplitScrollCoordinatorDeps
  writes: number[]
  clamps: number[]
  requests(): number
  cancels(): number
  pending(): number
  position(): number
  /** Run whatever frame is pending at `time` ms, as the frame loop would. */
  frame(time: number): void
  /** Run frames every 16ms until the coordinator stops asking for more. */
  settle(time: number): number
  /** Frames a leg of this distance takes from a standing start, at 60Hz. */
  framesToSettle(distance: number): number
}

/**
 * A hand-cranked frame loop over a numeric scroll range. The test owns the
 * clock and the scroll position, so every timing assertion below is exact and
 * none of it needs a browser frame loop or wall-clock time.
 */
function makeHarness(max = 1000): Harness {
  const scheduled = new Map<number, (time: number) => void>()
  const writes: number[] = []
  const clamps: number[] = []
  let handles = 0
  let requests = 0
  let cancels = 0
  let scroll = 0

  const deps: SplitScrollCoordinatorDeps = {
    requestFrame(callback) {
      requests += 1
      handles += 1
      scheduled.set(handles, callback)
      return handles
    },
    cancelFrame(handle) {
      cancels += 1
      scheduled.delete(handle)
    },
    readScroll: () => scroll,
    writeScroll(value) {
      writes.push(value)
      scroll = value
    },
    clampScroll(value) {
      clamps.push(value)
      return Math.max(0, Math.min(value, max))
    },
  }

  const frame = (time: number): void => {
    const due = [...scheduled.values()]
    scheduled.clear()
    for (const callback of due) callback(time)
  }

  const settle = (time: number): number => {
    let at = time
    for (let guard = 0; scheduled.size > 0 && guard < 200; guard += 1) {
      frame(at)
      at += FRAME_MS
    }
    expect(scheduled.size, 'the coordinator never stopped asking for frames').toBe(0)
    return at
  }

  return {
    deps,
    writes,
    clamps,
    requests: () => requests,
    cancels: () => cancels,
    pending: () => scheduled.size,
    position: () => scroll,
    frame,
    settle,
    framesToSettle(distance: number): number {
      scroll = 0
      writes.length = 0
      const coordinator = createSplitScrollCoordinator(deps)
      coordinator.schedule(distance, true)
      let frames = 0
      while (scheduled.size > 0) {
        if (frames > 200) throw new Error('the leg never settled')
        frame(frames * FRAME_MS)
        frames += 1
      }
      return frames
    },
  }
}

describe('immediate assignment (animated = false)', () => {
  it('assigns in the same call and queues no frame', () => {
    // The path mode changes, divider-resize completion, outline jumps and
    // reduced motion take: it must be visible before the statement returns.
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(320, false)

    expect(h.writes).toEqual([320])
    expect(h.position()).toBe(320)
    expect(h.pending()).toBe(0)
    expect(h.requests()).toBe(0)
  })

  it('stops an in-flight animation instead of easing over the top of it', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(900, true)
    h.frame(0)
    h.frame(FRAME_MS)
    expect(h.position()).toBeGreaterThan(0)

    coordinator.schedule(0, false)
    expect(h.position()).toBe(0)
    expect(h.pending()).toBe(0)

    // The cancelled frame cannot run late and drag the pane back toward 900.
    const written = h.writes.length
    h.frame(2 * FRAME_MS)
    expect(h.writes.length).toBe(written)
  })
})

describe('coalescing', () => {
  it('queues exactly one frame for any number of schedules before it ticks', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(100, true)
    coordinator.schedule(200, true)
    coordinator.schedule(300, true)

    expect(h.pending()).toBe(1)
    expect(h.requests()).toBe(1)

    h.settle(0)
    expect(h.position()).toBe(300)
  })

  it('eases toward the last target, not the first', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(150, true)
    coordinator.schedule(400, true)
    coordinator.schedule(900, true)
    h.frame(0)
    h.frame(FRAME_MS)

    // One frame in, a leg aimed at the first of those targets cannot have
    // passed it, so a write beyond 150px can only come from the coalesced end
    // of the burst. A leg that had been cancelled and restarted per event, or
    // one that kept the first target, both land below it.
    expect(h.writes[0]).toBeGreaterThan(150)
    expect(h.writes[0]).toBeLessThan(900)

    h.settle(2 * FRAME_MS)
    expect(h.position()).toBe(900)
  })

  it('keeps one frame when a write lands straight back in schedule', () => {
    // A pane that reacts to a programmatic write synchronously (the feedback the
    // integration layer has to suppress) must not be able to put two frames in
    // the air from one tick.
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator({
      ...h.deps,
      writeScroll(value) {
        h.deps.writeScroll(value)
        coordinator.schedule(value + 100, true)
      },
    })

    coordinator.schedule(500, true)
    h.frame(0)
    h.frame(FRAME_MS)

    expect(h.pending()).toBe(1) // and not a second frame behind it
    h.settle(2 * FRAME_MS)
    expect(h.pending()).toBe(0)
    expect(h.position()).toBeGreaterThan(203)
  })

  it('keeps one frame and keeps converging through a continuous burst of re-targets', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    let target = 0
    let time = 0
    let frames = 0
    for (let event = 0; event < 20; event += 1) {
      target += 50
      coordinator.schedule(target, true)
      expect(h.pending()).toBeLessThanOrEqual(1)
      time += 8
      if (event % 2 === 1) {
        h.frame(time) // one display frame per two events
        frames += 1
      }
    }

    // It moved (a leg whose clock restarted on every event would have stalled
    // with no frame ever making progress) and never overshot the newest target.
    expect(h.writes.length).toBeGreaterThan(5)
    expect(h.position()).toBeGreaterThan(0)
    expect(h.position()).toBeLessThanOrEqual(target)
    // One frame per tick, no accumulation: one request per frame plus the
    // pending one.
    expect(h.requests()).toBe(frames + 1)

    h.settle(time)
    expect(h.position()).toBe(target)
    expect(h.pending()).toBe(0)
  })
})

describe('easing', () => {
  it('eases out — most of the distance is covered in the first half of the window', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(500, true)
    h.frame(0)
    h.frame(legDurationMs(500) / 2)

    expect(h.writes.length).toBe(1)
    // The curve is 96% of the way across by its halfway mark, which is what
    // makes the pane read as arriving rather than as being dragged.
    expect(h.writes[0]).toBeGreaterThan(480)
    expect(h.writes[0]).toBeLessThan(500)
  })

  it('lands on the exact target, then stops asking for frames', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(500, true)
    h.settle(0)

    expect(h.writes.at(-1)).toBe(500)
    expect(h.pending()).toBe(0)

    h.frame(10 * FRAME_MS)
    expect(h.writes.at(-1)).toBe(500)
  })

  it('snaps to the target when a frame arrives after the window closed', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(500, true)
    h.frame(0)
    h.frame(legDurationMs(500) + FRAME_MS)

    expect(h.position()).toBe(500)
    expect(h.pending()).toBe(0)
  })

  it('scales the window with the distance, so a nudge is not a page jump', () => {
    // The one property that separates a scaled ease from its single-duration
    // predecessor: a leg's frame count grows with the distance it covers. A
    // fixed window settles every distance in the same number of frames, which
    // is what makes a one-line nudge feel as heavy as a page.
    const h = makeHarness()
    const near = h.framesToSettle(50)
    const far = h.framesToSettle(500)
    const page = h.framesToSettle(1600)

    expect(near).toBeLessThan(far)
    expect(far).toBeLessThan(page)
    // And the far leg is genuinely longer than any fixed window could be.
    expect((page - 1) * FRAME_MS).toBeGreaterThan(200)
  })

  it('treats a target within the settle tolerance as already arrived', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)
    coordinator.schedule(100, false)

    coordinator.schedule(100 + SPLIT_SCROLL_SETTLE_PX / 2, true)
    expect(h.pending()).toBe(0)

    // Just past the tolerance is worth a frame.
    coordinator.schedule(100 + SPLIT_SCROLL_SETTLE_PX * 2, true)
    expect(h.pending()).toBe(1)
    h.settle(0)
    expect(h.position()).toBe(100 + SPLIT_SCROLL_SETTLE_PX * 2)
  })
})

describe('re-targeting mid-flight', () => {
  it('re-anchors the ease where the pane is, instead of jumping from a stale origin', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(900, true)
    h.frame(0)
    h.frame(FRAME_MS)
    const stale = h.position()
    expect(stale).toBeGreaterThan(0)

    // A new target behind the pane. Easing from the leg's stale origin (0)
    // would carry the value past the new target; it must instead approach 100
    // from above, from where the pane actually sits.
    coordinator.schedule(100, true)
    h.frame(2 * FRAME_MS)
    const next = h.position()
    expect(next).toBeGreaterThan(100)
    expect(next).toBeLessThan(stale)

    h.settle(3 * FRAME_MS)
    expect(h.position()).toBe(100)
  })

  it('restarts the window and continues forward when the target interrupts the leg', () => {
    // A wheel burst re-targets every few milliseconds. The pane must never step
    // backwards or stand still: the interrupted leg hands over from where the
    // pane is, moving on the new target, at the new distance's own duration.
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(700, true)
    h.frame(0)
    h.frame(FRAME_MS)
    h.frame(2 * FRAME_MS)
    const interrupted = h.position()

    coordinator.schedule(730, true)
    h.frame(3 * FRAME_MS)

    expect(h.position()).toBeGreaterThan(interrupted)
    expect(h.position()).toBeLessThan(730)
    h.settle(4 * FRAME_MS)
    expect(h.position()).toBe(730)
  })
})

describe('clamping', () => {
  it('clamps every target through the adapter before storing it', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(5000, false)
    expect(h.clamps).toEqual([5000])
    expect(h.writes).toEqual([1000]) // the harness range's end

    coordinator.schedule(-40, false)
    expect(h.clamps).toEqual([5000, -40])
    expect(h.writes).toEqual([1000, 0])
  })

  it('clamps an animated target the same way', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)
    coordinator.schedule(600, false)

    coordinator.schedule(4000, true)
    expect(h.clamps).toEqual([600, 4000])
    h.settle(0)
    expect(h.position()).toBe(1000)
  })

  it('ignores a non-numeric target rather than writing it', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(Number.NaN, false)
    coordinator.schedule(Number.NaN, true)

    expect(h.writes).toEqual([])
    expect(h.clamps).toEqual([])
    expect(h.requests()).toBe(0)
  })

  it('sends an infinite target through the adapter clamp', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(Number.POSITIVE_INFINITY, false)

    expect(h.clamps).toEqual([Number.POSITIVE_INFINITY])
    expect(h.writes).toEqual([1000])
  })
})

describe('cancel', () => {
  it('drops the pending frame and the target behind it', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(900, true)
    h.frame(0)
    h.frame(FRAME_MS)
    expect(h.pending()).toBe(1)

    coordinator.cancel()

    expect(h.pending()).toBe(0)
    expect(h.cancels()).toBe(1)
    const written = h.writes.length
    h.frame(2 * FRAME_MS)
    expect(h.writes.length).toBe(written)
  })

  it('is a no-op when nothing is pending', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.cancel()
    coordinator.cancel()

    expect(h.cancels()).toBe(0)
    expect(h.pending()).toBe(0)
    expect(h.writes).toEqual([])
  })

  it('starts the next animation from where the pane was left', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(600, false)
    coordinator.schedule(900, true)
    h.frame(0)
    h.frame(FRAME_MS)
    const abandoned = h.position()
    coordinator.cancel()

    coordinator.schedule(400, true)
    h.frame(2 * FRAME_MS)
    h.frame(3 * FRAME_MS)
    const leg = h.position()
    expect(leg).toBeGreaterThan(400)
    expect(leg).toBeLessThan(abandoned)

    h.settle(4 * FRAME_MS)
    expect(h.position()).toBe(400)
  })
})

describe('dispose', () => {
  it('cancels the pending frame and turns later schedules into no-ops', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(900, true)
    h.frame(0)
    h.frame(FRAME_MS)
    coordinator.dispose()

    expect(h.pending()).toBe(0)
    expect(h.cancels()).toBe(1)
    const quiet = { requests: h.requests(), writes: h.writes.length }
    h.frame(2 * FRAME_MS)
    expect(h.writes.length).toBe(quiet.writes)

    // An unmounted pane must not resurrect a frame or poke its adapter again.
    coordinator.schedule(500, true)
    coordinator.schedule(300, false)

    expect(h.requests()).toBe(quiet.requests)
    expect(h.cancels()).toBe(1)
    expect(h.clamps).toEqual([900])
    expect(h.writes.length).toBe(quiet.writes)
    expect(h.pending()).toBe(0)
  })

  it('is safe to call twice', () => {
    const h = makeHarness()
    const coordinator = createSplitScrollCoordinator(h.deps)

    coordinator.schedule(900, true)
    h.frame(0)
    coordinator.dispose()
    const cancels = h.cancels()

    expect(() => coordinator.dispose()).not.toThrow()

    expect(h.cancels()).toBe(cancels)
    expect(h.pending()).toBe(0)
  })
})

describe('framework independence', () => {
  it('reaches for no browser global and no wall clock', () => {
    const source = readFileSync(resolve(__dirname, './splitScrollCoordinator.ts'), 'utf8')
    // Comments may name the globals they explain; only real code must not.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    for (const global of [
      'window',
      'document',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'setTimeout',
      'globalThis',
    ]) {
      expect(code, `${global} must be injected, not reached for`).not.toMatch(
        new RegExp(`\\b${global}\\b`),
      )
    }
  })
})

describe('constants', () => {
  it('pins the arrival tolerance the loop actually lands on', () => {
    // Pinned, not bounded: a range assertion passes for any value below 1 and
    // says nothing about where the ease stops. This is the offset the loop
    // gives up at, and half a pixel of it is visible as a final creep.
    expect(SPLIT_SCROLL_SETTLE_PX).toBe(0.25)
  })

  it('spans the --app-motion to --app-motion-slow rungs of the token ladder', () => {
    // Pinned against the values in `styles/tokens.css`: a scroll sync that
    // drifts off the ladder eases on a different beat from every dialog.
    expect(SPLIT_SCROLL_MIN_DURATION_MS).toBe(180)
    expect(SPLIT_SCROLL_MAX_DURATION_MS).toBe(260)

    // Both ends are real: the shortest leg is exactly the floor, and the
    // ceiling is an asymptote the curve approaches without a hard knee.
    expect(legDurationMs(0)).toBe(SPLIT_SCROLL_MIN_DURATION_MS)
    expect(legDurationMs(50)).toBeGreaterThan(SPLIT_SCROLL_MIN_DURATION_MS)
    expect(legDurationMs(50)).toBeLessThan(200)
    // A wheel notch stays near the floor; a page jump is most of the way up.
    // 120px is 31% of the 80ms span, 700px is 61%.
    expect(legDurationMs(120)).toBeLessThan(205)
    expect(legDurationMs(120)).toBeGreaterThan(SPLIT_SCROLL_MIN_DURATION_MS)
    expect(legDurationMs(700)).toBeGreaterThan(228)
    expect(legDurationMs(500)).toBeLessThan(SPLIT_SCROLL_MAX_DURATION_MS)
    expect(legDurationMs(1_000_000)).toBeLessThanOrEqual(SPLIT_SCROLL_MAX_DURATION_MS)

    // Monotone in distance, so a longer travel can never finish sooner.
    let previous = legDurationMs(0)
    for (const distance of [10, 40, 120, 300, 700, 1500, 4000]) {
      const next = legDurationMs(distance)
      expect(next).toBeGreaterThanOrEqual(previous)
      previous = next
    }

    // A negative distance is a re-target behind the pane, which is as long a
    // travel as its mirror image.
    expect(legDurationMs(-400)).toBe(legDurationMs(400))
  })
})
