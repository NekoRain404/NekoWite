import { describe, expect, it } from 'vitest'
import { IDLE_MS_MAX, IDLE_MS_MIN, MARGIN, clampToBounds, pxPerSec } from './pet-motion-types'
import { createRoamModeState, runMode, type ModeContext } from './pet-modes'
import { DT_SEC, ROW_LEFT, ROW_RIGHT, WIN_H, WIN_W, type PetMotionFrame, type Rect } from './pet-physics'

const workArea: Rect = { left: 0, top: 0, right: 1000, bottom: 800 }
/** A display left of the primary one: the origin of the work area is negative. */
const leftMonitor: Rect = { left: -1920, top: 0, right: 0, bottom: 1080 }

function frame(): { sink: PetMotionFrame; rows: number[]; clears(): number } {
  const rows: number[] = []
  let clears = 0
  return {
    sink: {
      setRow: (row: number) => void rows.push(row),
      clearRow: () => void (clears += 1),
    },
    rows,
    clears: () => clears,
  }
}

function context(overrides: Partial<ModeContext> = {}): ModeContext {
  return {
    env: { workArea, surfaces: [] },
    pos: { x: 500, y: 400 },
    frame: null,
    speed: 5,
    random: () => 0,
    now: () => 0,
    pointer: async () => null,
    ...overrides,
  }
}

