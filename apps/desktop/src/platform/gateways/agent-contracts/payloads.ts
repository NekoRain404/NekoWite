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
 */

import type { AgentFailureCode } from './failure'

/**
 * What a tool call is doing.
 *
 * The first four are the wire's own states (ACP `ToolCallStatus`), spelled
 * identically so the adapter passes them through instead of translating.
 * `cancelled` is the host's addition: §5.1 requires the UI to tell "stopped" apart
 * from "failed", and the engine never sends it — a call still `pending` or
 * `in_progress` when the turn ended as cancelled is what the host reads as
 * cancelled, and whoever derives it must derive it rather than invent it.
 */
export type AgentToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/**
 * The category of a tool call (ACP `ToolKind`), kept for icons and UI treatment.
 *
 * `other` is where an unrecognised kind lands, mirroring the schema's
 * `#[serde(other)]`: the protocol says a kind the client has not learned yet
 * deserializes to "other" rather than failing, so it is not a malformed frame.
 */
export type AgentToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

/**
 * One block of content a tool call produced, as this window can honestly carry it.
 *
 * The wire's `ToolCallContent` is a union of three (`agent-client-protocol-schema` 1.7.0,
 * `src/v1/tool_call.rs:572-583`): a standard content block, a `Diff`, and a `Terminal`. Exactly
 * one of them is modelled here:
 *
 *  - **the diff is carried**, because it is the block a person acts on — §6.3 requires the user to
 *    see the target of the action they authorize, and a proposed edit's target is its text — and
 *    because the engine sends the whole of what it proposes rather than a summary of it:
 *    `oldText` and `newText` are the file's own text before and after, so the change can be
 *    reconstructed here instead of being taken on trust.
 *  - **everything else is one arm.** A standard content block is a union of its own (text, image,
 *    audio, a resource link, an embedded resource) and this contract does not model it; a
 *    `Terminal` block carries nothing but an engine-side id, and this host runs no ACP terminal at
 *    all, so the id names nothing a component could open. Carrying either one half-shaped would
 *    hand a component a field it cannot act on, and dropping either one silently would report the
 *    call as having produced less than it did. So the arm states the one true thing: a block
 *    arrived that this version does not draw.
 *
 * The list is a *collection*, and the schema says what an update does with it — "Collections
 * (content, locations) are overwritten, not extended" (`tool_call.rs:262-265`) — which is why this
 * is an array that a later frame replaces whole rather than one a frame appends to.
 */
export type AgentToolContent =
  | {
      type: 'diff'
      /**
       * The file being modified, as the engine named it (the schema's "absolute file path").
       * Carried verbatim, including an empty string: the engine measured here builds the field as
       * `z(filePath) ?? ""`, so a blank path is a value it states rather than one that is missing,
       * and a surface that filled the blank in from somewhere else would be answering a question
       * the engine left open.
       */
      path: string
      /**
       * The original text, or `null` when the engine stated none — which the schema defines as
       * "None for new files" (`tool_call.rs:703-707`).
       *
       * **`null` is not proof of that, and no surface may read it as one.** The field deserializes
       * with `x-deserialize-default-on-error`, so original text that failed to deserialize becomes
       * `None` as well: "the engine said this is a new file" and "the engine sent text this host
       * could not read" arrive here as one value. That is the same conflation acp-spec #1979
       * records for `rawInput`, and the same one {@link AgentToolInput} splits into three states —
       * but the split cannot be made at this layer, because it is the schema's own deserializer
       * that merges the two before a typed frame exists. What follows from it is a rule for the
       * render rather than a shape for this type: an absence is reported as an absence, and no
       * surface may say "new file" on the strength of it.
       */
      oldText: string | null
      /**
       * The text the engine proposes to leave in the file. The one field the schema requires, so a
       * block without it is not a diff this contract can carry.
       */
      newText: string
    }
  | { type: 'unrecognised' }

/**
 * The arguments a tool ran with, or the ones a user is being asked to approve.
 *
 * Three states, not two, because the wire conflates the last two: ACP deserializes
 * `rawInput` with `x-deserialize-default-on-error`, so a value that fails to
 * deserialize silently becomes `None` — "the agent provided no input" and "the
 * agent provided input that did not parse" arrive identically (acp-spec #1979, open
 * at the time of writing). §6.3 requires showing the user what they are approving,
 * and a prompt with nothing to show is not the same as one whose arguments could
 * not be read; collapsing them would force the UI to assert one of the two.
 *
 * `text` carries the arguments serialized rather than parsed, because their shape
 * is the engine's — the alternative is an `unknown` reaching a component, which
 * §6.2 forbids. Pretty-printing is the UI's business.
 */
