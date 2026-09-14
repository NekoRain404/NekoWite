import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { loadWindowState, saveWindowState } from '../stores/window-state'

// C4. The window API answers in PHYSICAL pixels and consumes LOGICAL ones, so
// these tests pin the coordinate system on both sides of the boundary: what gets
// persisted (a capture, and the resize/move payloads used for the close-time
// flush) and what gets applied (setSize/setPosition).
const h = vi.hoisted(() => ({
  win: {
    innerSize: vi.fn(),
    innerPosition: vi.fn(),
    scaleFactor: vi.fn(),
    isMaximized: vi.fn(),
    onResized: vi.fn(),
    onMoved: vi.fn(),
    onScaleChanged: vi.fn(),
    setSize: vi.fn(),
    setPosition: vi.fn(),
    maximize: vi.fn(),
  },
  currentMonitor: vi.fn(),
  availableMonitors: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => h.win,
  currentMonitor: h.currentMonitor,
  availableMonitors: h.availableMonitors,
}))

import { setupWindowTracking } from './window-state'

const primary = {
  size: { width: 1920, height: 1080 },
  position: { x: 0, y: 0 },
  scaleFactor: 1,
}

type SizeHandler = (event: { payload: { width: number; height: number } }) => void
type MoveHandler = (event: { payload: { x: number; y: number } }) => void

const noopUnlisten = (): void => {}

beforeEach(() => {
  vi.resetAllMocks()
  ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  h.win.scaleFactor.mockResolvedValue(1)
  h.win.isMaximized.mockResolvedValue(false)
  h.win.innerSize.mockResolvedValue({ width: 1200, height: 800 })
  h.win.innerPosition.mockResolvedValue({ x: 100, y: 60 })
  h.win.onResized.mockResolvedValue(noopUnlisten)
  h.win.onMoved.mockResolvedValue(noopUnlisten)
  h.win.onScaleChanged.mockResolvedValue(noopUnlisten)
  h.win.setSize.mockResolvedValue(undefined)
  h.win.setPosition.mockResolvedValue(undefined)
  h.win.maximize.mockResolvedValue(undefined)
  h.currentMonitor.mockResolvedValue(primary)
  h.availableMonitors.mockResolvedValue([primary])
})

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('setupWindowTracking capture', () => {
  it('persists the captured geometry in logical pixels on a scaled display', async () => {
    h.win.scaleFactor.mockResolvedValue(1.25)
    h.win.innerSize.mockResolvedValue({ width: 2400, height: 1500 })
    h.win.innerPosition.mockResolvedValue({ x: 300, y: 200 })

    const tracking = setupWindowTracking()
    await tracking.start()
    await vi.waitFor(() => expect(loadWindowState()).not.toBeNull())

    expect(loadWindowState()).toEqual({ width: 1920, height: 1200, x: 240, y: 160, maximized: false })
    tracking.dispose()
  })

  it('converts resize/move payloads too (the close-time flush path)', async () => {
    h.win.scaleFactor.mockResolvedValue(1.5)
    let onResize: SizeHandler = () => {}
    let onMove: MoveHandler = () => {}
    h.win.onResized.mockImplementation(async (cb: SizeHandler) => {
      onResize = cb
      return noopUnlisten
    })
    h.win.onMoved.mockImplementation(async (cb: MoveHandler) => {
      onMove = cb
      return noopUnlisten
    })

    const tracking = setupWindowTracking()
    await tracking.start()
    await vi.waitFor(() => expect(loadWindowState()).not.toBeNull())

    // The user resizes to 1500x900 physical (1000x600 logical at 150%) and moves
    // the window, then closes it before the debounce fires.
    onResize({ payload: { width: 1500, height: 900 } })
    onMove({ payload: { x: 750, y: 300 } })
    tracking.flush()

    expect(loadWindowState()).toEqual({ width: 1000, height: 600, x: 500, y: 200, maximized: false })
    tracking.dispose()
  })
})

describe('setupWindowTracking restore', () => {
  it('applies the stored logical geometry through LogicalSize/LogicalPosition', async () => {
    saveWindowState({ width: 1600, height: 1000, x: 200, y: 120, maximized: false })
    // 2400x1500 physical at 125% = 1920x1200 logical: the stored window fits, so
    // it must be re-applied untouched (and in logical pixels).
    h.currentMonitor.mockResolvedValue({
      size: { width: 2400, height: 1500 },
      position: { x: 0, y: 0 },
      scaleFactor: 1.25,
    })
    h.availableMonitors.mockResolvedValue([])

    await setupWindowTracking().restore()

    expect(h.win.setSize).toHaveBeenCalledWith(new LogicalSize(1600, 1000))
    expect(h.win.setPosition).toHaveBeenCalledWith(new LogicalPosition(200, 120))
  })

  it('does not drag a window that lives on a secondary monitor back to the primary', async () => {
    saveWindowState({ width: 1200, height: 800, x: 2400, y: 120, maximized: false })
    const secondary = {
      size: { width: 1920, height: 1080 },
      position: { x: 1920, y: 0 },
      scaleFactor: 1,
    }
    h.currentMonitor.mockResolvedValue(primary)
    h.availableMonitors.mockResolvedValue([primary, secondary])

    await setupWindowTracking().restore()

    expect(h.win.setSize).toHaveBeenCalledWith(new LogicalSize(1200, 800))
    expect(h.win.setPosition).toHaveBeenCalledWith(new LogicalPosition(2400, 120))
  })

  it('falls back to window.screen when no monitor can be queried', async () => {
    saveWindowState({ width: 1200, height: 800, x: 9000, y: 9000, maximized: false })
    h.currentMonitor.mockRejectedValue(new Error('no monitor'))
    h.availableMonitors.mockRejectedValue(new Error('no monitor'))
    const originalScreen = Object.getOwnPropertyDescriptor(window, 'screen')
    Object.defineProperty(window, 'screen', {
      configurable: true,
      value: { availWidth: 1280, availHeight: 720 },
    })
    try {
      await setupWindowTracking().restore()
    } finally {
      if (originalScreen) Object.defineProperty(window, 'screen', originalScreen)
    }

    // Clamped into the fallback area instead of being left off screen: the height
    // is cut to the 720px the fallback reports and the position is pulled inside.
    expect(h.win.setSize).toHaveBeenCalledWith(new LogicalSize(1200, 720))
    expect(h.win.setPosition).toHaveBeenCalledWith(new LogicalPosition(80, 0))
  })

  it('restores a maximized window by maximizing it', async () => {
    saveWindowState({ width: 1600, height: 1000, x: 200, y: 120, maximized: true })

    await setupWindowTracking().restore()

    expect(h.win.maximize).toHaveBeenCalled()
    expect(h.win.setSize).not.toHaveBeenCalled()
    expect(h.win.setPosition).not.toHaveBeenCalled()
  })
})