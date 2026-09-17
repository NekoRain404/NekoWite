/**
 * The gateway surface: what the application calls, and the state it reads back.
 *
 * These types are the boundary between `features/agent` and whichever adapter is
 * behind it — the real one (`tauri-agent.ts`) and the test double
 * (`memory-agent.ts`) are interchangeable here, so nothing in this file may
 * describe how the runtime is reached.
 */

import type { AgentEvent, AgentIdentity } from './envelope'
import type {
  AgentConfigOption,
  AgentConfigOptionList,
  AgentPromptAttachment,
  AgentRunResult,
} from './payloads'

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

/**
 * The features a capability report has a row for, in the order the host reports them.
 *
 * One list, and it is the host's: the Rust `HostFeature::ALL` (`agent_runtime/adapters/mod.rs`),
 * spelled with the same names `HostFeature::as_str` produces. They are *data* — a settings page
 * renders them as they arrived rather than translating them — so the two sides sharing one spelling
 * is the whole contract, and `tauri-agent.test.ts` reads the Rust file and holds the two lists to
 * each other rather than trusting this copy.
 */
export const AGENT_CAPABILITY_FEATURES = [
  'session-resume',
  'session-list',
  'session-resume-without-history',
  'session-close',
  'session-fork',
  'slash-commands',
  'model-selection',
  'image-attachments',
  'audio-attachments',
  'session-config-options',
  'embedded-context',
] as const

export type AgentCapabilityFeature = (typeof AGENT_CAPABILITY_FEATURES)[number]

/**
 * What the installation claims about a feature — `adapters::Capability`, arm for arm.
 *
 * A **claim**, not an answer: §3.4 makes the install declaration a start-time hint, and the
 * handshake and the session negotiation are what decide what works. It is reported (a page that
 * showed only the finding would be hiding that the pinned version was measured to differ), but it
 * is never a route to {@link AgentCapabilityFinding} saying `available`.
 *
 * `unverified` is a third arm rather than a synonym for `not-advertised` because the two are
 * different claims: "the pinned version is known not to do this" against "we have not measured this
 * engine at all", and letting one stand in for the other is the failure the third state exists to
 * prevent.
 */
export type AgentCapabilityDeclaration = 'advertised' | 'not-advertised' | 'unverified'

/**
 * What was established about one feature, from the engine's own report.
 *
 * Three arms, and the third is the one a two-armed version would lose — `available` is only ever
 * built from something the engine reported, `unavailable` is a report that said no, and `unverified`
 * is one that has not happened. Every non-available arm *requires* a detail, so a report cannot say
 * a capability is missing and leave the user to guess why (§7.2 「不宣称…」), and the same shape is
 * what D3's `PetCapabilityFinding` uses on the pet side.
 */
export type AgentCapabilityFinding =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable' | 'unverified'; readonly detail: string }

/**
 * One feature, with both halves of §3.4's capability row kept apart.
 *
 * Two fields rather than one optimistic one: a page that merged them would be showing the
 * installation's claim as the engine's answer, which is exactly what the row's 「安装声明仅用于启动提示」
 * forbids. The finding is nested rather than intersected into this type so a consumer reads
 * `report.finding.status` and narrows a plain union.
 */
