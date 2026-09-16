/**
 * The machine, as the motion sees it — and what the motion does where the machine cannot
 * help.
 *
 * Ported from `references/desktop-pet/windows/src/roam/{window,environment}.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421`:
 *
 *   - `window.ts:14-22` (`currentLogicalPos`) and `:26-28` (`setLogical`): the pet window's
 *     own position, divided by the scale factor so every bound and mode stays in one unit.
 *     {@link logicalWindow} is that seam.
 *   - `environment.ts:19-29` the physical→logical conversion, `:34-74` the 500 ms monitor and
 *     window caches with the reasons upstream kept them, and `:81-101` the work-area read
 *     that returns null rather than substituting a screen size.
 *
 * Two ways it is not the same file: the window, the pointer and the screen are a parameter
 * ({@link PetMotionPlatform}) rather than imports of `@tauri-apps/api` (`window.ts:6`,
 * `environment.ts:5`, `modes.ts:46`), which is §3's adaptation and what lets an environment
 * that cannot do something say so rather than be routed around; and upstream's per-window
 * override keys (`types.ts:72-83`) are the caller's settings now, so nothing here reads
 * `localStorage` (§5.3: one write authority).
 *
 * Which modes this machine can run is the other half of that statement, and it is in
 * `pet-modes.ts` beside the modes themselves.
 */
import type { LogicalWindow, Point, Rect } from './pet-physics'

/** A position or rectangle as the window system reports it: physical pixels. */
export interface PhysicalPoint {
  x: number
  y: number
}
export interface PhysicalRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Everything the motion needs from the desktop — upstream's whole reach for it.
 *
 * `readPointer` and `readWindowRects` are optional *on purpose*: a desktop that cannot do one
 * of them does not implement the method, which is a stronger statement than a method returning
 * nothing. `gateRoamMode` (in `pet-modes.ts`) reads that absence.
 */
export interface PetMotionPlatform {
  /** The scale factor of the monitor the pet is on (1, 1.25, 1.5, 2, …). */
  scaleFactor(): Promise<number>
  /** The pet window's outer position, physical px; null when it cannot be read (`window.ts:14-22`). */
  readWindowPosition(): Promise<PhysicalPoint | null>
  /** Move the pet window, physical px. The caller has clamped it to the work area (`window.ts:26-28`). */
  moveWindow(position: PhysicalPoint): Promise<void>
  /** Work area of that monitor, physical px, taskbars excluded (`environment.ts:86-93`). */
  readWorkArea(): Promise<PhysicalRect | null>
  /** The global pointer, physical px (`modes.ts:48`). Absent → follow-pointer is unusable. */
  readPointer?(): Promise<PhysicalPoint | null>
  /**
   * The visible application windows, physical px. Absent on Linux: upstream enumerates them
   * through Win32 only (`sys_windows.rs:128-129`, empty elsewhere), §7.2 forbids porting that,
   * and climb is a separate platform task.
   */
  readWindowRects?(): Promise<PhysicalRect[]>
}

/**
 * The scale factor, as a ratio that can divide: upstream's `m.scaleFactor || 1`
 * (`environment.ts:86`), where anything unusable is 1:1 rather than a division by zero.
 */
