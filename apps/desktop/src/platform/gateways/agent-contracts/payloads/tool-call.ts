/**
 * The tool-call vocabulary: what a call is doing, what it produced, and the arguments it ran with.
 *
 * One wire frame's worth of the vocabulary — ACP's `tool_call` and `tool_call_update`
 * (`agent-client-protocol-schema` 1.7.0, `src/v1/tool_call.rs`) — and it is a module of its own
 * because that is what makes it change: a schema that adds a status, a kind or a content block lands
 * here and nowhere else. The kind list that consumes these types is `payloads/index.ts`, and the
 * reader that enforces them is `readers/tools.ts`.
 */

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
