import { describe, expect, it } from 'vitest'
import {
  clampForDisplay,
  isValidWindowState,
  loadWindowState,
  logicalDisplayBounds,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  physicalToLogicalGeometry,
  pickDisplayBounds,
  saveWindowState,
  WINDOW_STATE_KEY,
  type MonitorLike,
  type WindowState,
} from './window-state'

const base: WindowState = { width: 1200, height: 800, x: 100, y: 50, maximized: false }

describe('clampForDisplay', () => {
  it('leaves a fully-visible state untouched', () => {
    const out = clampForDisplay(base, { availWidth: 1920, availHeight: 1080 })
    expect(out).toEqual(base)
  })

  it('pulls an off-screen window back into the visible area', () => {
    const out = clampForDisplay({ ...base, x: 4000, y: 3000 }, { availWidth: 1920, availHeight: 1080 })
    expect(out.x).toBe(1920 - out.width)
    expect(out.y).toBe(1080 - out.height)
    expect(out.x).toBeGreaterThanOrEqual(0)
    expect(out.y).toBeGreaterThanOrEqual(0)
  })

  it('clamps a negative position to the top-left corner', () => {
    const out = clampForDisplay({ ...base, x: -500, y: -300 }, { availWidth: 1920, availHeight: 1080 })
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
  })

  it('shrinks an oversized window to fit a smaller desktop', () => {
    const out = clampForDisplay({ ...base, width: 3000, height: 2000 }, { availWidth: 1366, availHeight: 768 })
    expect(out.width).toBe(1366)
    expect(out.height).toBe(768)
  })

  it('never returns a window below the minimum size', () => {
    const out = clampForDisplay({ ...base, width: 200, height: 100 }, { availWidth: 1920, availHeight: 1080 })
    expect(out.width).toBe(MIN_WINDOW_WIDTH)
    expect(out.height).toBe(MIN_WINDOW_HEIGHT)
  })

  it('handles an unusable (zero) display without NaN', () => {
    const out = clampForDisplay(base, { availWidth: 0, availHeight: 0 })
    expect(Number.isFinite(out.width)).toBe(true)
    expect(Number.isFinite(out.height)).toBe(true)
    expect(Number.isFinite(out.x)).toBe(true)
    expect(Number.isFinite(out.y)).toBe(true)
  })

  it('keeps the maximized flag through clamping', () => {
    const out = clampForDisplay({ ...base, maximized: true }, { availWidth: 1920, availHeight: 1080 })
    expect(out.maximized).toBe(true)
  })
})

// C4: the capture is PHYSICAL (innerSize/innerPosition and the resize/move
// payloads) while setSize/setPosition apply LOGICAL pixels. Without this
// conversion a 125%/150% display multiplied the window by the scale factor on
// every restart, so the clamp squashed it against the work area and pinned it to
// the top-left corner.
describe('physicalToLogicalGeometry', () => {
  it('divides a physical capture by the display scale', () => {
    const out = physicalToLogicalGeometry({ width: 2400, height: 1500, x: 300, y: 200 }, 1.25)
    expect(out).toEqual({ width: 1920, height: 1200, x: 240, y: 160 })
  })

  it('treats an unusable scale factor as 1 instead of producing 0-sized or NaN geometry', () => {
    const physical = { width: 1600, height: 1000, x: 100, y: 60 }
    for (const scale of [0, Number.NaN, -2, Number.POSITIVE_INFINITY]) {
      const out = physicalToLogicalGeometry(physical, scale)
      expect(out).toEqual(physical)
      expect(Number.isFinite(out.width)).toBe(true)
      expect(Number.isFinite(out.x)).toBe(true)
    }
  })
})