/** One tick's step, as a distance along a direction — the shape every assertion here uses. */
function stepOf(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

describe('pxPerSec', () => {
  it('maps the stored speed onto the rate upstream used', () => {
    expect(pxPerSec(1)).toBe(85)
    expect(pxPerSec(5)).toBe(265)
    expect(pxPerSec(10)).toBe(490)
  })
})

describe('clampToBounds', () => {
  it('leaves a position inside the work area alone', () => {
    expect(clampToBounds({ x: 100, y: 100 }, workArea)).toEqual({ x: 100, y: 100 })
  })

  it('keeps the whole window on screen, not just its corner', () => {
    expect(clampToBounds({ x: 9999, y: 9999 }, workArea)).toEqual({
      x: workArea.right - WIN_W,
      y: workArea.bottom - WIN_H,
    })
  })

  it('works with the negative origin of a monitor left of the primary one', () => {
    expect(clampToBounds({ x: -5000, y: -900 }, leftMonitor)).toEqual({
      x: leftMonitor.left,
      y: leftMonitor.top,
    })
    expect(clampToBounds({ x: 500, y: 20 }, leftMonitor).x).toBe(leftMonitor.right - WIN_W)
  })
})

describe('runMode — stay', () => {
  it('does not move the pet', async () => {
    const state = createRoamModeState()
    expect(await runMode('stay', context(), state)).toEqual({ x: 500, y: 400 })
    expect(state.target).toBeNull()
  })
})

describe('runMode — wander', () => {
  it('walks toward a target at the configured speed, facing the way it goes', async () => {
    const f = frame()
    const ctx = context({ frame: f.sink })
    const next = await runMode('wander', ctx, createRoamModeState())

    // With `random()` at 0 the destination is the top-left corner the margin allows.
    expect(stepOf(ctx.pos, next)).toBeCloseTo(pxPerSec(5) * DT_SEC, 6)
    expect(next.x).toBeLessThan(ctx.pos.x)
    expect(next.y).toBeLessThan(ctx.pos.y)
    expect(f.rows).toEqual([ROW_LEFT])
  })

  it('keeps its destination across ticks, so it walks instead of jittering', async () => {
    const state = createRoamModeState()
    const ctx = context()
    await runMode('wander', ctx, state)
    const chosen = state.target
    expect(chosen).not.toBeNull()
    const second = await runMode('wander', { ...ctx, pos: { x: 490, y: 390 } }, state)
    // The same destination, approached from the new position — not a fresh random one.
    expect(state.target).toBe(chosen)
    expect(second.x).toBeLessThan(490)
  })

  it('rests when it arrives, for a while drawn from the configured range', async () => {
    const f = frame()
    const state = createRoamModeState()
    state.target = { x: 40, y: 40 }
    const ctx = context({ pos: { x: 44, y: 42 }, frame: f.sink, now: () => 10_000 })

    expect(await runMode('wander', ctx, state)).toEqual({ x: 44, y: 42 })
    expect(state.target).toBeNull()
    expect(state.restUntil).toBeGreaterThanOrEqual(10_000 + IDLE_MS_MIN)
    expect(state.restUntil).toBeLessThanOrEqual(10_000 + IDLE_MS_MAX)
    expect(f.clears()).toBe(1)
  })

  it('stands still while resting, and starts again when the rest is over', async () => {
    const state = createRoamModeState()
    state.restUntil = 1000
    const resting = context({ now: () => 999 })
    expect(await runMode('wander', resting, state)).toEqual(resting.pos)
    expect(state.target).toBeNull()

    const awake = context({ now: () => 1000 })
    const next = await runMode('wander', awake, state)
    expect(state.target).not.toBeNull()
    expect(next).not.toEqual(awake.pos)
  })

  it('picks a new destination when the old one is off the work area', async () => {
    const state = createRoamModeState()
    // A monitor was unplugged and the pet's old destination is on it.
    state.target = { x: 5000, y: 5000 }
    await runMode('wander', context(), state)
    expect(state.target).not.toEqual({ x: 5000, y: 5000 })
    expect(state.target!.x).toBeLessThanOrEqual(workArea.right - WIN_W)
  })
})

describe('runMode — follow-pointer', () => {
  it('aims under the pointer rather than on it', async () => {
    const f = frame()
    const ctx = context({
      frame: f.sink,
      pos: { x: 500, y: 400 },
      pointer: async () => ({ x: 500, y: 500 }),
    })
    const next = await runMode('follow-pointer', ctx, createRoamModeState())

    // Upstream aimed the pet's top-left at `cursor - WIN/2, cursor - WIN_H + 20`.
    const target = { x: 500 - WIN_W / 2, y: 500 - WIN_H + 20 }
    expect(stepOf(ctx.pos, next)).toBeCloseTo(pxPerSec(5) * DT_SEC, 6)
    expect(Math.sign(next.x - ctx.pos.x)).toBe(Math.sign(target.x - ctx.pos.x))
    expect(Math.sign(next.y - ctx.pos.y)).toBe(Math.sign(target.y - ctx.pos.y))
    expect(f.rows).toEqual([ROW_LEFT])
  })

  it('stops next to the pointer, so the cursor is never covered', async () => {
    const f = frame()
    const ctx = context({
      frame: f.sink,
      pos: { x: 500, y: 400 },
      pointer: async () => ({ x: 500 + WIN_W / 2, y: 400 + WIN_H - 20 }),
    })
    expect(await runMode('follow-pointer', ctx, createRoamModeState())).toEqual(ctx.pos)
    expect(f.clears()).toBe(1)
  })

  it('stands still while the pointer cannot be read', async () => {
    const f = frame()
    const ctx = context({ frame: f.sink, pointer: async () => null })
    expect(await runMode('follow-pointer', ctx, createRoamModeState())).toEqual(ctx.pos)
    expect(f.rows).toEqual([])
    expect(f.clears()).toBe(0)
  })

  it('stays inside the work area when the pointer is off it', async () => {
    const ctx = context({ pos: { x: 700, y: 400 }, pointer: async () => ({ x: 5000, y: 500 }) })
    const next = await runMode('follow-pointer', ctx, createRoamModeState())
    expect(next.x).toBeLessThanOrEqual(workArea.right - WIN_W)
    expect(next.x).toBeGreaterThan(ctx.pos.x)
  })
})

describe('runMode — climb', () => {
  const surface: Rect = { left: 100, top: 400, right: 700, bottom: 700 }

  it('walks along the top edge of the surface under it', async () => {
    const f = frame()
    const ctx = context({
      env: { workArea, surfaces: [surface] },
      pos: { x: 200, y: surface.top - WIN_H },
      frame: f.sink,
    })
    const next = await runMode('climb', ctx, createRoamModeState())

    expect(next.y).toBe(surface.top - WIN_H)
    expect(next.x - ctx.pos.x).toBeCloseTo(pxPerSec(5) * DT_SEC, 6)
    expect(f.rows).toEqual([ROW_RIGHT])
  })

  it('rests at the edge of a surface it would walk off', async () => {
    const f = frame()
    const narrow: Rect = { left: 100, top: 400, right: 200, bottom: 700 }
    const state = createRoamModeState()
    const ctx = context({
      env: { workArea, surfaces: [narrow] },
      pos: { x: 40, y: narrow.top - WIN_H },
      frame: f.sink,
      now: () => 5000,
    })
    expect(await runMode('climb', ctx, state)).toEqual(ctx.pos)
    expect(state.restUntil).toBeGreaterThanOrEqual(5000 + IDLE_MS_MIN)
    expect(f.clears()).toBe(1)
  })

  it('walks on the work area when the surface is above the pet, not below it', async () => {
    // A surface only counts when its top edge is below the pet's own bottom
    // (`surface.top >= pos.y + WIN_H`, `modes.ts:159`); otherwise the pet stands on the work
    // area, whose top edge is the top of the screen.
    const ctx = context({ env: { workArea, surfaces: [surface] }, pos: { x: 200, y: 200 } })
    const next = await runMode('climb', ctx, createRoamModeState())
    expect(next.y).toBe(workArea.top)
  })

  it('ignores a surface the pet is not over', async () => {
    const ctx = context({
      env: { workArea, surfaces: [surface] },
      pos: { x: 800, y: surface.top - WIN_H },
    })
    // The pet's centre is off to the right of it, so it is not the surface being walked on.
    const next = await runMode('climb', ctx, createRoamModeState())
    expect(next.y).toBe(workArea.top)
  })

  it('stands still when this desktop has no windows to climb', async () => {
    // Upstream called `wander` here and its own guard turned that into standing still anyway
    // (`modes.ts:105` against `:80`); §7.2 prefers staying to imitating another mode.
    const ctx = context({ env: { workArea, surfaces: [] }, pos: { x: 500, y: 400 } })
    expect(await runMode('climb', ctx, createRoamModeState())).toEqual(ctx.pos)
  })

  it('uses the margin as the nearest a wander destination may come to an edge', async () => {
    const state = createRoamModeState()
    await runMode('wander', context({ env: { workArea, surfaces: [] } }), state)
    expect(state.target).toEqual({ x: workArea.left + MARGIN, y: workArea.top + MARGIN })
  })
})
