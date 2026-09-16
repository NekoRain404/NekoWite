import { describe, expect, it } from 'vitest'
import type { PetCapabilityReport, PetRoamMode } from '../../../platform/gateways/pet-contracts'
import {
  IDLE_TICK_MS,
  SLEEP_AFTER_MS,
  SLEEP_ROW_DEFAULT,
  createPetMotion,
  type PetMotionDeps,
  type PetMotionEngine,
  type PetMotionSettings,
} from './pet-motion'
import {
  DEFAULT_ROAM_SPEED,
  IDLE_MS_MAX,
  IDLE_MS_MIN,
  motionMoodForAlert,
  motionSpeed,
  pxPerSec,
  type MotionClock,
} from './pet-motion-types'
import { DT_SEC, ROW_RIGHT, TICK_MS, WIN_H, WIN_W, type PetMotionFrame } from './pet-physics'
import type { PetMotionPlatform, PhysicalPoint, PhysicalRect } from './pet-platform'

const workArea: PhysicalRect = { x: 0, y: 0, width: 1000, height: 800 }
/** Where the pointer this machine reports sits: inside the work area, to the right of the pet. */
const POINTER: PhysicalPoint = { x: 900, y: 700 }
const NOW_START = 100_000
let nowMs = NOW_START

/**
 * The roam mode every test starts from.
 *
 * It has to be `follow-pointer` rather than a wander: `PetRoamMode` has no value for upstream's
 * default walk (`pet-contracts/config.ts:39`), so no stored mode reaches the wander strategy —
 * the gap D1 has to close, and the reason the roaming tests drive the pointer instead.
 */
const ROAMING: PetRoamMode = 'follow-pointer'

const POINTER_VERIFIED = (): readonly PetCapabilityReport[] => [
  { capability: 'pointer-follow', finding: { status: 'available' } },
]
const CLIMB_VERIFIED = (): readonly PetCapabilityReport[] => [
  { capability: 'window-climb', finding: { status: 'available' } },
]

/** A desktop whose window the test can also push around, the way a compositor drag would. */
interface Desktop {
  platform: PetMotionPlatform
  writes: PhysicalPoint[]
  position(): PhysicalPoint
  setPosition(position: PhysicalPoint): void
}

function desktop(overrides: Partial<PetMotionPlatform> = {}): Desktop {
  let position: PhysicalPoint = { x: 500, y: 400 }
  const writes: PhysicalPoint[] = []
  const platform: PetMotionPlatform = {
    async scaleFactor() {
      return 1
    },
    async readWindowPosition() {
      return position
    },
    async moveWindow(next) {
      writes.push(next)
      position = next
    },
    async readWorkArea() {
      return workArea
    },
    async readPointer() {
      return POINTER
    },
    ...overrides,
  }
  return {
    platform,
    writes,
    position: () => position,
    setPosition: (next) => {
      position = next
    },
  }
}

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

/** A clock that fires at once, so a physics loop finishes inside one `await`. */
function immediateClock(onTimer?: (ms: number) => void): MotionClock {
  return {
    setTimeout: (handler, ms) => {
      onTimer?.(ms)
      handler()
      return 0
    },
    clearTimeout: () => {},
  }
}

interface Harness {
  engine: PetMotionEngine
  desk: Desktop
  rows: number[]
  clears(): number
  settings: PetMotionSettings
  errors: unknown[]
}

interface EngineOptions {
  roam?: PetRoamMode
  motion?: 'system' | 'reduced'
  speed?: number
  capabilities?: () => readonly PetCapabilityReport[]
  desk?: Desktop
  clock?: MotionClock
  sleepRow?: number
  frame?: PetMotionFrame | null
}