describe('logicalDisplayBounds', () => {
  it('converts a monitor rect (physical) to logical bounds, origin included', () => {
    const secondary: MonitorLike = {
      size: { width: 3840, height: 2160 },
      position: { x: 3840, y: 0 },
      scaleFactor: 2,
    }
    expect(logicalDisplayBounds(secondary)).toEqual({
      availWidth: 1920,
      availHeight: 1080,
      x: 1920,
      y: 0,
    })
  })

  it('returns null when the monitor is missing or unusable', () => {
    expect(logicalDisplayBounds(null)).toBeNull()
    expect(logicalDisplayBounds(undefined)).toBeNull()
    expect(
      logicalDisplayBounds({ size: { width: 0, height: 0 }, position: { x: 0, y: 0 }, scaleFactor: 1 }),
    ).toBeNull()
  })
})

describe('clampForDisplay / pickDisplayBounds with a monitor origin', () => {
  const wide: WindowState = { width: 1200, height: 800, x: 2400, y: 120, maximized: false }

  it('leaves a window that fits inside a secondary monitor untouched', () => {
    // Pre-fix this was clamped against the PRIMARY screen (0,0 origin), which
    // dragged every window that lived on a second monitor back onto the first.
    expect(clampForDisplay(wide, { availWidth: 1920, availHeight: 1080, x: 1920, y: 0 })).toEqual(wide)
  })

  it('pulls an off-screen window back onto the area it was clamped against', () => {
    const out = clampForDisplay(
      { width: 1200, height: 800, x: 9000, y: 9000, maximized: false },
      { availWidth: 1920, availHeight: 1080, x: 1920, y: 0 },
    )
    expect(out.x).toBe(1920 + 1920 - 1200)
    expect(out.y).toBe(1080 - 800)
  })

  it('picks the monitor that already contains the window, not the current one', () => {
    const primary: MonitorLike = {
      size: { width: 1920, height: 1080 },
      position: { x: 0, y: 0 },
      scaleFactor: 1,
    }
    const secondary: MonitorLike = {
      size: { width: 2560, height: 1440 },
      position: { x: 1920, y: 0 },
      scaleFactor: 1,
    }
    // The window is on the secondary screen while `currentMonitor()` still says
    // primary (the window has not been moved yet at restore time).
    expect(pickDisplayBounds(wide, [primary, secondary])).toEqual({
      availWidth: 2560,
      availHeight: 1440,
      x: 1920,
      y: 0,
    })
    // A window that is nowhere to be seen falls back to the first candidate.
    const offScreen: WindowState = { ...wide, x: 9000, y: 9000 }
    expect(pickDisplayBounds(offScreen, [primary, secondary])).toEqual({
      availWidth: 1920,
      availHeight: 1080,
      x: 0,
      y: 0,
    })
    expect(pickDisplayBounds(wide, [])).toBeNull()
  })
})

describe('isValidWindowState', () => {
  it('accepts a complete, correctly-typed state', () => {
    expect(isValidWindowState(base)).toBe(true)
  })

  it('rejects missing, wrong-typed or non-finite fields', () => {
    expect(isValidWindowState({ ...base, width: undefined })).toBe(false)
    expect(isValidWindowState({ ...base, maximized: 'yes' })).toBe(false)
    expect(isValidWindowState({ ...base, x: Number.NaN })).toBe(false)
    expect(isValidWindowState(null)).toBe(false)
    expect(isValidWindowState('window')).toBe(false)
  })
})

describe('loadWindowState / saveWindowState', () => {
  it('round-trips a saved state', () => {
    saveWindowState(base)
    expect(loadWindowState()).toEqual(base)
    expect(localStorage.getItem(WINDOW_STATE_KEY)).toBe(JSON.stringify(base))
  })

  it('returns null when nothing is stored', () => {
    expect(loadWindowState()).toBeNull()
  })

  it('returns null for corrupted JSON', () => {
    localStorage.setItem(WINDOW_STATE_KEY, '{corrupt')
    expect(loadWindowState()).toBeNull()
  })

  it('returns null for a valid JSON value with the wrong shape', () => {
    localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify({ v: 1, width: 'big' }))
    expect(loadWindowState()).toBeNull()
  })

  it('overwrites on repeated saves', () => {
    saveWindowState(base)
    const next: WindowState = { ...base, width: 900, maximized: true }
    saveWindowState(next)
    expect(loadWindowState()).toEqual(next)
  })
})
