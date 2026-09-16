/**
 * The gateway surface: what the application calls, and the state it reads back.
 *
 * These types are the boundary between `features/agent` and whichever adapter is
 * behind it — the real one (`tauri-agent.ts`) and the test double
 * (`memory-agent.ts`) are interchangeable here, so nothing in this file may
 * describe how the runtime is reached.
 */

import type { AgentEvent, AgentIdentity } from './envelope'
import type { AgentRunResult } from './payloads'

/**
 * The session lifecycle, exactly as the plan spells it out:
 * `idle -> starting -> ready -> running -> waiting-permission -> running ->
 * completed | cancelled | failed`.
 *
 * `waiting-permission` is a state of its own rather than a flag on `running`
 * because it is the state the user acts on: the turn is suspended, the answer is
 * the only thing that moves it forward, and cancelling from it has to be possible
 * (§6.2). The three terminal states say how the last turn ended and stay until
 * the next prompt starts. `idle` and `starting` describe the runtime before any
 * session exists, so an open session's snapshot never reports them; a runtime
 * that died mid-turn reports `failed` through the `run-failed` event, which is
 * the record that survives the process.
 */
export type AgentSessionState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'running'
  | 'waiting-permission'
  | 'completed'
  | 'cancelled'
  | 'failed'

/**
 * A model the engine offers for a session — the `configOptions` entry P0 measured
 * arriving with `session/new` (§2.2).
 */
export interface AgentModelOption {
  id: string
  name: string
}

declare const sessionOwnership: unique symbol

/**
 * A session the gateway opened.
 *
 * The brand is load-bearing rather than decorative: session ids are minted by the
 * gateway, and a caller that could write one would be able to address a session
 * it never opened — the plan's 「不能编造 sessionId」. The identity is carried on
 * the handle instead of being implicit in "the gateway" so a consumer can
 * validate an event, a snapshot or a permission answer against the session it is
 * about without asking anyone what it is talking to.
 */
export interface AgentSession extends AgentIdentity {
  readonly [sessionOwnership]: never
  /** The catalog the engine offered when the session opened. */
  readonly models: AgentModelOption[]
  /**
   * The model the session opened with. The caller tracks later changes:
   * {@link AgentGateway.selectModel} moves the runtime's current value and nothing
   * pushes the new one back.
   */
  readonly initialModelId: string
}

export interface AgentOpenRequest {
  /**
   * The vault the session works in. It becomes part of the event identity, which
   * is what lets a window reject the events of a vault the user has left.
   */
  vaultId: string
  /**
   * The directory the engine runs in — the vault root on disk. The engine
   * resolves the relative paths of everything it reads and writes against it, so
   * opening a session with the wrong one points a turn at the wrong tree.
   */
  cwd: string
}

/**
 * A point-in-time view of a session, and the point a subscription continues from.
 *
 * The snapshot exists to close the window between mounting UI and receiving
 * events (§6.2). `sequence` is the last sequence included in `events`, and
 * {@link AgentGateway.subscribe} takes the snapshot itself, so there is no way to
 * subscribe without saying where the subscriber's state currently ends: an event
 * that happens after the snapshot is either still in the replay buffer or is
 * reported as `buffer-conflict`, and never silently skipped.
 */
export interface AgentSessionSnapshot {
  identity: AgentIdentity
  state: AgentSessionState
  /**
   * The turn this snapshot's state refers to — the one in flight, or the one that
   * just ended. null before the session's first prompt.
   */
  runId: string | null
  /**
   * Sequence of the last event in `events`, or 0 when the session has emitted
   * nothing yet. A subscription continues at `sequence + 1`.
   */
  sequence: number
  /** The bounded replay tail, oldest first. */
  events: AgentEvent[]
  /**
   * Permission requests still waiting for an answer, carried as whole events so
   * the run and the identity they belong to survive with them.
   *
   * They are listed apart from `events` because they are not merely the tail of a
   * stream: a request that fell out of the replay buffer would leave a turn nobody
   * can end, so unanswered requests are never evicted and never dropped (§6.2
   * 「背压不能丢权限请求」).
   */
  permissions: Extract<AgentEvent, { kind: 'permission-request' }>[]
}

/**
 * What the application calls.
 *
 * Every method takes a session handle rather than an id, so a call can only
 * address a session this gateway opened, and every session-scoped method rejects
 * with `session-stale` when the handle belongs to a runtime instance that is no
 * longer the live one.
 */
export interface AgentGateway {
  /**
   * Bring the runtime up. A new runtime instance is a new `runtimeEpoch`, which is
   * what makes the events of the previous one identifiable as stale instead of
   * indistinguishable from live ones.
   */
  start(): Promise<void>
  /** Take the runtime down. A turn in flight is ended rather than abandoned. */
  stop(): Promise<void>
  /**
   * Open a session. The engine's `session/new` is where its own session id and the
   * model catalog come from (P0 §2.2).
   */
  openSession(request: AgentOpenRequest): Promise<AgentSession>
  /**
   * Choose a model for this session; P0 §2.3 measured that the engine accepts a
   * switch mid-session.
   */
  selectModel(session: AgentSession, modelId: string): Promise<void>
  /**
   * Send one turn. Resolves when the turn ends, because that is when the protocol
   * answers the prompt request (P0 §2.3: the response carries the stop reason and
   * the usage); rejects when the turn could not be delivered or the runtime went
   * away while it ran.
   */
  prompt(session: AgentSession, text: string): Promise<AgentRunResult>
  /**
   * Stop the turn in flight. Allowed while it waits for a permission (§6.2), and a
   * no-op when no turn is running.
   */
  cancel(session: AgentSession): Promise<void>
  /**
   * Answer a permission request. `optionId` has to be one of the options the
   * request carried, and an answer for a request that is no longer pending is
   * rejected rather than ignored — a stale click must not be able to look like
   * consent.
   */
  answerPermission(session: AgentSession, requestId: string, optionId: string): Promise<void>
  /** Read the session's state and the point a subscription continues from. */
  snapshot(session: AgentSession): Promise<AgentSessionSnapshot>
  /**
   * Subscribe from a snapshot: the gateway replays what the snapshot did not
   * include, then delivers live events, so the subscriber sees every event exactly
   * once and in sequence order.
   *
   * Rejects with `buffer-conflict` when the snapshot is older than anything the
   * gateway can still replay; the caller then takes a fresh snapshot instead of
   * continuing from a hole it would never notice.
   *
   * Resolves with the unsubscribe.
   */
  subscribe(
    from: AgentSessionSnapshot,
    onEvent: (event: AgentEvent) => void,
  ): Promise<() => void>
}