function build(desk: Desktop, options: EngineOptions = {}): Harness {
  const f = frame()
  const errors: unknown[] = []
  const settings: PetMotionSettings = {
    roam: options.roam ?? ROAMING,
    speed: options.speed,
    motion: options.motion ?? 'system',
  }
  const deps: PetMotionDeps = {
    platform: desk.platform,
    capabilities: options.capabilities ?? POINTER_VERIFIED,
    settings: () => settings,
    frame: options.frame === undefined ? f.sink : options.frame,
    clock: options.clock ?? immediateClock(),
    now: () => nowMs,
    random: () => 0,
    sleepRow: options.sleepRow,
    onPlatformError: (error) => void errors.push(error),
  }
  return { engine: createPetMotion(deps), desk, rows: f.rows, clears: f.clears, settings, errors }
}

function makeEngine(options: EngineOptions = {}): Harness {
  return build(options.desk ?? desktop(), options)
}

/** Let a started loop reach its first scheduled timer. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Drag the pet and let go of it quickly, so the next tick throws it. */
async function flick(engine: PetMotionEngine, desk: Desktop, ms = 50): Promise<void> {
  engine.setDragging(true)
  await engine.tick()
  desk.setPosition({ x: desk.position().x + 60, y: desk.position().y })
  nowMs += ms
  await engine.tick()
  engine.setDragging(false)
}

describe('motionSpeed', () => {
  it('accepts every speed the slider offers', () => {
    for (let speed = 1; speed <= 10; speed += 1) expect(motionSpeed(speed)).toBe(speed)
  })

  it('replaces a stored value outside the range instead of clamping it', () => {
    // The contract's rule for stored numbers (`readPetNumber`): a `12` is a corrupt setting,
    // not a request to go faster.
    expect(motionSpeed(0)).toBe(DEFAULT_ROAM_SPEED)
    expect(motionSpeed(11)).toBe(DEFAULT_ROAM_SPEED)
    expect(motionSpeed(5.5)).toBe(DEFAULT_ROAM_SPEED)
    expect(motionSpeed('fast')).toBe(DEFAULT_ROAM_SPEED)
    expect(motionSpeed(undefined)).toBe(DEFAULT_ROAM_SPEED)
    // Upstream's bug: a `NaN` speed reached the physics (`types.ts:112`).
    expect(Number.isFinite(motionSpeed(Number.NaN))).toBe(true)
  })
})

describe('motionMoodForAlert', () => {
  it('maps the alert axis onto the three moods', () => {
    expect(motionMoodForAlert(null)).toBe('idle')
    expect(motionMoodForAlert('quiet')).toBe('busy')
    expect(motionMoodForAlert('turn-finished')).toBe('alert')
    expect(motionMoodForAlert('needs-attention')).toBe('alert')
  })
})

