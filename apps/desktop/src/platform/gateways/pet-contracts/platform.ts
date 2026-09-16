/**
 * What this machine can actually do, and what happens where it cannot (§7.2).
 *
 * A capability that is not available cannot be reported here without also stating its
 * fallback and its reason: the finding's two arms make the alternative unwritable, which
 * is the structural form of §7.2's 「不伪装已支持」. The upstream app substitutes a value
 * and carries on instead — `unwrap_or((1920.0, 1080.0))` for a monitor it could not read
 * (`windows/src-tauri/src/lib.rs:194`), and, off Windows, an empty window list
 * (`sys_windows.rs:128-129`) that climb mode then treats as a surface
 * (`windows/src/roam/modes.ts:154`).
 */

/** §7.2's rows, as the capabilities a host reports on rather than assumes. */
export const PET_CAPABILITIES = [
  'window-transparency',
  'window-borderless',
  'always-on-top',
  'no-focus-steal',
  'drag',
  'position-restore',
  /**
   * Click-through at the compositor. Not the same claim as knowing which pixel of a
   * sprite is opaque: §7.2 forbids presenting pixel hit-testing as system
   * pass-through, and the two need different machinery on every platform.
   */
  'pointer-passthrough',
  'pointer-follow',
  /** Needs the window list, which upstream implements for Windows only. */
  'window-climb',
  'system-notification',
  /** Whether a notification can carry an action at all — §7.2 forbids showing one that cannot. */
  'notification-actions',
] as const

export type PetCapability = (typeof PET_CAPABILITIES)[number]

/**
 * What the product does where a capability is not available, taken from §7.2's third
 * column. A closed vocabulary because a fallback has to be something a component can
 * render and a test can assert; free text here would become an unexplained sentence in
 * a settings page.
 */
export type PetFallback =
  /** The capability is there; nothing is substituted. */
  | 'none'
  /** The pet lives in the app window instead of a floating one. */
  | 'docked-window'
  /** A plain decorated window, with the environment limit stated. */
  | 'closable-window'
  /** Dragging falls back to moving a window the compositor moves, and to staying on a visible area. */
  | 'clamped-position'
  /** A small window that takes clicks itself, instead of passing them through. */
  | 'compact-window'
  /** Roaming is off; the pet stays where it is. */
  | 'stay-only'
  /** No toast; the unread list is the surface that remains. */
  | 'unread-list'
  /** The feature is absent rather than imitated. */
  | 'not-offered'

/**
 * A capability's status and, unless it is available, what happens instead.
 *
 * The union is the enforcement of §7.2: `degraded`, `unavailable` and `unverified` all
 * *require* a fallback and a detail, so a host cannot report a capability as
 * unavailable and leave the user to guess, and cannot report one as present while
 * quietly substituting something. `unverified` is a status of its own rather than a
 * synonym for `unavailable` because the two are different claims and neither may stand
 * in for the other: nothing on this machine has been measured yet (§12, D13), and
 * calling that "unsupported" would be as wrong as calling it "supported".
 */
export type PetCapabilityFinding =
  | { status: 'available' }
  | {
      status: 'degraded' | 'unavailable' | 'unverified'
      fallback: PetFallback
      /** The environment limit in words a user can act on, not an error code. */
      detail: string
    }

/**
 * A finding, named.
 *
 * The finding is nested rather than merged into the report's own type, so that a
 * caller reads `report.finding.status` and narrows a plain union: a report whose arms
 * were an intersection of the finding with `{ capability }` would narrow less
 * dependably, and the one thing this type has to do is make the `unavailable` arm
 * reachable — that arm is the whole point of §7.2.
 */
export interface PetCapabilityReport {
  capability: PetCapability
  finding: PetCapabilityFinding
}
