/**
 * The simulated-call policy the in-memory adapters share.
 *
 * Being able to break a call on purpose is half of what this test double is
 * for: an injected failure drives the error path a real backend would take, and
 * an injected delay (driven with fake timers) models a backend that has not
 * answered yet — a timeout, or a slow command the UI must stay usable during.
 *
 * Both the fs and the AI adapter implement that policy the same way — wait out
 * the delay, raise the injected error, then run the real work — so it is stated
 * here once. The order matters and is the whole policy: the error is raised
 * *before* the work runs, so a simulated failure leaves no side effect, exactly
 * like a command the backend rejected.
 */

/** What one simulated call has been told to do. */
export interface MemoryFault {
  /** Fail the call with this error, or a factory building a fresh one per call
   * (so a test can assert on distinct instances). */
  fail?: Error | (() => Error)
  /** Artificial latency (ms) before the call settles. */
  delayMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Settle one simulated call. The fs gateway resolves `fault` per method (its
 * `fail` map is keyed by method name); the AI gateway passes its options whole,
 * because its one call is the whole port. */
export async function simulateCall<T>(
  fault: MemoryFault,
  call: () => T | Promise<T>,
): Promise<T> {
  if (fault.delayMs) await sleep(fault.delayMs)
  const err = fault.fail
  if (err) throw typeof err === 'function' ? err() : err
  return call()
}