describe('tick — roaming', () => {
  it('walks toward the pointer and asks for the fast tick', async () => {
    const h = makeEngine()
    expect(await h.engine.tick()).toEqual({ active: true, delayMs: TICK_MS })

    expect(h.desk.writes).toHaveLength(1)
    expect(h.desk.writes[0].x).toBeGreaterThan(500)
    expect(h.rows).toEqual([ROW_RIGHT])
  })

  it('stops beside the pointer instead of on it, and then rests', async () => {
    // A pointer whose target is inside the work area, so reaching it is possible at all: the
    // pet's own size is what it must stay clear of, not the screen edge.
    const h = makeEngine({
      desk: desktop({
        async readPointer() {
          return { x: 700, y: 700 }
        },
      }),
    })
    h.desk.setPosition({ x: 700 - WIN_W / 2 - 4, y: 700 - WIN_H + 20 })
    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
  })

  it('asks for the slow tick while the pet stands still', async () => {
    const h = makeEngine({ roam: 'stay' })
    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
  })

  it('asks for the slow tick when roaming is off', async () => {
    const h = makeEngine({ roam: 'off' })
    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
  })

  it('keeps a pet still whose mode this machine cannot run, and says why', async () => {
    const h = makeEngine({ roam: ROAMING, capabilities: () => [] })

    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
    // §7.2: the mode is stated as unavailable rather than approximated by another one. The
    // platform has a pointer reader, so the only thing stopping the pet is the report.
    const gate = h.engine.gate()
    expect(gate.behaviour).toBe('stay')
    expect(gate.finding?.status).not.toBe('available')
  })

  it('keeps climb still when the capability is claimed without an implementation', async () => {
    // Nothing on Linux enumerates windows (no Win32 port, §7.2), so this is the shape the
    // claim takes when a host over-reports.
    const h = makeEngine({ roam: 'climb', capabilities: CLIMB_VERIFIED })
    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
  })

  it('climbs the top edge of a window that is under it', async () => {
    const h = makeEngine({
      roam: 'climb',
      capabilities: CLIMB_VERIFIED,
      desk: desktop({
        async readWindowRects() {
          // Below the pet (`top >= pos.y + WIN_H`) and above the work area's floor, which is
          // what makes it the surface it stands on (`modes.ts:157-162`).
          return [{ x: 0, y: 760, width: 1000, height: 600 }]
        },
      }),
    })

    expect((await h.engine.tick()).active).toBe(true)
    expect(h.desk.writes[0]).toMatchObject({ y: 760 - WIN_H })
    expect(h.desk.writes[0].x).toBeLessThan(500)
  })

  it('walks along the top of the screen when no window is under it', async () => {
    // Upstream's fallback surface is the work area itself, and a pet standing "on" it has its
    // top at the screen's top edge — Shimeji's own idea of a pet walking along the screen.
    const h = makeEngine({
      roam: 'climb',
      capabilities: CLIMB_VERIFIED,
      desk: desktop({
        async readWindowRects() {
          return [{ x: 0, y: 20, width: 1000, height: 300 }]
        },
      }),
    })

    expect((await h.engine.tick()).active).toBe(true)
    expect(h.desk.writes[0].y).toBe(0)
  })
})

describe('tick — dragging and releases', () => {
  it('samples the drag and throws the pet on a fast release', async () => {
    const h = makeEngine()
    await flick(h.engine, h.desk)

    expect(await h.engine.tick()).toEqual({ active: true, delayMs: TICK_MS })
    // Friction is applied before the first step (`physics.ts:66-69`).
    expect(h.desk.writes[0].x).toBeCloseTo(560 + 1200 * 0.9 * DT_SEC, 6)
  })

  it('does not throw a pet that was placed carefully', async () => {
    const h = makeEngine()
    h.engine.setDragging(true)
    await h.engine.tick()
    h.desk.setPosition({ x: 502, y: 400 })
    nowMs += 200
    await h.engine.tick()
    h.engine.setDragging(false)
    await h.engine.tick()

    // 10 px/s is below the floor: what moves is the pet's own walk, not a throw.
    expect(h.desk.writes).toHaveLength(1)
    expect(h.desk.writes[0].x - 502).toBeLessThanOrEqual(pxPerSec(5) * DT_SEC)
  })

  it('stops a throw where it is when the user grabs the pet again, and queues nothing', async () => {
    const desk = desktop()
    let steps = 0
    const h = build(desk, {
      clock: immediateClock((ms) => {
        if (ms !== TICK_MS) return
        steps += 1
        if (steps === 3) h.engine.setDragging(true)
      }),
    })
    await flick(h.engine, desk)
    // The tick after a release is the one the flick turns into a throw on.
    expect(await h.engine.tick()).toEqual({ active: true, delayMs: TICK_MS })

    // A flick of 1200 px/s takes some forty steps to die down; this one stopped on the third,
    // where the drag caught it.
    expect(desk.writes.length).toBeLessThan(6)
    const caught = desk.position()

    // Holding the pet still and letting go throws nothing new: the interrupted throw is not
    // waiting its turn (§7.3 「不排队」).
    nowMs += 200
    await h.engine.tick()
    nowMs += 200
    await h.engine.tick()
    h.engine.setDragging(false)
    const before = desk.writes.length
    await h.engine.tick()

    expect(desk.writes.length).toBe(before + 1)
    const after = desk.position()
    expect(Math.hypot(after.x - caught.x, after.y - caught.y)).toBeLessThanOrEqual(
      pxPerSec(5) * DT_SEC + 1e-6,
    )
  })
})

