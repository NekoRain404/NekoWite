/**
 * The window's half of the agent IPC: one call per backend command, one event channel, and
 * nothing else.
 *
 * This is the only file in the adapter that imports a Tauri API. §6.1's rule is a direction,
 * not a preference: `features/agent` sees application events and no JSON-RPC, and this module
 * is the last place above the backend where a Tauri name appears — so the gateway next door
 * (`../tauri-agent.ts`) is written against {@link AgentIpc} and can be driven by a fake one in
 * a test, while the argument shapes the renderer actually sends stay here, in one table, where
 * a wrong key is one line to find instead of one per method.
 *
 * ## The argument shapes, and why they are spelled this way
 *
 * `@tauri-apps/api` passes the arguments object **verbatim** — no case conversion — and a
 * `#[tauri::command]` without `rename_all = "snake_case"` deserializes its parameters from
 * camelCase keys. That is the opposite of the convention the fs commands use (they declare
 * `rename_all = "snake_case"` and take `vault_root`), and the difference is not cosmetic: a key
 * in the wrong case makes an invoke reject, which reads exactly like the command not existing.
 * Every key below is therefore the camelCase spelling of the Rust parameter it must land on —
 * `sessionId` for `session_id`, `answer` for the one struct argument `agent_permission_answer`
 * takes — and the two commands that exist today are spelled from the declarations in
 * `commands/agent.rs`, not from this file's idea of them.
 *
 * ## Which of these the backend has
 *
 * Two of the eight calls below have a `#[tauri::command]` behind them:
 * `agent_permission_answer` and `agent_cancel_run` (T3's `commands/agent.rs`, registered in
 * `lib.rs` by this task). The other six are the session and run half of §9's "会话与授权 IPC",
 * which is not delivered: opening a session, sending a turn and reading a snapshot all need the
 * runtime driver, and that needs `AgentRuntime` to hand its two receivers — events and
 * permission requests — to one task, which its `&mut self` accessors cannot do (T3's report §6
 * found this; `agent_runtime/session.rs` is T2's file). Until it lands, a call to one of those
 * six rejects with Tauri's own "command agent_x not found", which is loud, names the call, and
 * needs no error code invented here to say so.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AgentFailure, isAgentFailureCode } from '../agent-contracts'
import type { AgentIdentity, AgentPromptAttachment } from '../agent-contracts'

/**
 * One call to the backend, with its rejection read as the contract's failure.
 *
 * Every method below goes through this, because the backend's rejection is where a *condition*
 * travels and this is the last place that can read it. The Rust commands answer
 * `commands::agent::AgentFailure` — `{code, message}`, the same pair a `run-failed` frame carries —
 * and before this existed the rejection arrived as the sentence alone: `SessionError::failure_code`
 * was computed, tested, and reached by nothing, so a caller here could only match on wording to
 * learn which condition it had hit. That is this repository's signature failure one layer in, and
 * the fix is the same shape as the frame vocabulary's: the fact travels with the words.
 *
 * **Nothing is invented.** A rejection this window cannot read a code from keeps the host's own
 * sentence and is reported as `invalid-response` — this list's word for "the answer could not be
 * read" — because a code is a claim about a condition, and nobody stated one. Two commands answer
 * a bare string today (`agent_permission_grants` and `agent_permission_grant_revoke`, whose
 * failures are the engine's HTTP surface rather than the ACP pipe this vocabulary classifies) and
 * Tauri's own "command not found" is a string too; both land here.
 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (raw) {
    throw asFailure(raw)
  }
}

/** The sentence a rejection with no readable message leaves. Named rather than blank, because a
 *  caller puts it inside a sentence of its own and an empty one reads as a truncated error. */
const UNREADABLE = 'the host answered without a reason this window could read'

function asFailure(raw: unknown): AgentFailure {
  if (raw instanceof AgentFailure) return raw
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  const code = record?.['code']
  // A string rejection is the whole message and carries no condition; anything else (a number, a
  // null, an object whose code is missing or is a word from a vocabulary this window does not
  // have) is a shape this window cannot read. Both fall to the same arm for the same reason: the
  // one thing that must not happen is a code nobody stated being passed off as one.
  const message = typeof raw === 'string' ? raw : record?.['message']
  const sentence = typeof message === 'string' && message.trim() !== '' ? message : UNREADABLE
  return isAgentFailureCode(code)
    ? new AgentFailure(code, sentence)
    : new AgentFailure('invalid-response', sentence)
}

