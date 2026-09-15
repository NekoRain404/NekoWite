/**
 * The registry of in-flight AI streams, shared by both request lifecycles.
 *
 * The ghost writer and every chat-shaped completion run the same bookkeeping,
 * and it has to be the SAME bookkeeping: `cancelStream` exists to drop
 * everything at once (a new trigger, or a Stop), and it can only do that if
 * both lifecycles publish their work into one id set, one listener list and one
 * generation counter. Splitting them per lifecycle would give each its own
 * half of a problem that is global by nature.
 *
 * The gate is not here — see `ai-gate.ts`. This module is command only
 * (§13.4): it starts, tracks and tears down, and holds no state a caller reads
 * back except the request id and generation it was just handed.
 */

import { getSharedGateways } from '../../../platform/runtime/gateway-runtime'
import { markThinking } from './ai-thinking'

type ListenerCleanup = () => void

/** One registered listener, and the generation of the request that registered
 *  it. The generation is the OWNERSHIP mark: it is what lets that request
 *  detach its own later without touching anyone else's (see
 *  [`cleanupListeners`]). */
interface TrackedListener {
  generation: number
  off: ListenerCleanup
}

let cleanups: TrackedListener[] = []

/**
 * Ids of the requests this window has started and not yet finished.
 *
 * The FRONTEND picks these, before the request is sent, because the backend
 * cannot be cancelled by an id nobody knows yet: a reasoning model stays silent
 * for seconds (measured: ~27 reasoning deltas before the first answer), and
 * during that window a backend-chosen id meant Stop had nothing to cancel — the
 * abandoned request kept streaming, and its late chunks were then adopted by
 * the next request and shown as its answer. Owning the id up front also lets
 * every handler accept only its own events, so one stream can never write into
 * another.
 */
const activeIds = new Set<string>()
let requestSeq = 0

/** A fresh request id. Unique per request without depending on the clock alone. */
export function nextRequestId(): string {
  requestSeq += 1
  return `ai-${Date.now().toString(36)}-${requestSeq}`
}

/** Claim an id for the stream that was just started, so a Stop during the
 *  silent phase still has something to cancel. */
export function trackRequest(id: string): void {
  activeIds.add(id)
}

/** The request reached a terminal event (or its stream was abandoned): it must
 *  not be cancelled a second time. */
export function releaseRequest(id: string): void {
  activeIds.delete(id)
}

// Incremented by every trigger/accept/reject; events and listener
// registrations from a superseded trigger are ignored, so a stale stream can
// never write into the current one.
let streamSeq = 0

/**
 * Start a new generation and hand it to its owner.
 *
 * The returned value is the caller's proof of currency: every event handler
 * checks it before acting, so a superseded stream's late chunk cannot land in
 * the editor or the chat. Callers that only mean to invalidate the running
 * streams (accept/reject) ignore the return.
 */
export function bumpStreamGeneration(): number {
  streamSeq += 1
  return streamSeq
}

/** Whether `generation` is still the current one. */
export function isSuperseded(generation: number): boolean {
  return generation !== streamSeq
}

/** Track a registered listener as it goes in, so a mid-registration rejection
 *  (e.g. the event system failing on `ai-done`) still cleans up the ones that
 *  already registered — no partially-registered listener leaks.
 *
 *  `generation` is the value [`bumpStreamGeneration`] handed the request doing
 *  the registering. It is recorded, not checked: the check happens when the
 *  listeners come out again. */
export function trackListener(off: ListenerCleanup, generation: number): void {
  cleanups.push({ generation, off })
}

/**
 * Detach the listeners of ONE request — the ones that went in under
 * `generation` — and nobody else's.
 *
 * The registry is single-owner by construction: every lifecycle starts by
 * cancelling what was running and bumping the generation, so its contents at
 * any moment are the CURRENT request's listeners. That is why a request that
 * fails after it has been replaced must not sweep the registry: by then those
 * entries belong to its successor, and the sweep detached the live request's
 * listeners — the answer the user was watching stopped arriving, with no error
 * and nothing to explain it. Naming a generation that registered nothing is a
 * no-op, which is what makes this safe to call from an already-replaced
 * request.
 */
export function cleanupListeners(generation: number): void {
  const remaining: TrackedListener[] = []
  for (const entry of cleanups) {
    if (entry.generation !== generation) {
      remaining.push(entry)
      continue
    }
    try {
      entry.off()
    } catch {
      // ignore teardown failures
    }
  }
  cleanups = remaining
}

/**
 * Detach every listener this window is holding, whatever generation it belongs
 * to.
 *
 * Only the app-level cancel may do this, and only because it is the one path
 * that ALSO bumps the generation: nothing that was relying on these listeners
 * is still running by the time they go. [`cancelStream`] is its only caller —
 * a lifecycle detaching its own uses [`cleanupListeners`] with its generation,
 * which is why the dangerous sweep is not the same function name a caller can
 * reach for by accident.
 */
function detachAllListeners(): void {
  const all = cleanups
  cleanups = []
  for (const entry of all) {
    try {
      entry.off()
    } catch {
      // ignore teardown failures
    }
  }
}

export function cancelStream(): void {
  // Invalidate the running streams' handlers, not just unregister them: an
  // event already in flight can still be delivered to a callback that is about
  // to be detached, and a cancelled request must never write its answer into
  // the editor or the chat.
  streamSeq++
  for (const id of activeIds) {
    void Promise.resolve(getSharedGateways().ai.cancel(id)).catch(() => undefined)
  }
  activeIds.clear()
  detachAllListeners()
  markThinking(false)
}
