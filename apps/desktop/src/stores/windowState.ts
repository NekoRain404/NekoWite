/** Window geometry persistence across app restarts.
 *
 * Records the window size, position and maximized state so a later launch can
 * restore the exact layout. The geometry is clamped into the currently-available
 * desktop area before being applied, so a monitor that was unplugged (or a
 * resolution that shrank) cannot leave the window off screen or otherwise
 * unreachable. All logic here is pure and side-effect free except
 * `loadWindowState`/`saveWindowState`, which go through the persistence port
 * (`services/persistence`). The window-state domain is versioned (`version: 1`)
 * so a future schema change can migrate an existing blob on load.
 *
 * EVERY value in `WindowState` is a LOGICAL pixel: that is what `setSize`/
 * `setPosition` consume (they multiply by the display scale themselves), and
 * mixing the physical numbers `innerSize()`/`innerPosition()` report with them is
 * what made a 125%/150% display lose the window geometry on every restart. See
 * `physicalToLogicalGeometry`. */

import { createDomainPersister, persistence } from '../services/persistence'

export const WINDOW_STATE_KEY = 'nekowite.windowState'

export const MIN_WINDOW_WIDTH = 860
export const MIN_WINDOW_HEIGHT = 560

export interface WindowState {
  width: number
  height: number
  x: number
  y: number
  maximized: boolean
}

/** A rectangle in either coordinate system (see the call sites for which). */
export interface GeometryRect {
  width: number
  height: number
  x: number
  y: number
}

/** The area a window is kept inside, in LOGICAL pixels. */
export interface DisplayBounds {
  availWidth: number
  availHeight: number
  /** Logical origin of the area. A secondary monitor does not start at 0,0, so
   *  the origin has to travel with the size or every clamp would drag the window
   *  back onto the primary display. Defaults to the origin. */
  x?: number
  y?: number
}

/** The subset of Tauri's `Monitor` this module reasons about, structurally, so
 *  the pure helpers stay free of the Tauri API (and testable without a bridge). */
export interface MonitorLike {
  size: { width: number; height: number }
  position: { x: number; y: number }
  scaleFactor: number
}

export function isValidWindowState(value: unknown): value is WindowState {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return (
    typeof o.width === 'number' &&
    Number.isFinite(o.width) &&
    typeof o.height === 'number' &&
    Number.isFinite(o.height) &&
    typeof o.x === 'number' &&
    Number.isFinite(o.x) &&
    typeof o.y === 'number' &&
    Number.isFinite(o.y) &&
    typeof o.maximized === 'boolean'
  )
}

/** A display scale factor that can be divided by. A monitor that could not be
 *  queried reports 0/NaN/negative; treating that as 1 keeps the window unscaled
 *  instead of collapsing it to size 0 at NaN coordinates. */
function usableScale(scaleFactor: number): number {
  return Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
}

/**
 * Convert a captured geometry into LOGICAL pixels.
 *
 * Tauri reports the window in PHYSICAL pixels (`innerSize()`/`innerPosition()`,
 * and the resize/move event payloads) while `setSize`/`setPosition` take LOGICAL
 * ones. Persisting the physical numbers and re-applying them as logical values
 * multiplied the window by the display scale on every restart: at 125%/150% the
 * restored window came out larger than the screen, so the clamp then squashed it
 * to the full work area and pinned it to the top-left corner.
 */
export function physicalToLogicalGeometry(physical: GeometryRect, scaleFactor: number): GeometryRect {
  const scale = usableScale(scaleFactor)
  return {
    width: physical.width / scale,
    height: physical.height / scale,
    x: physical.x / scale,
    y: physical.y / scale,
  }
}

/** The monitor's area in LOGICAL pixels, origin included (see
 *  {@link DisplayBounds.x}). `null` when the monitor could not be queried, so the
 *  caller can fall back to the browser's `window.screen`. */
export function logicalDisplayBounds(monitor: MonitorLike | null | undefined): DisplayBounds | null {
  if (!monitor) return null
  const width = monitor.size?.width
  const height = monitor.size?.height
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const scale = usableScale(monitor.scaleFactor)
  const monX = Number.isFinite(monitor.position?.x) ? monitor.position.x : 0
  const monY = Number.isFinite(monitor.position?.y) ? monitor.position.y : 0
  return {
    availWidth: width / scale,
    availHeight: height / scale,
    x: monX / scale,
    y: monY / scale,
  }
}