/**
 * The channel the host publishes the runtime's events on.
 *
 * One channel for every session the runtime holds, not one per session: §6.2's envelope
 * carries the composite identity, so a frame already says which session, run and sequence it
 * belongs to — and a channel per session would leak a listener for every session a window ever
 * opened. The adapter filters; the host does not have to guess who is listening.
 *
 * `agent-event` follows the existing naming (`fs-change`, `ai-chunk`): a hyphenated, lowercase
 * noun for the thing the payload is about.
 */
export const AGENT_EVENT_CHANNEL = 'agent-event'

/**
 * A running runtime instance, as `agent_start` answers it.
 *
 * Three fields and not a session id: the epoch is minted per (agent, profile, vault) when an
 * instance starts (§6.2's `runtimeEpoch`), and the session — which is the engine's own id and
 * arrives with `agent_open_session` — is what the adapter joins to it to build the five-field
 * identity the contract validates events against.
 */
export interface AgentRuntimeHandle {
  agentId: string
  profileId: string
  runtimeEpoch: string
}

/** A session the engine opened, and the option list it came with (P0 §2.2 measured the list
 *  arriving with `session/new`; the model selector is one of its entries). */
export interface AgentHostSession {
  sessionId: string
  /** The engine's own config options, as they came. */
  configOptions: unknown
  /**
   * Which of those options selects the model, or null when this engine has none.
   *
   * The host answers this rather than the adapter looking for one: the option's id is the
   * engine's (`model`, measured — but nothing in the protocol requires that name), and the
   * Rust side already has the answer from its own adapter (`AgentAdapter::model_option_id`).
   * Deriving it here from the option's name or shape would be the host guessing at an engine's
   * configuration, which §3.4 forbids in either direction.
   */
  modelOptionId: string | null
}

/**
 * The host's snapshot of one session, as an envelope stream and the frames that were a
 * question.
 *
 * `events` are the host's own envelopes — the same shape it publishes on
 * {@link AGENT_EVENT_CHANNEL} — rather than contract payloads, deliberately: the adapter maps
 * the two through one function, so a replayed frame and a live one cannot come out differently
 * (which is the property §6.2's snapshot exists to preserve: a remount must be able to trust
 * what it rebuilds).
 *
 * `permissions` is a list of envelopes for the same reason. They are carried apart from
 * `events` because a request is not merely the tail of a stream — one that fell out of the
 * host's bounded buffer would leave a turn nobody can end — but they are still ordinary events
 * in that runtime's one sequence, which is how the Rust side publishes them.
 */
export interface AgentHostSnapshot {
  identity: AgentIdentity
  /** The plan's state machine, resolved by the host (§6.2). */
  state: string
  runId: string | null
  sequence: number
  events: unknown[]
  permissions: unknown[]
}

/** One answer the renderer sends back for a permission prompt. Field for field the Rust
 *  `PermissionAnswer` (T3), which is what `agent_permission_answer` deserializes. */
export interface AgentPermissionAnswerWire {
  session: AgentIdentity
  requestId: string
  optionId: string
}

/**
 * The backend, as this adapter uses it.
 *
 * A port rather than a set of free functions so the gateway can be exercised without a Tauri
 * runtime: `createTauriAgentIpc` is the only implementation that talks to the window's IPC,
 * and a test hands the gateway its own.
 */
