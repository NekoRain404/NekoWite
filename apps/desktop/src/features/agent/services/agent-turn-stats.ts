/**
 * How long the last turn took, measured where the run's own edges are visible.
 *
 * **Nothing on the wire carries a duration.** The contract's `run-finished` is a stop reason and
 * the engine's token counters (`AgentRunResult`), the envelope carries no timestamp, and the
 * session's own `updatedAt` is written only when the engine volunteers a title. So the elapsed
 * half of Zed's turn stats (`thread_view.rs:6849-6870`: a clock and a token label under the
 * thread's last entry) can only be this window's own stopwatch over the run it watched.
 *
 * That is exactly what this is: two moments the *view* states — a run became live, a run stopped
 * being live — and the difference between them. It is deliberately not a timer: no interval, no
 * `stopwatch.tick()`, nothing that redraws a number while the reader is reading. The clock in the
 * bar is the last finished turn's, and it changes when a turn ends.
 *
 * **A turn this window did not see begin has no duration**, and the honest answer for it is an
 * absence rather than a partial number: a panel mounted mid-run, or remounted after one, starts
 * watching at the moment it mounts. That is why {@link noteRunState} only moves on a
 * *transition*: a caller that starts from {@link INITIAL_AGENT_TURN_CLOCK} and feeds it the
 * state it observes measures whole turns or nothing.
 *
 * Time is a parameter and never read here, so the policy is testable without waiting — the same
 * rule `agent-session-history.ts`'s ages follow, and for the same reason.
 */

export interface AgentTurnClock {
  /** When the live run began, in the caller's own time base, or null while none is in flight. */
  startedAt: number | null
  /**
   * The last finished turn's wall-clock duration, in milliseconds, or null when this window has
   * not watched one end. Null is "not measured", never zero: a zero would read as an instant
   * turn, and the run that produced it was not measured at all.
   */
  lastMs: number | null
}

export const INITIAL_AGENT_TURN_CLOCK: AgentTurnClock = { startedAt: null, lastMs: null }

/**
 * The clock after a run was observed to be live (`true`) or not (`false`) at `now`.
 *
 * Only the two transitions do anything:
 *
 *  - **not live → live** starts the stopwatch. A second `true` while one is already running is
 *    the same statement twice — a view re-render, a state word changing from `running` to
 *    `waiting-permission` and back — and restarting on those would report the reader's own pause
 *    rather than the turn.
 *  - **live → not live** stops it and keeps the difference as `lastMs`. That is the run ending,
 *    whatever ended it: a finished turn, a refusal, a cancel. A run that never became live does
 *    not stop a stopwatch that is not running, and the previous measurement is left alone —
 *    `lastResult` is kept across a cancelled run for the same reason.
 */
export function noteRunState(clock: AgentTurnClock, live: boolean, now: number): AgentTurnClock {
  if (live) {
    if (clock.startedAt !== null) return clock
    return { startedAt: now, lastMs: clock.lastMs }
  }
  if (clock.startedAt === null) return clock
  // A run that "ended" before it started — a clock that went backwards, which a wall-clock
  // adjustment can do — is refused rather than reported as a negative duration.
  const elapsed = now - clock.startedAt
  return { startedAt: null, lastMs: elapsed >= 0 ? elapsed : null }
}

/**
 * A duration as the numbers a sentence is built from: whole seconds, split the way
 * `duration_alt_display` splits them.
 *
 * Translated from Zed's `crates/util/src/time.rs:3-15` — hours, minutes and seconds, always
 * whole, `1h 2m 3s` / `2m 3s` / `45s` — with the words left to the catalogue, because the
 * sentence around these numbers is the panel's own.
 *
 * Sub-second turns round down to `0s`, which is the whole of the information there is: the
 * reading is a wall clock, and a tenth of a second would claim a precision this measurement does
 * not have. Zed's own answer to a short turn is a threshold that hides the stats entirely
 * (>30s, `conversation_view.rs:107`); this panel shows them for every turn it measured, because
 * the tokens are drawn for every turn the engine reported and a clock that appeared only
 * sometimes would read as a clock that was broken.
 */
export function turnDurationParts(ms: number): { hours: number; minutes: number; seconds: number } {
  const total = Math.max(0, Math.floor(ms / 1000))
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  }
}