export type AgentToolInput =
  | { state: 'absent' }
  | { state: 'text'; json: string }
  | { state: 'unreadable' }

/**
 * One answer the engine offers for a permission request.
 *
 * `kind` exists so the UI can mark a destructive or open-ended answer without
 * inventing one: §6.3 forbids the host from adding an "always allow" the engine
 * never offered, and `optionId` — the engine's own id — is what an answer is
 * validated against.
 *
 * It carries the engine's own four kinds rather than a collapsed allow/reject
 * pair, because the difference between them is the difference the user is being
 * asked to weigh. `allow_always` remembers the choice and `allow_once` does not;
 * a surface that draws them the same cannot warn about the lasting one, and a
 * consumer that cannot tell them apart cannot honestly emphasise either. The
 * values match the wire (`PermissionOptionKind` in the v1 schema).
 */
export type AgentPermissionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'

export interface AgentPermissionOption {
  optionId: string
  name: string
  kind: AgentPermissionKind
}

export interface AgentPermissionRequest {
  /**
   * The engine's id for this request. It is what an answer carries back, what
   * makes a repeated click recognisable as a repeat, and what an expired answer is
   * rejected by — so it is the whole binding between the request the user saw and
   * the permission that would be granted.
   */
  requestId: string
  /**
   * The tool call this request is about. Carried because a permission prompt is
   * about a *row* the user can already see in the timeline, and without this the
   * two cannot be related: the prompt would sit there asking to approve something
   * the transcript shows no trace of, and a tool row would show as pending with
   * nothing on screen saying why.
   */
  toolCallId: string
  /** What the user is being asked to allow, in the engine's own wording. */
  title: string
  /**
   * What they are allowing. The `unreadable` state matters most here: this is the
   * surface where §6.3 requires the user to see the target of the action they
   * authorize, so "there were no arguments" and "its arguments could not be read"
   * must not look the same to them.
   */
  input: AgentToolInput
  /**
   * The content blocks **this request's own `tool_call`** carried — the proposed change
   * among them, which is the thing a person decides on.
   *
   * Carried by the request rather than joined from the transcript, and that is the whole
   * point of the field. The engine attaches the blocks to the frame it asks with (P0 §7.1
   * measured a request whose `toolCall` carries the diff), and a prompt that read the
   * same call's *row* instead would show whatever the transcript happened to hold: on a
   * host where the request is the first frame to carry a block, nothing at all — a person
   * asked to allow an edit, shown the file's path and no text.
   *
   * **Empty means the request stated no block, and the prompt then draws none.** It is not
   * a gap to be filled from the row: "this request carried no diff" and "this request's
   * diff happens to equal the row's" are different facts, and a surface that lent the row's
   * blocks in the first case would draw both as one picture.
   */
  content: AgentToolContent[]
  /** Exactly the options the engine offered, in its order. */
  options: AgentPermissionOption[]
}

/** One slash command the engine currently advertises. */
export interface AgentCommand {
  name: string
  /**
   * Absent when the engine advertises a command without describing it; the menu
   * then shows the name alone instead of an empty description line.
   */
  description?: string
}

/**
 * Why a turn ended.
 *
 * The set is the protocol's (ACP `StopReason`), and the last four are *not errors*:
 * a turn that hit a token ceiling, ran out of agent requests, refused to continue,
 * or was cancelled ended the way it was always going to end. They belong to
 * `run-finished`; a run is only `run-failed` when the runtime could not carry it
 * out at all.
 */
export type AgentStopReason =
  | 'end-turn'
  | 'max-tokens'
  | 'max-turn-requests'
  | 'refusal'
  | 'cancelled'

/**
 * Every stop reason above: exported for the adapter that maps them and for the
 * tests that hold the validator to each of them.
 *
 * It is the set the *wire* may spell, which is why {@link AgentRunEnding}'s extra arm is not in
 * it: a frame that literally says `unrecognised` is a word this window does not know like any
 * other, and admitting that spelling here would read the engine's own word as this window's
 * statement about it.
 */
export const AGENT_STOP_REASONS = [
  'end-turn',
  'max-tokens',
  'max-turn-requests',
  'refusal',
  'cancelled',
] as const