describe('tick — moods', () => {
  it('holds still while the user has something to read', async () => {
    const h = makeEngine()
    h.engine.setMood('alert')

    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
    expect(h.clears()).toBe(1)
    expect(h.engine.mood()).toBe('alert')
  })

  it('lets a throw finish, which the user is watching rather than reading past', async () => {
    const h = makeEngine()
    h.engine.setMood('alert')
    await flick(h.engine, h.desk)
    await h.engine.tick()

    expect(h.desk.writes.length).toBeGreaterThan(1)
  })
})

describe('tick — dozing', () => {
  it('falls asleep after a long enough still spell', async () => {
    const h = makeEngine({ roam: 'stay' })
    nowMs += SLEEP_AFTER_MS + 1
    await h.engine.tick()
    expect(h.rows).toEqual([SLEEP_ROW_DEFAULT])
  })

  it('uses the row the caller bound, when it bound one', async () => {
    const h = makeEngine({ roam: 'stay', sleepRow: 4 })
    nowMs += SLEEP_AFTER_MS + 1
    await h.engine.tick()
    expect(h.rows).toEqual([4])
  })

  it('does not doze while there is work on screen', async () => {
    const h = makeEngine({ roam: 'stay' })
    h.engine.setMood('busy')
    nowMs += SLEEP_AFTER_MS + 1
    await h.engine.tick()
    expect(h.rows).not.toContain(SLEEP_ROW_DEFAULT)
  })

  it('does not doze while it is still walking', async () => {
    const h = makeEngine()
    nowMs += SLEEP_AFTER_MS + 1
    await h.engine.tick()
    expect(h.rows).not.toContain(SLEEP_ROW_DEFAULT)
  })

  it('wakes when something needs the user', async () => {
    const h = makeEngine({ roam: 'stay' })
    nowMs += SLEEP_AFTER_MS + 1
    await h.engine.tick()
    expect(h.rows).toContain(SLEEP_ROW_DEFAULT)

    h.engine.setMood('alert')
    expect(h.clears()).toBeGreaterThan(0)
  })
})

describe('tick — reduced motion (§7.3)', () => {
  it('does not roam, however the roam mode is set', async () => {
    const h = makeEngine({ motion: 'reduced' })
    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
  })

  it('does not bounce a dragged pet either', async () => {
    const h = makeEngine({ motion: 'reduced' })
    await flick(h.engine, h.desk)
    await h.engine.tick()

    // The pet stays where it was let go: no throw, no fall.
    expect(h.desk.writes).toEqual([])
  })

  it('does not doze, which is a pose change rather than a static state', async () => {
    const h = makeEngine({ motion: 'reduced', roam: 'stay' })
    nowMs += SLEEP_AFTER_MS + 1
    await h.engine.tick()
    expect(h.rows).not.toContain(SLEEP_ROW_DEFAULT)
  })

  it('keeps the alert, which reducing motion must never silence', async () => {
    const h = makeEngine({ motion: 'reduced' })
    h.engine.setMood('alert')

    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    // §7.3: fewer animations, not fewer reminders. The mood a bubble is drawn from survives the
    // engine's refusal to move, and nothing here clears it.
    expect(h.engine.mood()).toBe('alert')
  })

  it('stops a throw that is already in flight, rather than letting it finish', async () => {
    const desk = desktop()
    let steps = 0
    const h = build(desk, {
      clock: immediateClock((ms) => {
        if (ms !== TICK_MS) return
        steps += 1
        if (steps === 3) {
          h.settings.motion = 'reduced'
          // A tick that sees the new setting while the throw is still running: §7.3's
          // 「从当前状态反向运行，不排队」.
          void h.engine.tick()
        }
      }),
    })
    await flick(h.engine, desk)

    expect(desk.writes.length).toBeLessThan(6)
  })
})

