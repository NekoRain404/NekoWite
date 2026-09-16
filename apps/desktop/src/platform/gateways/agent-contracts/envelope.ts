/**
 * The envelope: the identity, the host bookkeeping and the correlation that make a
 * payload an event.
 *
 * Split from `payloads.ts` only in the sense that this is what stays the same when
 * a kind is added; the two are one vocabulary, and the barrel re-exports both.
 */

import type { AgentEventKind, AgentPayloads } from './payloads'

/**
 * The identity every event, snapshot and permission answer is validated against
 * (§6.2).
 *
 * These five travel together because they answer different questions and a
 * well-formed event can still be wrong in any one of them: two agents can use the
 * same session id (the plan's multi-agent boundary rests on telling those apart), a
 * restarted runtime looks exactly like the previous one, and an event from the vault
 * the user just left is a valid event from a session this window no longer shows. A
 * runtime instance is bound to agent, profile, vault and epoch; a session is bound
 * to all five.
 */
export interface AgentIdentity {
  agentId: string
  profileId: string
  runtimeEpoch: string
  vaultId: string
  sessionId: string
}

/**
 * One host event, generic over its payload so a producer has to state what it built.
 * Subscribers never hold this type: they receive {@link AgentEvent}, where `kind` and
 * `payload` are correlated, so no component has to read an untyped payload and decide
 * for itself what it might be.
 */
export interface AgentEventEnvelope<T> extends AgentIdentity {
  /**
   * The turn this belongs to, or null for events that are no turn's own —
   * `commands-changed` arrives outside any run.
   */
  runId: string | null
  /**
   * Host-assigned, per session, strictly increasing. A consumer uses it to tell a
   * replay from a live event, to notice a gap instead of silently stitching two
   * non-adjacent parts of a stream together, and to drop a duplicate.
   */
  sequence: number
  kind: AgentEventKind
  payload: T
}

/**
 * A validated event, and the type every consumer works with: `switch (event.kind)`
 * narrows `payload` to that kind's type, so the `unknown` the plan forbids from
 * reaching a component is never introduced in the first place.
 */
export type AgentEvent = {
  [K in AgentEventKind]: AgentEventEnvelope<AgentPayloads[K]> & { kind: K }
}[AgentEventKind]