/**
 * Why a turn ended, as far as this window can say: the protocol's five reasons, or one arm for an
 * ending whose reason is not among them.
 *
 * The protocol's `StopReason` is `#[non_exhaustive]`, and the engine this app runs against is not
 * a fixed protocol surface (P0 §6.3 measured the usage field set changing between two identical
 * turns), so "the engine ended a turn for a reason this version has never heard of" is a normal
 * frame rather than a corrupt one. It must not be a refusal: this payload is a *completed turn's*
 * ending, and a frame this window cannot read here becomes a failure reported on the turn the
 * engine just finished — the outcome `readers/session.ts` names in the same words about usage.
 * So the *reading* degrades rather than the frame: the ending is accepted and marked as one this
 * version does not know, which is a state a surface renders as neither a success nor a failure.
 *
 * It is deliberately wider than {@link AgentStopReason}, which stays the protocol's own set —
 * the same shape, and for the same reason, as the event kinds being wider than the Rust
 * `AgentEventKind`: a producer states a fact it knows, and only a reader has to admit it does
 * not know one.
 */
export type AgentRunEnding = AgentStopReason | 'unrecognised'

/**
 * What one turn spent, with a field for every counter the engine can report and **no field
 * required**.
 *
 * P0 §6.3 measured the same engine, the same model and the same script twice and got two
 * different sets: `{inputTokens, outputTokens, totalTokens, thoughtTokens}` in one turn, and
 * `{inputTokens, outputTokens, totalTokens, cachedReadTokens}` in the next. `totalTokens` is
 * not the sum either time (1721 + 6 ≠ 8895). So a fixed struct here would be wrong in one of
 * the two directions: filled in, it invents a number the engine never sent (§5.1: an unknown
 * cost is not zero); discarded whole, it throws away the numbers it did send.
 *
 * Each field is therefore optional and independent. **Absent means "not provided"**, which is
 * what a surface has to render — a `?? 0`, or any default, turns a field nobody reported into
 * a zero shown as fact. A reported `0` is kept and is a different thing.
 *
 * `totalTokens` is the engine's own count and is never computed from the other two; that is
 * why it is a field rather than something a caller derives.
 */
export interface AgentUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** `thoughtTokens`, `cachedReadTokens` and `cachedWriteTokens` are the counters the wire's
   *  own schema marks optional, and the ones P0 §6.3 measured appearing and disappearing. */
  thoughtTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
}

export interface AgentRunResult {
  stopReason: AgentRunEnding
  /**
   * The reason's own wording, kept when — and only when — `stopReason` is `unrecognised`: the arm
   * exists so the value behind it is recorded rather than thrown away. It is absent when the
   * reason is one of the five, because there the spelling above *is* the reason.
   *
   * What is kept is the reason as the frame spelled it, which is the engine's own wording in the
   * contract's letters — a node that respells the wire's `_` for a `-` does it before the reader
   * sees the value, and this field must not be read as a verbatim copy of the engine's bytes.
   *
   * The condition is recorded rather than merely visible: a reason which arrives once will arrive
   * again, and the word is what the next arm is written from. Carrying it is also what keeps the
   * two facts apart — "the engine ended this turn and this version does not know why" is not the
   * same statement as "some string arrived", and a container that held only the latter would be
   * the catch-all §6.2 forbids handing to a component.
   */
  unrecognisedReason?: string
  /**
   * null when the engine reported nothing at all. §5.1 allows usage to be shown only when its
   * source is reliable, and an unknown cost has to stay unknown — a zero here would read as a
   * free turn. An object means the engine did report usage, and each of its fields stands on
   * its own: see {@link AgentUsage}.
   */
  usage: AgentUsage | null
}

/** A monetary amount the engine reported (ACP `Cost`): an ISO 4217 currency and
 *  the cumulative amount for the session. */
export interface AgentCost {
  amount: number
  currency: string
}

/**
 * The session's context window and cost, as ACP's `usage_update` reports them.
 *
 * Deliberately not {@link AgentUsage}: these are the session's context occupancy
 * and its cumulative cost, while a run's usage is what one turn spent. Folding the
 * two would make one of them unrepresentable — a turn's token counts are not a
 * window occupancy, and the window has no input/output split.
 */
export interface AgentContextUsage {
  /** Tokens currently in context (the wire's `used`). */
  usedTokens: number
  /** The whole context window, in tokens (the wire's `size`). Without it the
   *  occupancy is a number with no scale, and a percentage would be invented. */
  contextTokens: number
  /** Cumulative session cost, or null when the engine reported none (§5.1: shown
   *  only when its source is reliable, and a missing cost is not zero). */
  cost: AgentCost | null
}

