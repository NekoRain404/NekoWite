import { describe, expect, it, vi } from 'vitest'
import {
  ENVIRONMENT_CACHE_MS,
  MIN_SURFACE_PX,
  createEnvironmentReader,
  logicalWindow,
  rectToLogical,
  scaleFactorOf,
  toLogical,
  toPhysical,
  type PetMotionPlatform,
  type PhysicalRect,
} from './pet-platform'

const workArea: PhysicalRect = { x: 0, y: 0, width: 1920, height: 1080 }

function platform(overrides: Partial<PetMotionPlatform> = {}): PetMotionPlatform {
  return {
    async scaleFactor() {
      return 1
    },
    async readWindowPosition() {
      return { x: 0, y: 0 }
    },
    async moveWindow() {},
    async readWorkArea() {
      return workArea
    },
    ...overrides,
  }
}

describe('coordinate scaling', () => {
  it('round-trips a position at every scale factor a display may report', () => {
    for (const scaleFactor of [1, 1.25, 1.5, 2]) {
      const logical = 320.5
      expect(toLogical(toPhysical(logical, scaleFactor), scaleFactor)).toBeCloseTo(logical, 10)
    }
  })

  it('round-trips a negative position, which is a monitor left of the primary one', () => {
    for (const scaleFactor of [1, 1.25, 1.5, 2]) {
      const logical = -960
      expect(toLogical(toPhysical(logical, scaleFactor), scaleFactor)).toBeCloseTo(logical, 10)
    }
  })

  it('keeps a position that is right at 1× right at 1.5× and 2×', () => {
    expect(toPhysical(300, 1)).toBe(300)
    expect(toPhysical(300, 1.5)).toBe(450)
    expect(toPhysical(300, 2)).toBe(600)
    expect(toLogical(600, 2)).toBe(300)
  })

  it('treats an unusable scale factor as 1:1 rather than dividing by it', () => {
    expect(scaleFactorOf(0)).toBe(1)
    expect(scaleFactorOf(Number.NaN)).toBe(1)
    expect(scaleFactorOf(Number.POSITIVE_INFINITY)).toBe(1)
    expect(scaleFactorOf(-2)).toBe(1)
    expect(scaleFactorOf(1.25)).toBe(1.25)
  })

  it('converts a work area that starts left of the origin', () => {
    const left: PhysicalRect = { x: -2880, y: 0, width: 2880, height: 1620 }
    expect(rectToLogical(left, 1.5)).toEqual({ left: -1920, top: 0, right: 0, bottom: 1080 })
  })
})

describe('logicalWindow', () => {
  it('reads where the window is, in logical pixels', async () => {
    const window = logicalWindow(
      platform({
        async scaleFactor() {
          return 2
        },
        async readWindowPosition() {
          return { x: -1920, y: 100 }
        },
      }),
    )
    expect(await window.currentPosition()).toEqual({ x: -960, y: 50 })
  })

  it('resolves null when the desktop will not say where the window is', async () => {
    const unreadable = logicalWindow(
      platform({
        async readWindowPosition() {
          return null
        },
      }),
    )
    expect(await unreadable.currentPosition()).toBeNull()

    const failing = logicalWindow(
      platform({
        async scaleFactor() {
          throw new Error('no window')
        },
      }),
    )
    expect(await failing.currentPosition()).toBeNull()
  })

  it('writes a position back in physical pixels', async () => {
    const moveWindow = vi.fn(async () => {})
    const window = logicalWindow(
      platform({
        async scaleFactor() {
          return 1.25
        },
        moveWindow,
      }),
    )
    await window.moveTo({ x: -960, y: 40 })
    expect(moveWindow).toHaveBeenCalledWith({ x: -1200, y: 50 })
  })

  it('reads back the position it wrote, at 2×', async () => {
    let stored = { x: 0, y: 0 }
    const window = logicalWindow(
      platform({
        async scaleFactor() {
          return 2
        },
        async readWindowPosition() {
          return stored
        },
        async moveWindow(position) {
          stored = position
        },
      }),
    )
    await window.moveTo({ x: -440.25, y: 12.5 })
    expect(await window.currentPosition()).toEqual({ x: -440.25, y: 12.5 })
  })
})

