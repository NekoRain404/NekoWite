/* ------------------------------------------------------------------------- *
 * What the host tracks about activations: the ones in flight, and the session
 * budget they consume.
 *
 * Both facts belong to the host rather than to a single activation, and both
 * have to be readable from a call that is NOT the activation — `deactivatePlugin`
 * (the user switching a plugin off, a vault teardown) runs on a later tick, and
 * only what was registered BEFORE the first await is visible there. Keeping the
 * registrations in the module that owns them, instead of inline in the
 * activation, is what lets a teardown cancel an activation that has not finished
 * rather than finding nothing to take down.
 *
 * The state is module-global on purpose: there is one host, and the cap, the
 * session budget and the in-flight set are all facts about it.
 * ------------------------------------------------------------------------- */

/** Default cumulative wall-clock budget (ms) a plugin may consume on activation
 *  work during a session before it is quarantined. */
export const DEFAULT_PLUGIN_SESSION_QUOTA_MS = 15000

/** Default max number of plugins activating concurrently in the host. */
export const DEFAULT_MAX_IN_FLIGHT_ACTIVATIONS = 4

let sessionQuotaMs = DEFAULT_PLUGIN_SESSION_QUOTA_MS
let maxInFlightActivations = DEFAULT_MAX_IN_FLIGHT_ACTIVATIONS
let inFlightCount = 0
const sessionUsageMs = new Map<string, number>()

/** Configure the per-plugin per-session wall-clock budget (ms). */
export function setPluginSessionQuota(ms: number): void {
  sessionQuotaMs = ms
}

/** The current per-plugin per-session wall-clock budget (ms). */
export function getPluginSessionQuota(): number {
  return sessionQuotaMs
}

/** Configure the max number of concurrent in-flight activations. */
export function setMaxInFlightActivations(n: number): void {
  maxInFlightActivations = n
}

/** The current max concurrent activation cap. */
export function getMaxInFlightActivations(): number {
  return maxInFlightActivations
}

/** How many activations are currently in flight (awaiting an async init). */
export function getInFlightActivationCount(): number {
  return inFlightCount
}

/** A plugin's recorded cumulative activation wall-clock for the session (ms). */
export function getPluginSessionUsage(id: string): number {
  return sessionUsageMs.get(id) ?? 0
}

/** Reset a plugin's recorded session usage (grants a fresh budget). Used by
 *  `resetUnstablePlugin` so re-approval is a genuine fresh start. */
export function resetPluginSessionUsage(id: string): void {
  sessionUsageMs.delete(id)
}

/** Add the elapsed activation wall-clock to a plugin's session budget. Returns
 *  the new cumulative total. Guarded so a bad clock never throws. */
export function addSessionUsage(id: string, startedAt: number): number {
  const now = Date.now()
  const elapsed = Math.max(0, now - startedAt)
  const total = (sessionUsageMs.get(id) ?? 0) + elapsed
  sessionUsageMs.set(id, total)
  return total
}

/** An activation that has started but has neither committed nor rolled back.
 *
 *  It is registered BEFORE the awaited init (which is the only moment a teardown
 *  can still reach it) and holds the plugin id until `release`, so a second
 *  activation of the same id cannot start in the meantime and register the same
 *  commands and hooks a second time. */
export interface InFlightActivation {
  /** Thread into the awaited init: aborts when a teardown cancels this
   *  activation, and when the caller's own signal fires. */
  readonly signal: AbortSignal
  /** True once a teardown cancelled it. The activation rolls its registrations
   *  back and must not commit (or quarantine itself) after that. */
  cancelled(): boolean
  /** Cancel it. */
  cancel(): void
  /** Give the slot and the id back. Exactly once, from the activation's
   *  `finally` — every other path (commit, timeout, crash, cancel) goes through
   *  it. */
  release(): void
}

const inFlight = new Map<string, InFlightActivation>()

/** Register an activation of `id` as in flight, composing the caller's own
 *  AbortSignal with the host's. Returns null when the concurrent-activation cap
 *  is already reached, in which case nothing was registered. */
export function beginInFlightActivation(
  id: string,
  external?: AbortSignal,
): InFlightActivation | null {
  if (inFlightCount >= maxInFlightActivations) return null
  inFlightCount++
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  external?.addEventListener('abort', forwardAbort, { once: true })
  let released = false
  let cancelled = false
  const entry: InFlightActivation = {
    signal: controller.signal,
    cancelled: () => cancelled,
    cancel: () => {
      if (released || cancelled) return
      cancelled = true
      controller.abort()
    },
    release: () => {
      if (released) return
      released = true
      external?.removeEventListener('abort', forwardAbort)
      // Identity-checked, so a late release can never evict a newer registration.
      if (inFlight.get(id) === entry) inFlight.delete(id)
      if (inFlightCount > 0) inFlightCount--
    },
  }
  inFlight.set(id, entry)
  return entry
}

/** True while an activation of `id` is in flight — including one already
 *  cancelled and unwinding. A second activation must not start while this holds:
 *  the registrations it would make are keyed by name/id in a global registry, so
 *  two overlapping activations of one id cannot both own them (the loser's
 *  rollback would remove the winner's components). */
export function isActivationInFlight(id: string): boolean {
  return inFlight.has(id)
}

/** Cancel the in-flight activation of `id`, if any. Returns whether there was
 *  one: the caller's teardown has already been done, and the activation's own
 *  rollback releases its registrations when its await settles. */
export function cancelInFlightActivation(id: string): boolean {
  const entry = inFlight.get(id)
  if (!entry) return false
  entry.cancel()
  return true
}
