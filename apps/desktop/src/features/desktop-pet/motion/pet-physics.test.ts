import { describe, expect, it } from 'vitest'
import {
  DT_SEC,
  DragTrace,
  PHYSICS_FRICTION,
  PHYSICS_MIN_SPEED,
  ROW_LEFT,
  ROW_RIGHT,
  SAMPLE_WINDOW_MS,
  TICK_MS,
  WIN_H,
  WIN_W,
  applyFall,
  applyThrow,
  type LogicalWindow,
  type PhysicsDeps,
  type Point,
  type Rect,
  type ThrowSession,
} from './pet-physics'

const bounds: Rect = { left: 0, top: 0, right: 1000, bottom: 800 }

interface Harness {
  deps: PhysicsDeps
  session: ThrowSession
  written: Point[]
  rows: number[]
  errors: unknown[]
  clears(): number
  steps(): number
  onStep(handler: (step: number) => void): void
  stop(): void
}

/** A window whose position the physics can drive, with every step observable. */
function harness(start: Point | null, failAt?: number): Harness {
  let current = start
  let writes = 0
  let clears = 0
  let steps = 0
  const written: Point[] = []
  const rows: number[] = []
  const errors: unknown[] = []
  const handlers: ((step: number) => void)[] = []
  let stopped = false

  const window: LogicalWindow = {
    async currentPosition(): Promise<Point | null> {
      return current
    },
    async moveTo(position: Point): Promise<void> {
      writes += 1
      if (failAt !== undefined && writes >= failAt) throw new Error('refused')
      written.push(position)
      current = position
    },
  }

  const deps: PhysicsDeps = {
    window,
    async sleep(): Promise<void> {
      steps += 1
      for (const handler of handlers) handler(steps)
    },
    frame: {
      setRow: (row: number) => void rows.push(row),
      clearRow: () => void (clears += 1),
    },
    onPlatformError: (error: unknown) => void errors.push(error),
    stopped: () => stopped,
  }

  return {
    deps,
    session: { running: false },
    written,
    rows,
    errors,
    clears: () => clears,
    steps: () => steps,
    onStep: (handler) => void handlers.push(handler),
    stop: () => void (stopped = true),
  }
}

describe('DragTrace', () => {
  it('has no velocity before there is a gesture', () => {
    const trace = new DragTrace()
    expect(trace.releaseVelocity()).toBeNull()
    trace.record({ x: 100, y: 100 }, 0)
    expect(trace.releaseVelocity()).toBeNull()
  })

  it('refuses two samples a millisecond apart', () => {
    const trace = new DragTrace()
    trace.record({ x: 100, y: 100 }, 0)
    trace.record({ x: 200, y: 100 }, 10)
    // 19000 px/s out of two adjacent frames is noise, not a throw (upstream `physics.ts:35`).
    expect(trace.releaseVelocity()).toBeNull()
  })

  it('reads the gesture as pixels per second', () => {
    const trace = new DragTrace()
    trace.record({ x: 100, y: 200 }, 0)
    trace.record({ x: 110, y: 190 }, 50)
    expect(trace.releaseVelocity()).toEqual({ vx: 200, vy: -200 })
  })

  it('keeps only the last 120 ms, so a slow carry is not averaged into the flick', () => {
    const trace = new DragTrace()
    trace.record({ x: 0, y: 0 }, 0)
    trace.record({ x: 100, y: 0 }, SAMPLE_WINDOW_MS + 1)
    // The first sample aged out, leaving one: there is no gesture to measure.
    expect(trace.releaseVelocity()).toBeNull()
    trace.record({ x: 110, y: 0 }, SAMPLE_WINDOW_MS + 51)
    expect(trace.releaseVelocity()).toEqual({ vx: 200, vy: 0 })
  })

  it('forgets everything when cleared', () => {
    const trace = new DragTrace()
    trace.record({ x: 0, y: 0 }, 0)
    trace.record({ x: 50, y: 0 }, 50)
    trace.clear()
    expect(trace.releaseVelocity()).toBeNull()
  })
})

describe('the physics constants', () => {
  it('derive dt from the tick, so the two cannot drift apart', () => {
    expect(DT_SEC).toBe(TICK_MS / 1000)
  })

  it('size the pet by the same constants the bounds use', () => {
    expect(WIN_W).toBeGreaterThan(0)
    expect(WIN_H).toBeGreaterThan(0)
  })
})