/**
 * The kinds of thing a prompt can carry beside its text.
 *
 * Two, and they are the two ACP defines a *client* may attach under a capability: `resource` is
 * `ContentBlock::Resource` (a file's contents, embedded whole, which the schema requires
 * `promptCapabilities.embeddedContext` for) and `image` is `ContentBlock::Image`
 * (`promptCapabilities.image`). Exported as a value for the caller that has to judge a foreign
 * value and for the tests that hold it to each kind, the way {@link AGENT_STOP_REASONS} is.
 */
export const AGENT_PROMPT_ATTACHMENT_KINDS = ['resource', 'image'] as const

/**
 * One thing a turn carries beside its words.
 *
 * **The contents travel; a name alone would not.** Both arms carry what the model is to be shown —
 * a file's text, an image's bytes — because the question a reader is asking when they attach
 * something is whether the model *saw* it, and a path is not an answer to that. Whether the block
 * may be sent at all is the engine's own report rather than this type's business: the handshake's
 * `promptCapabilities` decides, the host reads it at send time, and a window that drew the control
 * has already asked the same report (see the agent feature's capability gate).
 *
 * `resource.path` is vault-relative and `/`-separated — the spelling the reader was shown and the
 * one the workspace is addressed by — while the host turns it into the absolute `file:` URI the
 * block carries. The two are different on purpose: a `file:` URI is a whole path or it is not a
 * URI, and the composer only ever knows the workspace-relative one.
 *
 * `image.data` is base64 with no `data:` prefix, which is what ACP's `ImageContent.data` holds.
 * There is no path on that arm: a pasted screenshot has no file behind it, and inventing one would
 * be claiming a file exists.
 */
export type AgentPromptAttachment =
  | {
      readonly kind: 'resource'
      /** Vault-relative and `/`-separated: what the block's URI is built from. */
      readonly path: string
      /** The file's text, as the window read it when the reader attached it. */
      readonly text: string
      /** The media type the file's extension implies, for the block's `mimeType`. */
      readonly mediaType: string
    }
  | {
      readonly kind: 'image'
      /** What to call it: the dropped file's name, or a generated one for a paste. */
      readonly name: string
      readonly mediaType: string
      /** Base64, with no `data:` prefix. */
      readonly data: string
    }

/**
 * What an attachment is called wherever a person reads it — a chip, a notice, a refusal.
 *
 * One function rather than two field reads at each surface, because the two arms do not share a
 * field name (`path` against `name`) and a caller that guessed would show a blank label for
 * whichever arm it guessed wrong about.
 */
export function promptAttachmentLabel(attachment: AgentPromptAttachment): string {
  return attachment.kind === 'resource' ? attachment.path : attachment.name
}

/** One task in the engine's execution plan. */
export interface AgentPlanEntry {
  /** What the task is for, in the engine's wording. */
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

/** One value a configuration option accepts. */
export interface AgentConfigChoice {
  value: string
  name: string
  description?: string
}

/**
 * What a configuration option is set to, and what it could be set to.
 *
 * Two arms because the schema's `SessionConfigKind` has two (`select`, `boolean`):
 * a boolean option's value is not a string, so one flattened shape would make one
 * of the two unrepresentable — the same defect the extra kinds exist to avoid.
 */
export type AgentConfigValue =
  | { kind: 'select'; current: string; choices: AgentConfigChoice[] }
  | { kind: 'toggle'; current: boolean }

/** One session configuration option (ACP `SessionConfigOption`); the model
 *  selector P0 §2.2 measured coming back with `session/new` is one of these. */
export interface AgentConfigOption {
  /** The engine's id, which is what setting it addresses (`configId` on the wire). */
  id: string
  name: string
  description?: string
  value: AgentConfigValue
}

/**
 * The whole set of a session's options, as an engine reports it — the answer to `session/new`
 * and the answer to `session/set_config_option`, which the Rust command passes through in one
 * shape on purpose.
 *
 * Two arms, and they are two different statements: a list is what the engine said its options
 * are (and an empty list is a valid one — an engine may withdraw every option it offered), while
 * `null` is this window failing to read the answer at all. A caller that collapsed them would
 * clear a row on an answer nobody could read, which is the engine being credited with a change it
 * never made.
 */
export type AgentConfigOptionList = readonly AgentConfigOption[] | null

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