export function scaleFactorOf(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

/** Physical → logical (`window.ts:19`) and back: what the platform is handed. */
export function toLogical(physical: number, scaleFactor: number): number {
  return physical / scaleFactor
}
export function toPhysical(logical: number, scaleFactor: number): number {
  return logical * scaleFactor
}

/** A physical rectangle as a logical one. Upstream `environment.ts:19-29`. */
export function rectToLogical(rect: PhysicalRect, scaleFactor: number): Rect {
  return {
    left: toLogical(rect.x, scaleFactor),
    top: toLogical(rect.y, scaleFactor),
    right: toLogical(rect.x + rect.width, scaleFactor),
    bottom: toLogical(rect.y + rect.height, scaleFactor),
  }
}

/**
 * The pet's own position in logical pixels, both ways — upstream `roam/window.ts`.
 *
 * The conversion is done here and is not rounded, so a logical position survives a round trip
 * at 1.25×, 1.5× and 2×: the acceptance case that a position correct at 1× is correct on a
 * scaled display. Upstream handed Tauri a `LogicalPosition` (`window.ts:27`); this port speaks
 * physical pixels, so the conversion is on this side.
 */
export function logicalWindow(platform: PetMotionPlatform): LogicalWindow {
  return {
    async currentPosition(): Promise<Point | null> {
      try {
        const scaleFactor = scaleFactorOf(await platform.scaleFactor())
        const position = await platform.readWindowPosition()
        return position ? { x: position.x / scaleFactor, y: position.y / scaleFactor } : null
      } catch {
        return null
      }
    },
    async moveTo(position: Point): Promise<void> {
      const scaleFactor = scaleFactorOf(await platform.scaleFactor())
      await platform.moveWindow({
        x: toPhysical(position.x, scaleFactor),
        y: toPhysical(position.y, scaleFactor),
      })
    },
  }
}

/**
 * The pointer in logical pixels, or null when it cannot be read now.
 *
 * Upstream read the window's scale factor and then `cursorPosition()`, and let the mode's `try`
 * swallow any failure (`modes.ts:44-56`); a null here is that same "no target this tick", which
 * leaves the pet where it is rather than sending it to a remembered spot. It lives beside
 * {@link logicalWindow} because it is the same conversion.
 */
export function pointerReader(platform: PetMotionPlatform): () => Promise<Point | null> {
  return async (): Promise<Point | null> => {
    if (!platform.readPointer) return null
    try {
      const scaleFactor = scaleFactorOf(await platform.scaleFactor())
      const pointer = await platform.readPointer()
      return pointer
        ? { x: toLogical(pointer.x, scaleFactor), y: toLogical(pointer.y, scaleFactor) }
        : null
    } catch {
      return null
    }
  }
}

/** The pet's surroundings in logical pixels. Upstream `Environment` (`types.ts:21-27`). */
export interface MotionEnvironment {
  /** The monitor's work area (`types.ts:23`). */
  workArea: Rect
  /**
   * Window top edges, to climb along and to land on. Upstream carried each window's title too
   * (`types.ts:16-19`); no mode read it (`modes.ts:157-162`), so nothing asks for one.
   */
  surfaces: Rect[]
}

/** Windows thinner than this are not surfaces. Upstream `environment.ts:67`, in physical px. */
export const MIN_SURFACE_PX = 40
/** How long a read of the monitor, or of the windows, is reused. `environment.ts:34`, `:55`. */
export const ENVIRONMENT_CACHE_MS = 500

export interface EnvironmentReader {
  /** Null when the work area cannot be read; the caller then leaves the pet where it is. */
  read(): Promise<MotionEnvironment | null>
  /** Upstream `invalidateEnvironmentCache` (`environment.ts:76-79`): a display was plugged in. */
  invalidate(): void
}

/**
 * The work area and the climbable surfaces, cached half a second each.
 *
 * Upstream cached for a measured reason (`environment.ts:31-33`, `:51-54`): the tick runs at
 * 30 ms, so one monitor query plus one window enumeration per tick per pet is 2×N×33 IPC
 * calls a second. §7.3's 「不每帧读布局、发 IPC」 is that rule, kept here rather than left to
 * each platform implementation to remember.
 */
export function createEnvironmentReader(
  platform: PetMotionPlatform,
  now: () => number,
): EnvironmentReader {
  let monitor: { workArea: Rect; scaleFactor: number; ts: number } | null = null
  let surfaces: { rects: Rect[]; scaleFactor: number; ts: number } | null = null

  return {
    invalidate(): void {
      monitor = null
      surfaces = null
    },

    async read(): Promise<MotionEnvironment | null> {
      const ts = now()
      if (!monitor || ts - monitor.ts >= ENVIRONMENT_CACHE_MS) {
        try {
          const scaleFactor = scaleFactorOf(await platform.scaleFactor())
          const raw = await platform.readWorkArea()
          // A work area nobody could read is not a place to put a pet: upstream returned null
          // here (`environment.ts:85`), rather than substituting a screen size the way
          // `lib.rs:194` substituted 1920×1080.
          if (!raw) return null
          monitor = { workArea: rectToLogical(raw, scaleFactor), scaleFactor, ts }
        } catch {
          return null
        }
      }

      const scaleFactor = monitor.scaleFactor
      const stale =
        !surfaces || surfaces.scaleFactor !== scaleFactor || ts - surfaces.ts >= ENVIRONMENT_CACHE_MS
      if (platform.readWindowRects && stale) {
        try {
          // The 40 px filter is applied in physical pixels, as upstream applied it
          // (`environment.ts:67`), so the same window qualifies on every display.
          surfaces = {
            rects: (await platform.readWindowRects())
              .filter((rect) => rect.width > MIN_SURFACE_PX && rect.height > MIN_SURFACE_PX)
              .map((rect) => rectToLogical(rect, scaleFactor)),
            scaleFactor,
            ts,
          }
        } catch {
          // Keep the last list (`environment.ts:72-73`): an empty one would read as "this
          // desktop has no windows", which is a different statement.
        }
      }

      return { workArea: monitor.workArea, surfaces: surfaces?.rects ?? [] }
    },
  }
}
