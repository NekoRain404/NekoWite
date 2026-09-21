/**
 * The payload vocabulary: one type per kind, and the kind list itself.
 *
 * This is the whole vocabulary `features/agent` is allowed to speak for events: a
 * component never sees a JSON-RPC frame, a Tauri event or an engine-specific
 * field, and the adapter maps protocol onto these types rather than the other way
 * round. That is why nothing here imports from `features/` (plan §6.1) and why no
 * wire name appears outside a field comment.
 *
 * The kinds are the plan's §6.2 list widened twice: by what the engine was measured
 * to emit (P0 §2.3 — `agent_message_chunk`, `agent_thought_chunk`,
 * `available_commands_update`), and by the whole of ACP v1's `SessionUpdate` as read
 * from `agent-client-protocol-schema` 1.7.0 (`src/v1/client.rs`). That schema has
 * eleven stable variants where the plan's list named seven; each of the extra six
 * now has a kind here (`user-delta`, `plan-changed`, `mode-changed`,
 * `config-changed`, `session-changed`, `usage-changed`), because §6.2's rule is that
 * a component never has to guess what an event meant — and a frame with no kind can
 * only be dropped (losing real engine output) or reported as `invalid-response`
 * (calling a valid frame malformed).
 *
 * The protocol's `#[cfg(feature = "unstable_*")]` variants (plan operations,
 * context compaction) are deliberately not modelled: the schema itself says they
 * may be removed or changed at any point, so a frame of one is a loud
 * `invalid-response` rather than a silent drop.
 *
 * The vocabulary behind those kinds is divided by the wire frame each type is about, because a
 * change to one frame's shape and a change to another's are different changes. The list itself stays
 * here: `AgentEventKind` is `keyof` this map, so a kind and its payload type cannot be separated
 * from each other, and the map's arms are the only place a piece of the vocabulary is bound to a
 * kind:
 *
 *  - `payloads/tool-call.ts`      what a tool call is doing, produced and was passed
 *  - `payloads/permissions.ts`    what the engine asks the user to allow, and the answers it offers
 *  - `payloads/commands.ts`       one slash command the engine advertises
 *  - `payloads/plan.ts`           one entry of the engine's execution plan
 *  - `payloads/run-outcome.ts`    why a turn ended, and what it spent
 *  - `payloads/context-usage.ts`  the session's context window and cumulative cost
 *  - `payloads/config-options.ts` a session configuration option and its values
 *  - `payloads/attachments.ts`    what a prompt carries beside its text
 */

import type { AgentFailureCode } from '../failure'
import type { AgentCommand } from './commands'
import type { AgentConfigOption } from './config-options'
import type { AgentContextUsage } from './context-usage'
import type { AgentPermissionRequest } from './permissions'
import type { AgentPlanEntry } from './plan'
import type { AgentRunResult } from './run-outcome'
import type { AgentToolContent, AgentToolInput, AgentToolKind, AgentToolStatus } from './tool-call'

/**
 * One payload type per kind, and the single source of truth for the kinds
 * themselves: {@link AgentEventKind} is `keyof` this map, so a kind cannot exist
 * without a payload type and a payload type cannot exist without a kind.
 */