describe('applyThrow', () => {
  it('applies friction before moving, and ends on the speed floor', async () => {
    const h = harness({ x: 500, y: 400 })
    await applyThrow(h.deps, h.session, { vx: 600, vy: 0 }, bounds)

    // Upstream decayed first and moved second (`physics.ts:66-69`).
    expect(h.written[0].x).toBeCloseTo(500 + 600 * PHYSICS_FRICTION * DT_SEC, 6)
    expect(h.written[0].y).toBe(400)

    // Each step travels less than the one before it: that is the friction.
    const distances = h.written.map((point, index) => point.x - (index === 0 ? 500 : h.written[index - 1].x))
    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]).toBeLessThan(distances[index - 1])
    }
    expect(distances[distances.length - 1]).toBeLessThan(PHYSICS_MIN_SPEED * DT_SEC)

    // The pet is inside the work area, and the throw is over rather than left running.
    for (const point of h.written) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.left)
      expect(point.x).toBeLessThanOrEqual(bounds.right - WIN_W)
    }
    expect(h.session.running).toBe(false)
    expect(h.clears()).toBe(1)
  })

  it('faces the way it is moving, and turns around after a bounce', async () => {
    const wall: Rect = { left: 0, top: 0, right: 700, bottom: 800 }
    const h = harness({ x: 400, y: 400 })
    await applyThrow(h.deps, h.session, { vx: 1000, vy: 0 }, wall)

    expect(h.rows[0]).toBe(ROW_RIGHT)
    expect(h.rows).toContain(ROW_LEFT)
    // Stopped at the edge it hit (`physics.ts:123-128`) — and the row after the bounce is the
    // one it is now heading in, which is why the first row can be LEFT for a pet thrown into a
    // wall on its first step.
    expect(h.written.map((point) => point.x)).toContain(wall.right - WIN_W)
  })

  it('reflects off the top and bottom edges too', async () => {
    const shallow: Rect = { left: 0, top: 0, right: 1000, bottom: 400 }
    const h = harness({ x: 400, y: 60 })
    await applyThrow(h.deps, h.session, { vx: 0, vy: -2000 }, shallow)
    for (const point of h.written) {
      expect(point.y).toBeGreaterThanOrEqual(shallow.top)
      expect(point.y).toBeLessThanOrEqual(shallow.bottom - WIN_H)
    }
    expect(h.written.length).toBeGreaterThan(1)
  })

  it('stops where it is when the position cannot be read', async () => {
    const h = harness(null)
    await applyThrow(h.deps, h.session, { vx: 600, vy: 0 }, bounds)
    expect(h.written).toEqual([])
    expect(h.session.running).toBe(false)
    // Nothing moved, so nothing is overridden either.
    expect(h.clears()).toBe(0)
  })

  it('is interrupted by the session being cleared, at the step it happens', async () => {
    const h = harness({ x: 500, y: 400 })
    h.onStep((step) => {
      if (step === 3) h.session.running = false
    })
    await applyThrow(h.deps, h.session, { vx: 600, vy: 0 }, bounds)

    // The gesture that took over ends it: no further steps, and the pet is where it was.
    expect(h.written.length).toBe(3)
    expect(h.session.running).toBe(false)
    expect(h.clears()).toBe(1)
  })

  it('ends the throw when the engine stops', async () => {
    const h = harness({ x: 500, y: 400 })
    h.onStep(() => h.stop())
    await applyThrow(h.deps, h.session, { vx: 600, vy: 0 }, bounds)
    expect(h.written.length).toBe(1)
  })

  it('reports a refused move instead of retrying it every tick', async () => {
    const h = harness({ x: 500, y: 400 }, 2)
    await applyThrow(h.deps, h.session, { vx: 600, vy: 0 }, bounds)
    expect(h.errors).toHaveLength(1)
    expect(h.written).toHaveLength(1)
    expect(h.clears()).toBe(1)
  })

  it('leaves the pet alone when the velocity is below the floor', async () => {
    const h = harness({ x: 500, y: 400 })
    await applyThrow(h.deps, h.session, { vx: 10, vy: 0 }, bounds)
    expect(h.written).toEqual([])
    expect(h.clears()).toBe(1)
  })
})

describe('applyFall', () => {
  it('accelerates and lands on the work area floor', async () => {
    const h = harness({ x: 100, y: 100 })
    await applyFall(h.deps, h.session, 0, bounds, [])

    const drops = h.written.map(
      (point, index) => point.y - (index === 0 ? 100 : h.written[index - 1].y),
    )
    // Every step but the landing one falls further than the last: that is the gravity.
    // The landing step is shorter by construction — the pet stops at the floor, it does
    // not travel the whole distance the acceleration asked for.
    for (let index = 1; index < drops.length - 1; index += 1) {
      expect(drops[index]).toBeGreaterThan(drops[index - 1])
    }
    expect(drops[drops.length - 2]).toBeGreaterThan(0)
    expect(h.written[h.written.length - 1].y).toBe(bounds.bottom - WIN_H)
    expect(h.session.running).toBe(false)
    expect(h.clears()).toBe(1)
  })

  it('lands on a window top when one is under it', async () => {
    const surface: Rect = { left: 0, top: 600, right: 1000, bottom: 800 }
    const h = harness({ x: 100, y: 100 })
    await applyFall(h.deps, h.session, 0, bounds, [surface])
    expect(h.written[h.written.length - 1].y).toBe(surface.top - WIN_H)
  })

  it('ignores a surface above the work area', async () => {
    const offscreen: Rect = { left: 0, top: 300, right: 1000, bottom: 800 }
    const h = harness({ x: 100, y: 100 })
    // `top - WIN_H` is above the work area's own top, so the pet would be parked off the
    // screen: upstream kept the work area floor instead (`physics.ts:145`).
    await applyFall(h.deps, h.session, 0, bounds, [offscreen])
    expect(h.written[h.written.length - 1].y).toBe(bounds.bottom - WIN_H)
  })

  it('carries the release velocity sideways and clamps to the edges', async () => {
    const h = harness({ x: 400, y: 100 })
    await applyFall(h.deps, h.session, 2000, bounds, [])
    for (const point of h.written) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.left)
      expect(point.x).toBeLessThanOrEqual(bounds.right - WIN_W)
    }
    expect(h.written[h.written.length - 1].x).toBe(bounds.right - WIN_W)
  })

  it('stops falling when the session is cleared', async () => {
    const h = harness({ x: 100, y: 100 })
    h.onStep((step) => {
      if (step === 2) h.session.running = false
    })
    await applyFall(h.deps, h.session, 0, bounds, [])
    expect(h.written).toHaveLength(2)
  })

  it('stops where it is when the position cannot be read', async () => {
    const h = harness(null)
    await applyFall(h.deps, h.session, 0, bounds, [])
    expect(h.written).toEqual([])
    expect(h.session.running).toBe(false)
  })
})
