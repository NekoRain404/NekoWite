/** Window geometry persistence across app restarts.
 *
 * Records the window size, position and maximized state so a later launch can
 * restore the exact layout. The geometry is clamped into the currently-available
 * desktop area before being applied, so a monitor that was unplugged (or a
 * resolution that shrank) cannot leave the window off screen or otherwise
 * unreachable. All logic here is pure and side-effect free except
 * `loadWindowState`/`saveWindowState`, which go through the persistence port
 * (`services/persistence`). The window-state domain is versioned (`version: 1`)
 * so a future schema change can migrate an existing blob on load. */

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

export interface DisplayBounds {
  availWidth: number
  availHeight: number
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

/** Clamp a stored geometry so the window stays reachable and at least the
 * minimum size on the given desktop area. Never returns a non-finite value;
 * if the display is unusable (zero size) it falls back to the minimums. */
export function clampForDisplay(state: WindowState, display: DisplayBounds): WindowState {
  const availWidth = Number.isFinite(display.availWidth) ? Math.max(1, display.availWidth) : state.width
  const availHeight = Number.isFinite(display.availHeight) ? Math.max(1, display.availHeight) : state.height
  // Keep the window at least at its minimum size, but never larger than the
  // available area (so it cannot overflow into an unowned screen region).
  const width = Math.min(Math.max(state.width, MIN_WINDOW_WIDTH), Math.max(MIN_WINDOW_WIDTH, availWidth))
  const height = Math.min(Math.max(state.height, MIN_WINDOW_HEIGHT), Math.max(MIN_WINDOW_HEIGHT, availHeight))
  // Pull the top-left corner into view; the titlebar must stay ON screen so
  // the user can still drag the window back after a monitor change.
  const x = Math.max(0, Math.min(state.x, Math.max(0, availWidth - width)))
  const y = Math.max(0, Math.min(state.y, Math.max(0, availHeight - height)))
  return { ...state, width, height, x, y }
}

/** Versioned window-state domain. `defaults` is null (no persisted geometry);
 *  `parse` returns a valid state or null (corrupt → null → defaults), and the
 *  load runs a `migrate()` chain (currently none) before parsing. */
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