function containsRect(bounds: DisplayBounds, state: WindowState): boolean {
  const x = bounds.x ?? 0
  const y = bounds.y ?? 0
  return (
    state.x >= x &&
    state.y >= y &&
    state.x + state.width <= x + bounds.availWidth &&
    state.y + state.height <= y + bounds.availHeight
  )
}

/** True when the window touches the area at all — enough for its titlebar to stay
 *  draggable, which is the property the clamp has to preserve. */
function intersectsRect(bounds: DisplayBounds, state: WindowState): boolean {
  const x = bounds.x ?? 0
  const y = bounds.y ?? 0
  return (
    state.x < x + bounds.availWidth &&
    state.x + state.width > x &&
    state.y < y + bounds.availHeight &&
    state.y + state.height > y
  )
}

/**
 * Pick the area to clamp `state` against out of the monitors that could be
 * queried (the current one first, then the rest).
 *
 * A window that still fits inside one of them is kept there: on Windows a window
 * the user left on a SECONDARY screen is restored while the "current" monitor is
 * still the primary one (the window has not been moved yet), so clamping against
 * the current monitor alone would drag it back to the primary display. Only a
 * window that is not visible on any monitor falls back to the first candidate.
 */
export function pickDisplayBounds(state: WindowState, monitors: MonitorLike[]): DisplayBounds | null {
  const bounds = monitors
    .map((monitor) => logicalDisplayBounds(monitor))
    .filter((value): value is DisplayBounds => value !== null)
  if (bounds.length === 0) return null
  return (
    bounds.find((area) => containsRect(area, state)) ??
    bounds.find((area) => intersectsRect(area, state)) ??
    bounds[0]
  )
}

/** Clamp a stored geometry so the window stays reachable and at least the
 * minimum size on the given desktop area. Never returns a non-finite value;
 * if the display is unusable (zero size) it falls back to the minimums. */
export function clampForDisplay(state: WindowState, display: DisplayBounds): WindowState {
  const availWidth = Number.isFinite(display.availWidth) ? Math.max(1, display.availWidth) : state.width
  const availHeight = Number.isFinite(display.availHeight) ? Math.max(1, display.availHeight) : state.height
  const originX = Number.isFinite(display.x) ? (display.x as number) : 0
  const originY = Number.isFinite(display.y) ? (display.y as number) : 0
  // Keep the window at least at its minimum size, but never larger than the
  // available area (so it cannot overflow into an unowned screen region).
  const width = Math.min(Math.max(state.width, MIN_WINDOW_WIDTH), Math.max(MIN_WINDOW_WIDTH, availWidth))
  const height = Math.min(Math.max(state.height, MIN_WINDOW_HEIGHT), Math.max(MIN_WINDOW_HEIGHT, availHeight))
  // Pull the top-left corner into view; the titlebar must stay ON screen so
  // the user can still drag the window back after a monitor change.
  const x = Math.max(originX, Math.min(state.x, Math.max(originX, originX + availWidth - width)))
  const y = Math.max(originY, Math.min(state.y, Math.max(originY, originY + availHeight - height)))
  return { ...state, width, height, x, y }
}

/** Versioned window-state domain. `defaults` is null (no persisted geometry);
 * `parse` returns a valid state or null (corrupt → null → defaults), and the
 * load runs a `migrate()` chain (currently none) before parsing. */
const windowStateDomain = createDomainPersister<WindowState | null>(persistence, {
  key: WINDOW_STATE_KEY,
  version: 1,
  defaults: () => null,
  parse: (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw)
      return isValidWindowState(parsed) ? parsed : null
    } catch {
      // Missing/corrupted storage is not an error; start with defaults.
      return null
    }
  },
  serialize: (state) => JSON.stringify(state),
})

export function loadWindowState(): WindowState | null {
  return windowStateDomain.load()
}

export function saveWindowState(state: WindowState): void {
  windowStateDomain.save(state)
}