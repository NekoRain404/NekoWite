/**
 * The session: the lifecycle it moves through, the handle a caller addresses it by, and the engine's
 * own table of the sessions it holds.
 *
 * The three are one subject because they are one fact read at three moments — a summary is a session
 * the engine has, a handle is one this gateway has opened, and a state is where an open one stands —
 * and the only route between the first two is the gateway's own `loadSession`. It changes when the
 * session surface changes: a state added to the host's vocabulary
 * (`agent_runtime/snapshot/session_log.rs`'s `SessionState`), a field added to the handle, or a row
 * added to the engine's listing. Nothing here may describe how the runtime is reached.
 */

import type { AgentIdentity } from '../envelope'
import type { AgentConfigOption } from '../payloads'

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
 *
 * The list is the runtime value and the type is derived from it — the direction
 * `AGENT_FAILURE_CODES` and `AGENT_CAPABILITY_FEATURES` already use, and for the
 * same reason: the adapter that reads a state off the wire has to test a name
 * that arrived from outside the process, and a type alone can neither be
 * enumerated nor tested. Writing the two out separately is what would make them
 * drift; here a name cannot exist in one without existing in the other.
 */
export const AGENT_SESSION_STATES = [
  'idle',
  'starting',
  'ready',
  'running',
  'waiting-permission',
  'completed',
  'cancelled',
  'failed',
] as const

export type AgentSessionState = (typeof AGENT_SESSION_STATES)[number]

/**
 * The one runtime test of that list, kept next to it the way `isAgentFailureCode`
 * is kept next to its own — so the boundary that has to refuse a foreign name
 * states the refusal without restating the vocabulary, and without casting a
 * string into the union.
 */
export function isAgentSessionState(raw: unknown): raw is AgentSessionState {
  return typeof raw === 'string' && AGENT_SESSION_STATES.some((state) => state === raw)
}

/**
 * A model the engine offers for a session — one `value`/`name` pair of a
 * `select` config option (P0 §2.2 measured the model selector arriving as
 * `configOptions` with `session/new`).
 *
 * Read-only: it is a projection of a config option, so there is nothing here that
 * could be updated independently of the option it came from.
 */
export interface AgentModelOption {
  readonly id: string
  readonly name: string
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
  /**
   * The session's model catalog, projected from its **config options** for the
   * composer's selector.
   *
   * Derived, never independent: the `model` option the engine returns with the
   * session is the single source of truth, and this is a read-only view of it — the
   * same wire value `config-changed` carries. An adapter must fill both from one read
   * so they cannot disagree, and nothing may write this: changing the model is
   * {@link AgentGateway.selectModel}, which moves the option. A second, separately
   * maintained copy of one wire value is the drift the plan warns about elsewhere
   * (why a projection may not become its own state).
   */
  readonly models: readonly AgentModelOption[]
  /**
   * The option's current value when the session opened — the seed for a selector, not
   * a place to record changes: {@link AgentGateway.selectModel} moves the option and
   * nothing pushes the new value back here.
   */
  readonly initialModelId: string
  /**
   * Every configuration option the engine answered with when the session opened, in the engine's
   * order, under the engine's names — the seed the composer's control row is drawn from.
   *
   * The same facts as {@link models}, and for the same reason a *projection* is not enough: a
   * model is one instance of an ACP config option, and the pinned engine reports a session mode
   * beside it (`{id: "mode", name: "Session Mode", currentValue: "build"}`, measured). A window
   * that drew only the catalog would show one control where the engine reported two.
   *
   * Read at open and never written: this is the engine's answer to `session/new` rather than a
   * running total, and later changes arrive as `config-changed` frames, which is what
   * `AgentSessionView.config` holds. Both are the engine's own report — the response carried the
   * list before any frame could, which is exactly why the row needs this one as well.
   */
  readonly options: readonly AgentConfigOption[]
  /**
   * The engine's own title for this session, as the engine gave it — or `null` when it has
   * named none, or when this window has not been told one.
   *
   * Carried because a *reopen* answers with a session the engine has already named, and the only
   * route this app has to that name is the `session/list` row the reader picked it from
   * (`AgentSessionSummary.title`): the load response carries no title, and the frame that would
   * say one — `SessionInfoUpdate` — is not mapped. Zed carries it the same way and for the same
   * reason: its restore path hands `info.title` to `load_agent_thread`
   * (`agent_ui/src/agent_panel.rs`, the archive row's own title), which passes it to the session
   * it opens, and the panel header falls back to `"New Agent Thread"` only when nothing carried
   * one.
   *
   * Two rules on who may write it, and they are the surface's own honesty rules:
   *
   *  - **Only the engine's words.** The value is the string the engine put in that row. An empty
   *    title is `null` rather than `''`, because a blank name is not a name, and a name this app
   *    wrote for a session the engine left untitled would be a fact the engine never stated.
   *  - **A seed, like {@link initialModelId}.** It is what the engine had said when the handle
   *    was minted; a later `session-changed` frame is newer and wins wherever both are read
   *    (`AgentSessionView.title`).
   */
  readonly title: string | null
}

/**
 * One session the engine holds, as `session/list` described it — the row a history
 * surface is drawn from.
 *
 * A projection of ACP's `SessionInfo`, and deliberately not the schema type: what
 * crosses this boundary is the fields a surface renders. The schema's `_meta` is
 * "reserved by ACP to allow clients and agents to attach additional metadata", which
 * is an engine's private annexe rather than a fact about the session.
 *
 * The two optional fields are optional *here for the same reason they are on the
 * wire*. The pinned engine was measured filling both, but the schema says an agent
 * may omit them, and a title this app invented for a session that had none would be a
 * fact about the engine that the engine never stated.
 *
 * There is deliberately no creation time: ACP's `SessionInfo` has no such field, so a
 * server-side listing cannot be sorted by creation. The engine's own `updatedAt` is
 * the only ordering it offers.
 */
export interface AgentSessionSummary {
  readonly sessionId: string
  /** The working directory the session belongs to, as the engine reported it. */
  readonly cwd: string
  /** The engine's own title, when it has one. */
  readonly title: string | null
  /** ISO 8601 last-activity stamp, when the engine sent one. */
  readonly updatedAt: string | null
  /**
   * Whether the host holds this session right now — the one field on a row the engine did not
   * answer.
   *
   * `session/list` is the engine's own table, and a real engine's table outlives the process that
   * wrote it: sessions a previous run of this app opened are still listed, which is exactly what a
   * history is for. The host's table is narrower by §6.1 — it forwards only ids it received a
   * `session/new` or `session/load` answer for — so a row this flag is false for is one
   * `closeSession` will refuse, and it will refuse it *before* the engine is asked.
   *
   * A surface that offers the free action is offering that call, so this is half of whether it may
   * be offered at all; the other half is the engine's own `session-close` report
   * (`AgentCapabilityReport`). Neither can stand in for the other: the engine's report says it
   * answers the method, and this says the host has something it may ask about.
   */
  readonly held: boolean
}

/**
 * One page of the engine's session table.
 *
 * A page rather than a bare array so `nextCursor` has somewhere to be: ACP defines its
 * absence as "there are no more results", so a caller handed only the array could not
 * tell a complete list from a truncated one. The pinned engine answers in one page,
 * which is why a surface may render this whole thing — but it can *say* whether it is
 * whole, which is the difference between offering a complete history and offering the
 * first slice of one as if it were the whole.
 */
export interface AgentSessionHistory {
  readonly sessions: readonly AgentSessionSummary[]
  /** Opaque; only ever passed back to the engine that issued it. */
  readonly nextCursor: string | null
}