describe('tick — when the desktop will not play along', () => {
  it('reports a refused move instead of ticking at 30 ms forever', async () => {
    const h = makeEngine({
      desk: desktop({
        async moveWindow() {
          throw new Error('Wayland will not position a toplevel')
        },
      }),
    })

    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.errors).toHaveLength(1)
  })

  it('stays put when the work area cannot be read', async () => {
    const h = makeEngine({
      desk: desktop({
        async readWorkArea() {
          return null
        },
      }),
    })
    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
  })

  it('stays put when the window will not say where it is', async () => {
    const h = makeEngine({
      desk: desktop({
        async readWindowPosition() {
          return null
        },
      }),
    })
    expect(await h.engine.tick()).toEqual({ active: false, delayMs: IDLE_TICK_MS })
    expect(h.desk.writes).toEqual([])
  })

  it('survives a refused move with no error handler at all', async () => {
    const desk = desktop({
      async moveWindow() {
        throw new Error('refused')
      },
    })
    const engine = createPetMotion({
      platform: desk.platform,
      capabilities: POINTER_VERIFIED,
      settings: () => ({ roam: ROAMING, motion: 'system' }),
      clock: immediateClock(),
      now: () => nowMs,
      random: () => 0,
    })
    await expect(engine.tick()).resolves.toEqual({ active: false, delayMs: IDLE_TICK_MS })
  })
})

describe('start and stop (§7.1)', () => {
  it('drives the loop on the injected clock and releases it on stop', async () => {
    const timers: (() => void)[] = []
    let cleared = 0
    const manual: MotionClock = {
      setTimeout: (handler) => {
        timers.push(handler)
        return timers.length
      },
      clearTimeout: () => void (cleared += 1),
    }
    const h = makeEngine({ clock: manual })

    h.engine.start()
    await flush()
    expect(h.desk.writes.length).toBeGreaterThan(0)
    expect(timers.length).toBeGreaterThan(0)

    h.engine.stop()
    // The pending timer is cancelled rather than left to fire into a dead engine.
    expect(cleared).toBeGreaterThan(0)
    const settled = h.desk.writes.length
    for (const timer of [...timers]) timer()
    await flush()
    expect(h.desk.writes.length).toBe(settled)
  })

  it('clears the row override it was holding', async () => {
    const h = makeEngine({ roam: 'stay' })
    nowMs += SLEEP_AFTER_MS + 1
    await h.engine.tick()
    const before = h.clears()
    h.engine.stop()
    expect(h.clears()).toBeGreaterThan(before)
  })

  it('is not started twice by a second call', async () => {
    const timers: (() => void)[] = []
    const manual: MotionClock = {
      setTimeout: (handler) => {
        timers.push(handler)
        return timers.length
      },
      clearTimeout: () => {},
    }
    const h = makeEngine({ clock: manual })
    h.engine.start()
    h.engine.start()
    await flush()
    expect(timers).toHaveLength(1)
    h.engine.stop()
  })
})

describe('what the engine reports about itself', () => {
  it('exposes the gate the settings currently resolve to', () => {
    const h = makeEngine({ roam: 'climb' })
    const gate = h.engine.gate()
    expect(gate.requested).toBe('climb')
    expect(gate.behaviour).toBe('stay')
    expect(gate.capability).toBe('window-climb')
  })

  it('re-reads the settings on every tick, as upstream re-read its config', async () => {
    const h = makeEngine({ roam: 'stay' })
    h.settings.roam = ROAMING
    expect((await h.engine.tick()).active).toBe(true)
  })

  it('keeps its constants in the order the doze depends on', () => {
    expect(IDLE_MS_MIN).toBeLessThan(IDLE_MS_MAX)
    expect(SLEEP_AFTER_MS).toBeGreaterThan(IDLE_MS_MAX)
    expect(WIN_W).toBeGreaterThan(0)
    expect(WIN_H).toBeGreaterThan(WIN_W / 2)
  })
})
