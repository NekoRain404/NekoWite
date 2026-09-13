/**
 * A bounded, persisted record of what the AI asked for and what the user (or
 * the policy) answered.
 *
 * The permission model already decides writes; what it could not do was answer
 * "what has this app been doing with my key?" a day later. Writes are the
 * interesting events: an insert that was allowed, a selection rewrite that was
 * refused, a request that never went out because AI was switched off. Reading
 * the log is how a user checks that the policy they chose is the policy in
 * force, and it is also what makes a refusal visible after the toast is gone.
 *
 * Shape mirrors the plugin audit ring (`@nekowite/plugin-host` governance) so
 * the app has ONE audit idiom: monotonic `seq`, an epoch timestamp, a small
 * closed set of outcomes, and a REDACTED `detail`. Detail is sanitized with the
 * plugin host's own redactor rather than a second one, because a second
 * implementation is a second chance to leak a key.
 *
 * Storage: the ring lives in memory and is mirrored through the `persistence`
 * port. A vault file would be the wrong home here - a refusal happens just as
 * often with no vault open (AI switched off on a fresh install), and the log
 * must survive a restart either way. It holds no note content: the summary is
 * the plugin/feature name plus the kind of write, never the text.
 *
 * Nothing here throws. An audit trail that can break the feature it observes is
 * worse than no audit trail: every entry point is best-effort.
 */

import { sanitizeAuditDetail } from '@nekowite/plugin-host'
import type { AiWriteKind, AiWriteSource } from './aiPermissions'

/** What the AI asked to do, and how it ended.
 *
 *  `allowed` / `denied` are answers to a question the user actually saw;
 *  `asked` marks the moment a question went on screen; `blocked` means no
 *  question was possible because the policy (or the master switch) already
 *  refused it; `granted` records a session grant being remembered, which is the
 *  step that lets later writes through without asking. */
export type AiAuditOutcome = 'asked' | 'allowed' | 'denied' | 'blocked' | 'granted'

export interface AiAuditEvent {
  /** Monotonic within a session; continues past whatever was loaded. */
  seq: number
  /** Epoch milliseconds. */
  at: number
  source: AiWriteSource
  outcome: AiAuditOutcome
  kind?: AiWriteKind
  /** Redacted, human-readable context (which plugin, what was refused). */
  detail?: string
  /** Which policy/setting produced the outcome, for blocked entries. */
  reason?: string
}

export interface AiAuditInput {
  source: AiWriteSource
  outcome: AiAuditOutcome
  kind?: AiWriteKind
  detail?: string
  reason?: string
}

/** How many entries are kept. Enough to answer "what happened while I was
 *  away" without turning the log into a data store of its own. */
export const MAX_AI_AUDIT_EVENTS = 200

/** Upper bound on a stored detail string, so one pathological caller cannot
 *  push the mirrored blob past the storage quota. */
const MAX_DETAIL_CHARS = 200

let seq = 0
let ring: AiAuditEvent[] = []
const listeners = new Set<(event: AiAuditEvent) => void>()

/** Record one event. Returns the stored record (with its assigned seq/at). */
export function recordAiAudit(input: AiAuditInput): AiAuditEvent {
  const detail = sanitizeAuditDetail(input.detail)?.slice(0, MAX_DETAIL_CHARS)
  const event: AiAuditEvent = {
    seq: ++seq,
    at: Date.now(),
    source: input.source,
    outcome: input.outcome,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(detail ? { detail } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  }
  ring.push(event)
  if (ring.length > MAX_AI_AUDIT_EVENTS) ring.splice(0, ring.length - MAX_AI_AUDIT_EVENTS)
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // Isolation, exactly like the plugin ring: a subscriber that throws must
      // not stop delivery to the others.
    }
  }
  return event
}

/** Every kept event, oldest first. A copy: the ring keeps changing. */
export function getAiAuditLog(): AiAuditEvent[] {
  return [...ring]
}

/** Drop the in-memory ring and restart sequence numbering at 1. */
export function clearAiAuditLog(): void {
  ring = []
  seq = 0
}

/** Subscribe to new events. Returns an unsubscribe function. */
export function onAiAudit(listener: (event: AiAuditEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The mirrored form written through the persistence port. */
export function serializeAiAuditLog(): string {
  try {
    return JSON.stringify({ version: 1, events: ring })
  } catch {
    return JSON.stringify({ version: 1, events: [] })
  }
}

/**
 * Restore a mirrored log. Corruption is not an error: a blob we cannot read is
 * treated as "no history", never as a reason to fail startup. Entries are
 * de-duplicated by `seq` so a reload cannot double-count, and the sequence
 * counter continues past the highest restored value so new entries stay
 * distinct from restored ones.
 */
export function loadAiAuditLog(raw: string | null | undefined): number {
  if (!raw) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 0
  }
  const events = (parsed as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return 0
  const seen = new Set<number>()
  const restored: AiAuditEvent[] = []
  for (const item of events) {
    const e = item as Partial<AiAuditEvent> | null
    if (!e || typeof e !== 'object') continue
    if (typeof e.seq !== 'number' || typeof e.at !== 'number') continue
    if (typeof e.source !== 'string' || typeof e.outcome !== 'string') continue
    if (seen.has(e.seq)) continue
    seen.add(e.seq)
    restored.push({
      seq: e.seq,
      at: e.at,
      source: e.source as AiWriteSource,
      outcome: e.outcome as AiAuditOutcome,
      ...(typeof e.kind === 'string' ? { kind: e.kind as AiWriteKind } : {}),
      ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
      ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    })
  }
  restored.sort((a, b) => a.seq - b.seq || a.at - b.at)
  ring = restored.slice(-MAX_AI_AUDIT_EVENTS)
  seq = ring.reduce((max, e) => Math.max(max, e.seq), 0)
  return ring.length
}

/** Counts per outcome, for a one-line summary in the settings panel. */
export function summarizeAiAudit(events: readonly AiAuditEvent[] = ring): Record<AiAuditOutcome, number> {
  const counts: Record<AiAuditOutcome, number> = { asked: 0, allowed: 0, denied: 0, blocked: 0, granted: 0 }
  for (const e of events) {
    if (counts[e.outcome] !== undefined) counts[e.outcome] += 1
  }
  return counts
}