export interface AgentCapabilityReport {
  readonly feature: AgentCapabilityFeature
  readonly declared: AgentCapabilityDeclaration
  readonly finding: AgentCapabilityFinding
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
   * The sessions the engine already holds — the history a window offers to reopen.
   *
   * Takes **no session handle**, and that is the point rather than an oversight: this
   * question is about the runtime's engine, not about a conversation in it. It needs
   * the runtime to be up (it rejects with `runtime-unavailable` otherwise, like
   * {@link openSession}) and it needs nothing else — no credential, no provider, no
   * open session.
   *
   * **A listed session is not an open one.** The ids in this answer are the engine's
   * own and this gateway has minted no handle for any of them, which is why the answer
   * is a list of summaries rather than of {@link AgentSession}s. The only way to get a
   * handle for one of them is {@link loadSession}.
   *
   * Whether to *ask at all* is a capability question and belongs to the caller: the
   * engine reports `session-list` — `sessionCapabilities.list` — in its own capability
   * report, and a window that offers history for an engine whose handshake carries no
   * such field is drawing a button onto a method the engine has said it does not
   * answer. The adapter does not second-guess that here, for the reason
   * `agent_session_capabilities` gives: a handshake is one engine's report about
   * itself, and this side may not answer for it on evidence it does not have.
   *
   * **`cursor` is how the page a previous answer named is asked for** — and the list is
   * unreadable without it: ACP's `session/list` takes one, a page is not the table, and a
   * surface handed `nextCursor` with nothing to pass it to is a list that says there is more
   * and cannot fetch it. Opaque by contract and only ever handed back to the engine that
   * issued it; absent asks for the first page.
   */
  listSessions(cursor?: string): Promise<AgentSessionHistory>
  /**
   * Reopen a session the engine holds, and adopt it.
   *
   * Resolves with a **new** {@link AgentSession} handle, exactly as
   * {@link openSession} does — because that is what it produces: a session this
   * gateway now follows, subscribes to and can be prompted on. A window that already
   * knows how to follow an opened session needs no second path.
   *
   * The engine replays the restored conversation as ordinary events while this call is
   * in flight, so a caller that subscribes afterwards is not looking at an empty
   * transcript: the restore lands on the same stream a turn does, and
   * {@link snapshot} carries the tail of it.
   *
   * Rejects with `session-stale` for a session this gateway already holds — the user
   * picked a row they are already in — and with the engine's own refusal for an id it
   * does not have.
   */
  loadSession(sessionId: string, request: AgentOpenRequest): Promise<AgentSession>
  /**
   * Free a session on the engine and stop following it here.
   *
   * **Not a deletion.** ACP gives removing a session from `session/list` to a
   * different method, `session/delete`, and the pinned engine neither advertises nor
   * implements it — a close was measured leaving the session listed. So a caller must
   * not draw this as "delete this conversation", and a history surface that offers it
   * should say what it does: the engine lets the session go, the row stays.
   *
   * **By id, not by handle**, and the difference is not stylistic. A session the
   * engine *lists* has no handle — `listSessions` answers summaries and mints none,
   * and `loadSession` is the only call that does. A handle-shaped close therefore
   * forced a caller to adopt a row before freeing it, which is two round trips and,
   * worse, is impossible for a session the runtime is *already serving but not
   * showing*: `loadSession` refuses it (already open) and there is no handle to close.
   * That session could be neither reopened nor freed, with no user action to recover
   * it. Taking the id removes the state rather than working around it.
   *
   * The §6.1 boundary the handle used to carry is not lost, it is one layer down:
   * `agent_close_session` refuses an id this host never opened, so a renderer still
   * cannot free a session id it composed. Rejects with `session-stale` for such an id.
   */
  closeSession(sessionId: string): Promise<void>
  /**
   * Choose a model for this session; P0 §2.3 measured that the engine accepts a
   * switch mid-session.
   *
   * The narrower spelling of {@link setConfigOption} for the option this app knows by name: the
   * adapter resolves the engine's own option id and holds the value to the session's published
   * catalog. A model is one instance of a config option, not a second mechanism beside one.
   */
  selectModel(session: AgentSession, modelId: string): Promise<AgentConfigOptionList>
  /**
   * Move any one of the session's own configuration options — the general call {@link selectModel}
   * is the model's special case of.
   *
   * ACP's concept is the config option (P0 §2.2 measured the model arriving as one of them, and
   * the pinned engine reports a session mode beside it: `{id: "mode", name: "Session Mode",
   * currentValue: "build"}`), so a UI that renders one selector per option the engine reports
   * needs this call and not a third method per option name. §6.3 leaves the ids and the values to
   * the engine, and this passes both through as they came.
   *
   * `configId` and `value` are constraints the *engine* has: it refuses an option it did not
   * publish, and a value that option does not offer. The adapter checks the handle before it
   * forwards anything (§6.1) and reports the engine's own refusal otherwise.
   *
   * **It answers with the engine's refreshed option list, and that is not a convenience.**
   * `session/set_config_option` returns the full set with its current values, and the Rust
   * command passes it through rather than discarding it (`commands/agent.rs`, which took the
   * decision from Zed's `connection.rs:311`). A caller that ignores the answer is relying on the
   * engine *also* announcing the change as {`config-changed`} — which the pinned engine does, and
   * which an engine that answered without notifying would not. So a caller whose row shows the
   * option takes this answer as the new state and lets the notification be the second path to the
   * same list.
   *
   * `null` means the answer was not a list this window can read. It is deliberately not an empty
   * list: the caller's current list is then the only thing this window knows, and clearing a row
   * because an answer could not be read would be this app stating a change the engine never made.
   */
  setConfigOption(
    session: AgentSession,
    configId: string,
    value: string,
  ): Promise<AgentConfigOptionList>
  /**
   * Send one turn. Resolves when the turn ends, because that is when the protocol
   * answers the prompt request (P0 §2.3: the response carries the stop reason and
   * the usage); rejects when the turn could not be delivered or the runtime went
   * away while it ran.
   *
   * `attachments` is what the reader put in the message beside its words, optional so that a
   * caller with nothing to attach sends exactly the prompt this port has always sent. It is *not*
   * gated here: whether each block may travel is the engine's own report, read by the host at send
   * time, and a turn carrying one the handshake did not license is refused with
   * `attachment-unsupported` rather than quietly sent or quietly emptied. A surface that draws an
   * attach control asks the same report first (`AgentGateway.capabilities`), so the refusal is the
   * race and not the ordinary path.
   */
  prompt(
    session: AgentSession,
    text: string,
    attachments?: readonly AgentPromptAttachment[],
  ): Promise<AgentRunResult>
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
  /**
   * What this engine reported about this session, feature by feature — §3.4's capability row, with
   * the installation's declaration beside the negotiated answer.
   *
   * A **call** rather than a field on {@link AgentSession}, and the difference is the point: the
   * answer is re-derived on every ask, while a value that arrived with the handle would be a claim
   * about an engine nobody has asked since. A runtime that has been replaced has no answer left to
   * give, and the host answers `unverified` for it rather than repeating what its process once
   * reported (§3.4: 「重连和版本变化后重新检测」).
   *
   * A session this gateway did not open is rejected with `session-stale`, like every other
   * session-scoped call — never answered with rows, which would be inventing a session's state.
   */
  capabilities(session: AgentSession): Promise<readonly AgentCapabilityReport[]>
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