export interface AgentIpc {
  start(vaultId: string): Promise<AgentRuntimeHandle>
  stop(): Promise<void>
  openSession(vaultId: string, cwd: string): Promise<AgentHostSession>
  /**
   * The engine's own session table. Needs the runtime, not a session: `agent_list_sessions`
   * reads no session id from its caller at all.
   *
   * `unknown` rather than a declared shape, like {@link capabilities}: what arrives is a foreign
   * process's answer, and the contract's reader is what narrows it.
   */
  listSessions(cursor?: string): Promise<unknown>
  /**
   * Reopens a session the engine holds.
   *
   * `vaultId` and `cwd` travel with the id because the Rust side checks both against what the
   * user actually opened — `agent_load_session` re-runs `agent_open_session`'s two guards, so a
   * renderer cannot name a vault into existence or point a restored session at a tree the user
   * never opened. The cwd the *engine* reported for the session is what a caller should pass.
   */
  loadSession(vaultId: string, cwd: string, sessionId: string): Promise<AgentHostSession>
  /** Frees a session on the engine and drops it from the host's table. Not a deletion — see
   *  `AgentGateway.closeSession`. */
  closeSession(sessionId: string): Promise<void>
  /**
   * Moves one of the session's own options — in practice the model.
   *
   * The command answers `serde_json::Value` (`commands/agent.rs`, `agent_set_config_option`),
   * and what it holds is the engine's **refreshed option list in the schema's own shape** — the
   * shape `AgentHostSession.configOptions` carries, not the contract's. `unknown` here for the
   * reason {@link capabilities} is: it is a foreign process's answer, and `tauri-agent/session.ts`
   * is what reads it (`readRefreshedOptions`). A window that declared the shape here would be
   * this side promising something about a process it does not own.
   */
  selectModel(sessionId: string, configId: string, value: string): Promise<unknown>
  /** Starts a turn and answers the host's own run id for it. The turn's ending arrives as an
   *  event, not as this call's result: the engine answers when the generation is over, and the
   *  Rust runtime is explicit that a caller cannot be left holding that (`runs.rs`).
   *
   *  `attachments` is what the turn carries beside its text. The Rust command's parameter is
   *  `Option<Vec<PromptAttachment>>`, so the empty case is sent as `null` rather than as an absent
   *  key: an explicit "this turn carries none" is a statement, and every caller before this one
   *  made it by sending nothing at all. */
  prompt(
    sessionId: string,
    text: string,
    attachments: readonly AgentPromptAttachment[],
  ): Promise<string>
  cancel(sessionId: string): Promise<void>
  /**
   * Put one of the run's changes back, through the host that performed it.
   *
   * `unknown` for the same reason {@link capabilities} is: the Rust command answers a tagged
   * enum, and the contract's reader (`readChangeRecovery`) is what narrows it. A window that
   * declared the shape here would be promising something about a foreign answer.
   */
  recoverChange(sessionId: string, path: string): Promise<unknown>
  answerPermission(answer: AgentPermissionAnswerWire): Promise<void>
  snapshot(sessionId: string): Promise<AgentHostSnapshot>
  /** §3.4's capability report for a session: the host's rows, unread here — the contract's reader
   *  narrows them, the same way it narrows a frame, because what arrives is a foreign process's
   *  answer either way. Deliberately `unknown` rather than a second declaration of the shape. */
  capabilities(sessionId: string): Promise<unknown>
  /** Register a listener. Resolves with the removal of *that* registration. */
  onEvent(onFrame: (frame: unknown) => void): Promise<() => void>
}

export function createTauriAgentIpc(): AgentIpc {
  return {
    start: (vaultId) => call<AgentRuntimeHandle>('agent_start', { vaultId }),
    stop: () => call<void>('agent_stop'),
    openSession: (vaultId, cwd) =>
      call<AgentHostSession>('agent_open_session', { vaultId, cwd }),
    // `null` and not an absent field: the command's own signature is `Option<String>`, and a
    // first page is a statement the caller makes rather than a key it leaves out.
    listSessions: (cursor) => call<unknown>('agent_list_sessions', { cursor: cursor ?? null }),
    loadSession: (vaultId, cwd, sessionId) =>
      call<AgentHostSession>('agent_load_session', { vaultId, cwd, sessionId }),
    closeSession: (sessionId) => call<void>('agent_close_session', { sessionId }),
    selectModel: (sessionId, configId, value) =>
      call<unknown>('agent_set_config_option', { sessionId, configId, value }),
    prompt: (sessionId, text, attachments) =>
      call<string>('agent_prompt', {
        sessionId,
        text,
        attachments: attachments.length === 0 ? null : attachments,
      }),
    cancel: (sessionId) => call<void>('agent_cancel_run', { sessionId }),
    recoverChange: (sessionId, path) =>
      call<unknown>('agent_recover_change', { sessionId, path }),
    answerPermission: (answer) => call<void>('agent_permission_answer', { answer }),
    snapshot: (sessionId) => call<AgentHostSnapshot>('agent_session_snapshot', { sessionId }),
    capabilities: (sessionId) =>
      call<unknown>('agent_session_capabilities', { sessionId }),
    onEvent: (onFrame) => listen<unknown>(AGENT_EVENT_CHANNEL, (event) => onFrame(event.payload)),
  }
}
