import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import {
  clampForDisplay,
  loadWindowState,
  saveWindowState,
  type WindowState,
} from '../stores/windowState'

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
 */
export function setupWindowTracking(): WindowTracking {
  const inTauri =
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
  let unlistenResized: (() => void) | null = null
  let unlistenMoved: (() => void) | null = null
  let windowSaveTimer: ReturnType<typeof setTimeout> | null = null
  let lastWindowState: WindowState | null = null

  function persistWindowGeometry(state: WindowState | null): void {
    if (!state) return
    lastWindowState = state
    saveWindowState(state)
  }

  async function captureWindowGeometry(): Promise<void> {
    if (!inTauri) return
    try {
      const win = getCurrentWindow()
      const [size, position, maximized] = await Promise.all([
        win.innerSize(),
        win.innerPosition(),
        win.isMaximized(),
      ])
      persistWindowGeometry({
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized,
      })
    } catch {
      // Geometry read is best-effort; never surface it.
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
        // Clamp against the current desktop so a monitor that was unplugged (or
        // a resolution that shrank) cannot leave the window off screen.
        const clamped = clampForDisplay(stored, {
          availWidth: window.screen?.availWidth ?? stored.width,
          availHeight: window.screen?.availHeight ?? stored.height,
        })
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
      unlistenResized = await win.onResized(({ payload }) => {
        lastWindowState = patch(lastWindowState, { width: payload.width, height: payload.height })
        scheduleSave()
      })
      unlistenMoved = await win.onMoved(({ payload }) => {
        lastWindowState = patch(lastWindowState, { x: payload.x, y: payload.y })
        scheduleSave()
      })
    } catch {
      unlistenResized = null
      unlistenMoved = null
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
    unlistenResized?.()
    unlistenMoved?.()
    unlistenResized = null
    unlistenMoved = null
    if (windowSaveTimer) {
      clearTimeout(windowSaveTimer)
      windowSaveTimer = null
    }
  }

  return { restore, start, flush, dispose }
}