export interface AgentPayloads {
  /**
   * A chunk of the agent's answer, not the whole of it: the engine streams, so a
   * consumer merges these into the message it is building instead of replacing one
   * message per chunk.
   */
  'text-delta': { text: string }
  /**
   * A chunk of the *user's* own message (ACP `user_message_chunk`), which the engine
   * streams back when a session is loaded or resumed — P0 measured `loadSession:
   * true`, so a restored conversation replays its user turns this way. Dropping it
   * would leave such a session showing only the agent's half; mapping it to
   * `text-delta` would put the user's words on the agent's side of the timeline.
   */
  'user-delta': { text: string }
  /**
   * The engine's own disclosed reasoning channel — `agent_thought_chunk`, which P0
   * saw on the wire (§2.3).
   *
   * A kind of its own rather than a frame the adapter drops: §5.1 forbids showing
   * *invented* reasoning — a percentage, an internal state the model never exposed —
   * not reasoning the engine chose to disclose, so the decision belongs to the layer
   * that can render it (collapsed, or not at all) rather than to the adapter, which
   * could only throw it away. Dropping it there would also be irreversible: a later
   * consumer could never recover a channel the layer below had already discarded.
   */
  'thought-delta': { text: string }
  /**
   * A tool call and every update to it (ACP `tool_call` and `tool_call_update`) as
   * one kind: the wire splits them, but a consumer wants the latest state of a call
   * it identifies by `toolCallId`, so the second is an update to the first rather
   * than a different kind of event.
   */
  'tool-update': {
    /**
     * Stable across the status changes of one tool call, so the timeline updates
     * the row it already has instead of starting a new row per update.
     */
    toolCallId: string
    /** The engine's sentence for what the call is doing ("Reading src/main.rs") —
     *  the wire's required human-readable field, and what the row shows. */
    title: string
    /** The programmatic tool name when the engine sends one; ACP gates this field
     *  as unstable, so it is absent from engines that do not send it. */
    name?: string
    /** Category, for icon and UI treatment. */
    kind: AgentToolKind
    status: AgentToolStatus
    /** Files the call touches — the "target" the row shows, and what follow-along
     *  anchors on. Empty when the engine named none. */
    paths: string[]
    /**
     * What the call produced as content blocks, in the engine's order, and empty when it reported
     * none. Required like its siblings rather than optional: the adapter completes every frame
     * from the last one published for the same call, so "this frame said nothing about content"
     * is a question the projection answers before a payload exists, and a consumer that had to
     * tell `undefined` from `[]` would be re-deciding it.
     *
     * A call's content and its {@link output} are different facts and both are kept: the output is
     * what the engine reported as the tool's raw result, while a `diff` block here is the change
     * the engine proposes to make. On the engine measured here they are not even produced at the
     * same layer — the diff is built from the tool's own arguments against the file on disk, and
     * the engine returns no block at all when it cannot compute one.
     */
    content: AgentToolContent[]
    /** What the tool ran with, or was asked to run with. */
    input: AgentToolInput
    /** What it produced: `absent` when the engine has reported no output (yet or at
     *  all), `unreadable` when it reported one this host could not parse. */
    output: AgentToolInput
  }
  'permission-request': AgentPermissionRequest
  /**
   * The engine's full current command list. It replaces the previous list wholesale
   * rather than appending to it (P0 §2.2: the engine publishes the list, and
   * commands are discovered after the session opens, not returned with it), so a
   * consumer has to treat this as the complete set every time.
   */
  'commands-changed': { commands: AgentCommand[] }
  /**
   * The engine's execution plan for a complex task (ACP `plan`), replaced whole: the
   * schema requires an update to carry every entry with its current status, so a
   * consumer must not merge this into what it had.
   *
   * No panel renders it yet — it is here so the frame is not discarded on the way
   * in (which would make the data unrecoverable once a plan view exists), and so a
   * reducer can ignore it in an exhaustive switch rather than never see it.
   */
  'plan-changed': { entries: AgentPlanEntry[] }
  /**
   * The session's mode changed (ACP `current_mode_update`). §4.2 lists mode
   * switching as a session command, so the id has to reach the UI that offers it;
   * the modes a session may switch to come with the session itself.
   */
  'mode-changed': { modeId: string }
  /**
   * The session's configuration options changed (ACP `config_option_update`), as the
   * full set with their current values — the model selector among them.
   *
   * This is the same wire data `AgentSession.models` projects for the composer's
   * selector; both come from the engine's `configOptions`, so an adapter fills them
   * from one read rather than two.
   */
  'config-changed': { options: AgentConfigOption[] }
  /**
   * The session's own metadata changed (ACP `session_info_update`): its title, and
   * when it was last active. §5.3's session bar shows a renameable title, so this is
   * how a title the engine chooses reaches it.
   *
   * Absent and null differ and both are kept: absent means the update did not mention
   * the field (leave it alone), null means the engine cleared it.
   */
  'session-changed': { title?: string | null; updatedAt?: string | null }
  /**
   * The session's context window and cumulative cost (ACP `usage_update`). §5.1
   * allows usage and cost to be shown only when their source is reliable, which is
   * why this is a separate kind from a run's own token counts and why the cost is
   * nullable rather than zero-filled.
   */
  'usage-changed': AgentContextUsage
  /**
   * Vault paths the turn touched. The change review uses them to notice files it has
   * no pending edit for; they are a hint, not a diff, and not proof that the host's
   * own view of the file is up to date.
   */
  'files-changed': { paths: string[] }
  'run-finished': AgentRunResult
  /**
   * Plain data, deliberately not an `AgentFailure` instance: this payload crosses
   * the Tauri IPC boundary, where a class instance serializes to `{}` and both the
   * code and the message would be lost on the way to the window.
   */
  'run-failed': { code: AgentFailureCode; message: string }
}

/** Every kind of event, derived from the payload map so the two cannot drift. */
export type AgentEventKind = keyof AgentPayloads

// Names are re-exported one by one rather than with `export *`, the way `agent-contracts.ts` does it
// and for the reason it gives: this is a contract, so what it offers should be a list somebody
// chose, and a name that disappears from it should be a failing typecheck rather than a silent
// absence.
export type {
  AgentToolContent,
  AgentToolInput,
  AgentToolKind,
  AgentToolStatus,
} from './tool-call'
export type {
  AgentPermissionKind,
  AgentPermissionOption,
  AgentPermissionRequest,
} from './permissions'
export type { AgentCommand } from './commands'
export type { AgentPlanEntry } from './plan'
export { AGENT_STOP_REASONS } from './run-outcome'
export type { AgentRunEnding, AgentRunResult, AgentStopReason, AgentUsage } from './run-outcome'
export type { AgentCost, AgentContextUsage } from './context-usage'
export type {
  AgentConfigChoice,
  AgentConfigOption,
  AgentConfigOptionList,
  AgentConfigValue,
} from './config-options'
export { AGENT_PROMPT_ATTACHMENT_KINDS, promptAttachmentLabel } from './attachments'
export type { AgentPromptAttachment } from './attachments'