describe('createEnvironmentReader', () => {
  const surface = (x: number, y: number, width: number, height: number): PhysicalRect => ({
    x,
    y,
    width,
    height,
  })

  it('returns the work area and the surfaces in logical pixels', async () => {
    const reader = createEnvironmentReader(
      platform({
        async scaleFactor() {
          return 2
        },
        async readWorkArea() {
          return { x: 0, y: 0, width: 3840, height: 2160 }
        },
        async readWindowRects() {
          return [surface(200, 400, 1200, 800)]
        },
      }),
      () => 0,
    )
    expect(await reader.read()).toEqual({
      workArea: { left: 0, top: 0, right: 1920, bottom: 1080 },
      surfaces: [{ left: 100, top: 200, right: 700, bottom: 600 }],
    })
  })

  it('drops slivers, in physical pixels as upstream measured them', async () => {
    const reader = createEnvironmentReader(
      platform({
        async readWindowRects() {
          return [surface(0, 0, MIN_SURFACE_PX, 600), surface(0, 0, MIN_SURFACE_PX + 1, 600)]
        },
      }),
      () => 0,
    )
    const env = await reader.read()
    expect(env?.surfaces).toHaveLength(1)
    expect(env?.surfaces[0].right).toBe(MIN_SURFACE_PX + 1)
  })

  it('reuses a read for half a second and refetches after it', async () => {
    const readWorkArea = vi.fn(async () => workArea)
    let now = 0
    const reader = createEnvironmentReader(platform({ readWorkArea }), () => now)

    await reader.read()
    now = ENVIRONMENT_CACHE_MS - 1
    await reader.read()
    expect(readWorkArea).toHaveBeenCalledTimes(1)

    now = ENVIRONMENT_CACHE_MS
    await reader.read()
    expect(readWorkArea).toHaveBeenCalledTimes(2)
  })

  it('refetches the surfaces when the monitor changes', async () => {
    const readWindowRects = vi.fn(async () => [surface(0, 0, 400, 400)])
    let scaleFactor = 1
    let now = 0
    const reader = createEnvironmentReader(
      platform({
        async scaleFactor() {
          return scaleFactor
        },
        readWindowRects,
      }),
      () => now,
    )

    expect((await reader.read())?.surfaces[0].right).toBe(400)
    // The monitor read expires and reports a different display: the window list is keyed by
    // the scale factor upstream (`environment.ts:56`), so it is refetched rather than
    // reinterpreted.
    now = ENVIRONMENT_CACHE_MS
    scaleFactor = 2
    expect((await reader.read())?.surfaces[0].right).toBe(200)
    expect(readWindowRects).toHaveBeenCalledTimes(2)
  })

  it('forgets everything when invalidated, which a hot-plug needs', async () => {
    const readWorkArea = vi.fn(async () => workArea)
    const reader = createEnvironmentReader(platform({ readWorkArea }), () => 0)
    await reader.read()
    reader.invalidate()
    await reader.read()
    expect(readWorkArea).toHaveBeenCalledTimes(2)
  })

  it('keeps the last window list when enumeration fails', async () => {
    let fail = false
    const reader = createEnvironmentReader(
      platform({
        async readWindowRects() {
          if (fail) throw new Error('x11 connection lost')
          return [surface(0, 0, 400, 400)]
        },
      }),
      () => 0,
    )
    expect((await reader.read())?.surfaces).toHaveLength(1)
    fail = true
    // An empty list would say "this desktop has no windows", which is a different claim from
    // "the enumeration failed" (upstream `environment.ts:72-73`).
    expect((await reader.read())?.surfaces).toHaveLength(1)
  })

  it('has no surfaces when the desktop cannot enumerate at all', async () => {
    const reader = createEnvironmentReader(platform(), () => 0)
    expect((await reader.read())?.surfaces).toEqual([])
  })

  it('refuses to place a pet when the work area cannot be read', async () => {
    const reader = createEnvironmentReader(
      platform({
        async readWorkArea() {
          return null
        },
      }),
      () => 0,
    )
    // Upstream returned null here rather than substituting a screen size (`lib.rs:194`).
    expect(await reader.read()).toBeNull()
  })

  it('reports nothing when the monitor query itself fails', async () => {
    const reader = createEnvironmentReader(
      platform({
        async readWorkArea() {
          throw new Error('display server gone')
        },
      }),
      () => 0,
    )
    expect(await reader.read()).toBeNull()
  })
})
