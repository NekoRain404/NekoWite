/**
 * The vocabulary the rest of the motion is written in: the settings it reads, what the pet
 * is doing, and the timers it runs on.
 *
 * Ported from `references/desktop-pet/windows/src/roam/types.ts` (the roam configuration,
 * `:101-115`) and `roam/engine.ts` (`setMood`, `:44-57`, and its `sleeping` flag `:44-46`)
 * at commit `be171a01273a1ed92a27bcdf72f8a58768bac421`.
 *
 * What the port changed, and why:
 *   - Configuration is the contract's settings (`PetSettingsValues.view.roam`,
 *     `general.motion`) rather than three `localStorage` keys, and the mood is a closed
 *     three-value vocabulary rather than a free string compared against two literals
 *     (`engine.ts:49,54`). An unknown mood upstream silently meant "keep roaming".
 *   - Upstream cached the parsed config for the 30 ms tick and invalidated it from a
 *     `storage` event (`types.ts:85-124`). A caller-supplied value needs neither: there is
 *     nothing to cache and no listener to leak.
 */
import type { PetTaskAlert, PetRoamMode } from '../../../platform/gateways/pet-contracts'
import { WIN_H, WIN_W, type Point, type Rect } from './pet-physics'

/** Keep clear of the screen edges when picking a destination. Upstream `types.ts:41`. */
export const MARGIN = 40
/** How long a wandering or climbing pet rests when it arrives or turns around. `types.ts:43-44`. */
export const IDLE_MS_MIN = 1200
export const IDLE_MS_MAX = 3500

/** Speed 1..10 as px/s. Upstream `pxPerSec` (`types.ts:133-135`): 40 px/s to 490 px/s. */
export function pxPerSec(speed: number): number {
  return 40 + speed * 45
}

/**
 * The pet's position, kept inside the work area. Upstream `clampToBounds` (`types.ts:126-131`).
 *
 * The bounds carry the monitor's origin, which is negative for a display left of the primary
 * one, so nothing here may assume zero.
 */
export function clampToBounds(position: Point, bounds: Rect): Point {
  return {
    x: Math.max(bounds.left, Math.min(bounds.right - WIN_W, position.x)),
    y: Math.max(bounds.top, Math.min(bounds.bottom - WIN_H, position.y)),
  }
}

/** Upstream's four modes (`types.ts:5`), `cursor` under the contract's name for it. */
export const PET_ROAM_BEHAVIOURS = ['stay', 'wander', 'follow-pointer', 'climb'] as const
export type PetRoamBehaviour = (typeof PET_ROAM_BEHAVIOURS)[number]

/**
 * The contract's stored modes as behaviours. `off` is roaming off; `stay` stands still.
 *
 * `PetRoamMode` has no `wander` (`pet-contracts/config.ts:39`) — upstream's *default* mode
 * (`types.ts:108`) and the only one needing nothing from the desktop. That is a gap in D1's
 * vocabulary, reported rather than patched here: until the stored mode gains a value for it
 * nothing reaches `'wander'`, and this table is the one line such a fix has to change.
 */
export const ROAM_BEHAVIOUR_BY_MODE: { [M in PetRoamMode]: PetRoamBehaviour | null } = {
  off: null,
  stay: 'stay',
  'follow-pointer': 'follow-pointer',
  climb: 'climb',
}

/** The roam speed when nothing usable was stored. Upstream's `|| "5"` (`types.ts:112`). */
export const DEFAULT_ROAM_SPEED = 5

/**
 * A stored roam speed, or the default.
 *
 * Upstream clamped the range but read the value with `parseInt` and no finiteness guard
 * (`types.ts:112`), so a stored `"fast"` became a `NaN` speed and reached the physics; D1's
 * report records it. The rule here is the contract's rule for stored numbers
 * (`pet-contracts/config.ts:171`, `readPetNumber`): outside the range means the setting is
 * corrupt and the default applies, rather than being read as a request to go faster.
 */
export function motionSpeed(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return DEFAULT_ROAM_SPEED
  if (raw < 1 || raw > 10) return DEFAULT_ROAM_SPEED
  return raw
}

/** What the engine reads from the settings, every tick — upstream `loadConfig()` (`types.ts:101`). */
export interface PetMotionSettings {
  /** `PetSettingsValues.view.roam`. */
  roam: PetRoamMode
  /** Upstream's `ap_roam_speed`, 1..10. Validated by {@link motionSpeed}. */
  speed?: number
  /** `PetSettingsValues.general.motion`. §7.3: reduced motion stops roaming. */
  motion: 'system' | 'reduced'
}

/**
 * What the pet is doing, as far as its movement is concerned.
 *
 * Upstream's `setMood` took a free string (`engine.ts:54`) compared against two literals
 * (`engine.ts:49`), so an unknown mood quietly meant "keep roaming". These three are
 * upstream's four moods plus its celebrate transient, named for what the engine does with
 * them:
 *
 *   - `idle`  — upstream `idle`: roam, and doze off if nothing moves for a while
 *   - `busy`  — upstream `working` / `done`: roam, but do not doze
 *   - `alert` — upstream `waiting` / `celebrate`: hold still while the user reads
 *
 * `alert` covering both is §3.1-3 rather than upstream: a pending permission must be
 * visible instead of hidden behind another task's work, and the celebrate burst is the same
 * "look at this". A caller holding D1's task states maps them through `PET_ALERT_BY_STATE`
 * and then {@link motionMoodForAlert}.
 */
export type PetMotionMood = 'idle' | 'busy' | 'alert'

/** D1's alert axis (`pet-contracts/task.ts:95-122`), as a mood. `null` means nothing to show. */
export function motionMoodForAlert(alert: PetTaskAlert | null): PetMotionMood {
  if (alert === null) return 'idle'
  return alert === 'quiet' ? 'busy' : 'alert'
}

/** Timers, in the shape the sprite player already takes (`rendering/animation-bindings.ts:27`). */
export interface MotionClock {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(handle: number): void
}

export const systemClock: MotionClock = {
  // The globals are read at call time, so a test that fakes them fakes this clock too.
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
}

/** One tick's answer: whether the pet is moving, and how long to wait for the next one. */
export interface MotionTick {
  active: boolean
  delayMs: number
}
