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

import { getSharedGateways } from '../../../platform/runtime/gatewayRuntime'
import { markThinking } from './ai-thinking'

type ListenerCleanup = () => void

let cleanups: ListenerCleanup[] = []

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
 *  already registered — no partially-registered listener leaks. */
export function trackListener(off: ListenerCleanup): void {
  cleanups.push(off)
}

export function cleanupListeners(): void {
  cleanups.forEach((fn) => {
    try {
      fn()
    } catch {
      // ignore teardown failures
    }
  })
  cleanups = []
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
  cleanupListeners()
  markThinking(false)
}
