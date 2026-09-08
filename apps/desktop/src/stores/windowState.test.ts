import { describe, expect, it } from 'vitest'
import {
  clampForDisplay,
  isValidWindowState,
  loadWindowState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  saveWindowState,
  WINDOW_STATE_KEY,
  type WindowState,
} from './windowState'

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
