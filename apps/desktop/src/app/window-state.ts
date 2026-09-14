import { availableMonitors, currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import {
  clampForDisplay,
  loadWindowState,
  physicalToLogicalGeometry,
  pickDisplayBounds,
  saveWindowState,
  type DisplayBounds,
  type WindowState,
} from '../stores/window-state'

const WINDOW_TRACK_MS = 300

export interface WindowTracking {
  /** Apply the last-persisted geometry before the vault is opened, so the
   *  restored layout is visible while the editor initializes. Best-effort. */
  restore(): Promise<void>
  /** Attach the resize/move listeners and capture the initial geometry. */
  start(): Promise<void>
  /** Flush the freshest geometry to storage (used on close). */
  flush(): void
  /** Detach every listener and drop any pending save timer. */
  dispose(): void
}

/**
 * Window size/position persistence for the app shell.
 *
 * This is the ONLY place that touches the Tauri window API. All geometry is
 * captured to localStorage (via the pure `stores/windowState` helpers) and
 * restored on the next launch, clamped to the currently-available desktop area
 * so a monitor that was unplugged cannot leave the window off screen. Every
 * read/write is best-effort: a missing or broken Tauri bridge, or a window that
 * cannot be queried, must never block startup.
 *
 * Both directions work in LOGICAL pixels. Tauri answers in physical ones
 * (`innerSize()`/`innerPosition()` and the resize/move payloads) while
 * `setSize`/`setPosition` multiply their argument by the display scale, so
 * storing the raw capture and re-applying it doubled the scale factor at
 * 125%/150%: the window came back wider than the screen, was clamped to the whole
 * work area and pinned to the top-left corner.
 */
export function setupWindowTracking(): WindowTracking {
  const inTauri =
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
  let unlistenResized: (() => void) | null = null
  let unlistenMoved: (() => void) | null = null
  let unlistenScale: (() => void) | null = null
  let windowSaveTimer: ReturnType<typeof setTimeout> | null = null
  let lastWindowState: WindowState | null = null
  /** Display scale used to convert the PHYSICAL numbers the window API reports
   *  into the LOGICAL pixels we persist. Refreshed by every capture and by
   *  `onScaleChanged` (dragging the window to a monitor with another DPI). */
  let scaleFactor = 1

  function persistWindowGeometry(state: WindowState | null): void {
    if (!state) return
    lastWindowState = state
    saveWindowState(state)
  }

  /** An event payload (physical pixels) → the logical fields of `lastWindowState`. */
  function logicalPatch(physical: {
    width?: number
    height?: number
    x?: number
    y?: number
  }): Partial<WindowState> {
    const logical = physicalToLogicalGeometry(
      {
        width: physical.width ?? 0,
        height: physical.height ?? 0,
        x: physical.x ?? 0,
        y: physical.y ?? 0,
      },
      scaleFactor,
    )
    const patch: Partial<WindowState> = {}
    if (physical.width !== undefined) patch.width = logical.width
    if (physical.height !== undefined) patch.height = logical.height
    if (physical.x !== undefined) patch.x = logical.x
    if (physical.y !== undefined) patch.y = logical.y
    return patch
  }

  async function captureWindowGeometry(): Promise<void> {
    if (!inTauri) return
    try {
      const win = getCurrentWindow()
      const [size, position, scale, maximized] = await Promise.all([
        win.innerSize(),
        win.innerPosition(),
        win.scaleFactor(),
        win.isMaximized(),
      ])
      scaleFactor = scale
      const logical = physicalToLogicalGeometry(
        { width: size.width, height: size.height, x: position.x, y: position.y },
        scale,
      )
      persistWindowGeometry({
        width: logical.width,
        height: logical.height,
        x: logical.x,
        y: logical.y,
        maximized,
      })
    } catch {
      // Geometry read is best-effort; never surface it.
    }
  }

  /**
   * The logical area to clamp the restored window against.
   *
   * The monitor list is the only source that knows about more than the primary
   * display (a window the user keeps on a secondary screen must not be dragged
   * back), so it is preferred; `window.screen` — always present, primary only —
   * is the last resort.
   */
  async function displayBoundsFor(state: WindowState): Promise<DisplayBounds> {
    const fallback: DisplayBounds = {
      availWidth: window.screen?.availWidth ?? state.width,
      availHeight: window.screen?.availHeight ?? state.height,
    }
    try {
      const current = await currentMonitor()
      // A failing `availableMonitors` (unsupported bridge) must not lose the
      // current monitor's bounds.
      const others = await availableMonitors().catch(() => [])
      return pickDisplayBounds(state, [current, ...others].filter((m) => m !== null)) ?? fallback
    } catch {
      return fallback
    }
  }

  async function restore(): Promise<void> {
    if (!inTauri) return
    const stored = loadWindowState()
    if (!stored) return
    try {
      const win = getCurrentWindow()
      if (stored.maximized) {
        await win.maximize()
      } else {
        // Clamp against the monitor the window belongs to (see displayBoundsFor)
        // so a monitor that was unplugged — or a resolution that shrank — cannot
        // leave the window off screen, while a window that still fits somewhere
        // keeps its exact position. Both the stored value and the bounds are
        // logical pixels, which is what setSize/setPosition consume.
        const clamped = clampForDisplay(stored, await displayBoundsFor(stored))
        await win.setSize(new LogicalSize(clamped.width, clamped.height))
        await win.setPosition(new LogicalPosition(clamped.x, clamped.y))
      }
    } catch {
      // A failed restore (e.g. minimal environment) must not break startup.
    }
  }

  function scheduleSave(): void {
    if (windowSaveTimer) clearTimeout(windowSaveTimer)
    windowSaveTimer = setTimeout(() => {
      windowSaveTimer = null
      void captureWindowGeometry()
    }, WINDOW_TRACK_MS)
  }

  /** Release every window listener that is currently attached. The three
   *  registrations are three separate awaits, so a failure partway through
   *  `start()` must release the ones that already succeeded instead of dropping
   *  their handles (see the catch there). */
  function releaseListeners(): void {
    unlistenResized?.()
    unlistenMoved?.()
    unlistenScale?.()
    unlistenResized = null
    unlistenMoved = null
    unlistenScale = null
  }

  async function start(): Promise<void> {
    if (!inTauri) return
    // Track geometry eagerly from the event payloads too, so an unload that
    // fires before the debounce still has the freshest values to flush.
    const patch = (prev: WindowState | null, next: Partial<WindowState>): WindowState => ({
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      maximized: false,
      ...(prev ?? {}),
      ...next,
    })
    try {
      const win = getCurrentWindow()
      // The payloads are physical, so the factor has to be known before the first
      // one arrives.
      scaleFactor = await win.scaleFactor().catch(() => scaleFactor)
      unlistenResized = await win.onResized(({ payload }) => {
        lastWindowState = patch(lastWindowState, logicalPatch({ width: payload.width, height: payload.height }))
        scheduleSave()
      })
      unlistenMoved = await win.onMoved(({ payload }) => {
        lastWindowState = patch(lastWindowState, logicalPatch({ x: payload.x, y: payload.y }))
        scheduleSave()
      })
      unlistenScale = await win.onScaleChanged(({ payload }) => {
        // The window moved to a display with another scale: later physical
        // payloads must be converted with the new factor, and the current
        // geometry has to be re-read to stay in one coordinate system.
        scaleFactor = payload.scaleFactor
        scheduleSave()
      })
    } catch {
      // A registration that rejects leaves the earlier ones attached with no
      // handle left to remove them, so release what did succeed.
      releaseListeners()
    }
    void captureWindowGeometry()
  }

  function flush(): void {
    if (windowSaveTimer) {
      clearTimeout(windowSaveTimer)
      windowSaveTimer = null
    }
    persistWindowGeometry(lastWindowState)
  }

  function dispose(): void {
    releaseListeners()
    if (windowSaveTimer) {
      clearTimeout(windowSaveTimer)
      windowSaveTimer = null
    }
  }

  return { restore, start, flush, dispose }
}