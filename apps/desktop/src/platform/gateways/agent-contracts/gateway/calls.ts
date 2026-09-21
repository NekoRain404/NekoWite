/**
 * What the application calls, the requests those calls take, and the snapshot a subscription
 * continues from.
 *
 * The port itself, plus the two shapes that exist only as its arguments: an open request is what
 * `openSession` and `loadSession` are asked with, and a snapshot is both what `snapshot` answers and
 * what `subscribe` continues from — which is why the three belong to one module rather than three.
 * Nothing here says how the runtime is reached (that is `tauri-agent.ts` or
 * `memory-agent/`); this is the surface both satisfy, so it changes when a call is added, removed
 * or given a new argument.
 */

import type { AgentEvent, AgentIdentity } from '../envelope'
import type { AgentConfigOptionList, AgentPromptAttachment, AgentRunResult } from '../payloads'
import type { AgentCapabilityReport } from './capabilities'
import type { AgentChangeRecovery } from './recovery'
import type { AgentSession, AgentSessionHistory, AgentSessionState } from './session'

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
   * Rejects with **`session-open`** for a session this gateway already holds — the user
   * picked a row the runtime is already serving — and with `session-stale` for an id the
   * engine does not have, which is the one of the two that means the epoch moved on. They
   * were one code until both implementations were read together: "already open" is not a
   * stale session, and a reader told so went looking for a runtime that had gone. A load
   * already in flight for the same session is a third condition and has its own code,
   * `load-in-flight`.
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
   * Put one change this host performed back — the write that needs no tab.
   *
   * §7.2 asks for a change to be recoverable, and the editor plane's review answers that for a
   * note a *tab* holds: the note's own save transaction is the app's one path into an open file,
   * and it is the right one while a buffer, a vault and a precondition apply. A note no tab holds
   * had no path at all — the review could say「no tab holds this note」 and nothing more — which is
   * exactly the note a reader is least likely to have open, because the agent went and changed it.
   *
   * This is that path, and it is the host's own: the baseline it holds is the text the *delegated
   * write* replaced, read from the same bytes the record's hash came from, so the check before
   * restoring is against the file rather than against anything a window remembers. It is
   * deliberately not a general "write this text": the caller names a **path**, never content, and
   * what is put back is whatever this host recorded for it.
   *
   * **A refusal is the return value, not a rejection.** The six reasons (`no-baseline`,
   * `baseline-stale`, `unavailable`, `changed-since-recorded`, `already-at-baseline`,
   * `write-refused`) are data a surface renders, keyed by the code — the same arrangement the
   * settings pages use for their own refusals. A rejection means the call did not happen at all:
   * no runtime, a session this host never opened (the engine's own `session-stale` shape), or a
   * runtime that went away mid-call.
   */
  recoverChange(session: AgentSession, path: string): Promise<AgentChangeRecovery>
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
