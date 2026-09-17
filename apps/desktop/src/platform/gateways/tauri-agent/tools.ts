/**
 * Tool calls: the wire's partial frames, and the complete payloads the contract states.
 *
 * This is the first and largest of the three disagreements this adapter reconciles, and it is
 * the one that cannot be done frame by frame. The Rust runtime forwards the schema's `ToolCall`
 * and `ToolCallUpdate` verbatim inside `{ "update": … }` — "the shape is the schema's, and
 * re-packaging it here would only lose the fields T5 needs to correlate them" — while the
 * contract's payload is flat **and complete**: `toolCallId`, `title`, `kind`, `status`, `paths`,
 * `content`, `input` and `output` are all required.
 *
 * The wire is not complete. A `tool_call_update` carries only what changed, and P0 §6.1's
 * measured frames show it: the first update has no `title`, the second has no `locations` and
 * no `rawInput`. Completing each frame from the last one published for the same call is
 * therefore not tidiness — the reducer replaces the whole row from the payload
 * (`replaceToolEntry` in `features/agent/services/agent-timeline.ts`), so a status-only update
 * mapped literally would blank the row's paths and its output the moment the tool finished.
 *
 * Nothing here is worded for the engine: every fallback is the engine's own value, or the
 * schema's own default.
 */

import type {
  AgentToolContent,
  AgentToolInput,
  AgentToolKind,
  AgentToolStatus,
} from '../agent-contracts'
import { KEY_SEPARATOR, isRecord, nonEmpty } from './fields'

/** The envelope fields a tool call is published under. Only the pieces this module needs, so
 *  it does not have to import the whole frame shape to key a projection. */
export interface ToolFrameIdentity {
  agentId: string
  profileId: string
  runtimeEpoch: string
  sessionId: string
}

/** What was last published for one tool call. */
export interface PublishedToolCall {
  title: string
  name?: string
  kind: AgentToolKind
  status: AgentToolStatus
  paths: string[]
  content: AgentToolContent[]
  input: AgentToolInput
  output: AgentToolInput
}

/**
 * The tool calls this adapter has published, for completing later partial frames.
 *
 * A projection, not a second source of truth: it exists only because the contract's payload is
 * complete and the wire's is not, so the fields a frame leaves out have to come from somewhere
 * — and the only honest source is what this adapter already sent for the same call. Nothing
 * reads it except {@link mapToolUpdate}, and the row the panel renders is still the reducer's.
 *
 * Bounded, by insertion order: a session's tool calls are unbounded over a long conversation,
 * and this is a projection of frames already delivered, so losing the oldest entry costs a
 * degraded title on some later update — never a dropped frame. A fresh adapter (a remounted
 * window that built a new one) starts empty and degrades the same way rather than refusing
 * anything.
 */
export class ToolProjection {
  private readonly calls = new Map<string, PublishedToolCall>()

  constructor(private readonly limit = 256) {}

  /** Keyed by the composite identity, not by the session id: two engines can hand out the same
   *  session id (§6.1), and joining their tool calls would complete one engine's frame with
   *  another's row. */
  private static key(identity: ToolFrameIdentity, toolCallId: string): string {
    return [identity.agentId, identity.profileId, identity.runtimeEpoch, identity.sessionId,
      toolCallId].join(KEY_SEPARATOR)
  }

  of(identity: ToolFrameIdentity, toolCallId: string): PublishedToolCall | undefined {
    return this.calls.get(ToolProjection.key(identity, toolCallId))
  }

  remember(identity: ToolFrameIdentity, toolCallId: string, call: PublishedToolCall): void {
    const key = ToolProjection.key(identity, toolCallId)
    // Re-inserting an existing key moves it to the end, so the entry evicted under pressure is
    // the least recently *updated* call rather than the first one ever seen.
    this.calls.delete(key)
    this.calls.set(key, call)
    while (this.calls.size > this.limit) {
      const oldest = this.calls.keys().next()
      if (oldest.done) break
      this.calls.delete(oldest.value)
    }
  }
}

const TOOL_STATUSES: readonly AgentToolStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]

const TOOL_KINDS: readonly AgentToolKind[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]

/**
 * The engine's `ToolCall`/`ToolCallUpdate`, as the contract's complete payload — or the raw
 * payload, for the contract's validator to refuse with a reason.
 *
 * The two wire frames differ only in that the update may omit everything but the id, so they
 * are one function: what is present wins, what is absent is taken from the last frame published
 * for that call, and what neither has is the schema's own default.
 */
export function mapToolUpdate(
  payload: unknown,
  identity: ToolFrameIdentity,
  tools: ToolProjection,
): unknown {
  const wrapped = isRecord(payload) ? payload.update : undefined
  if (!isRecord(wrapped)) return payload

  const toolCallId = nonEmpty(wrapped.toolCallId) ? wrapped.toolCallId : null
  if (toolCallId === null) return payload
  const prior = tools.of(identity, toolCallId)

  const call: PublishedToolCall = {
    // The fallback chain is the permission prompt's (`label_of` in `permissions.rs`), for the
    // same reason: the contract refuses an empty title, and a tool row dropped on the way to
    // the UI is a call the user never sees. Both fallbacks are the engine's own words.
    title: nonEmpty(wrapped.title)
      ? wrapped.title
      : (prior?.title ?? (nonEmpty(wrapped.kind) ? wrapped.kind : toolCallId)),
    name: nonEmpty(wrapped.name) ? wrapped.name : prior?.name,
    // `other` and `pending` are the schema's own defaults (`#[serde(other)]` on `ToolKind`,
    // `Default` on `ToolCallStatus`), not values invented here.
    kind: toolKind(wrapped.kind) ?? prior?.kind ?? 'other',
    status: toolStatus(wrapped.status) ?? prior?.status ?? 'pending',
    paths: toolPaths(wrapped.locations) ?? prior?.paths ?? [],
    content: toolContent(wrapped.content, prior?.content),
    input: toolInput(wrapped.rawInput, prior?.input),
    output: toolInput(wrapped.rawOutput, prior?.output),
  }
  tools.remember(identity, toolCallId, call)

  // `name` travels as part of the payload whether or not the engine sent one, which is the
  // shape the contract's own reader produces (`name: typeof name === 'string' ? name :
  // undefined`) — so a payload mapped here and one that came back through validation are
  // indistinguishable to a consumer.
  return { toolCallId, ...call }
}

/**
 * The wire's status, where it is one this contract knows.
 *
 * The schema's four (`pending`, `in_progress`, `completed`, `failed`) and the contract's
 * spellings are identical, so this is a membership test rather than a translation — and an
 * unknown one is refused instead of passed on, because `readToolUpdate` would refuse the whole
 * payload, and a status the panel cannot draw is better reported than silently dropped. The
 * contract's fifth value, `cancelled`, is the reducer's reading of a turn that ended while a
 * call was still open; the engine never sends it.
 */
function toolStatus(raw: unknown): AgentToolStatus | null {
  return typeof raw === 'string' && (TOOL_STATUSES as readonly string[]).includes(raw)
    ? (raw as AgentToolStatus)
    : null
}

function toolKind(raw: unknown): AgentToolKind | null {
  return typeof raw === 'string' && (TOOL_KINDS as readonly string[]).includes(raw)
    ? (raw as AgentToolKind)
    : null
}

/**
 * The files a call touches, from the wire's `locations`.
 *
 * `locations` is the schema's array of `{ path, line? }` and the contract wants the paths. An
 * absent `locations` is null rather than `[]` so the caller can tell "this frame said nothing
 * about locations" from "this frame said it touched nothing" — the difference that keeps a
 * status-only update from wiping the paths a previous frame established.
 */
function toolPaths(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const paths: string[] = []
  for (const entry of raw) {
    if (isRecord(entry) && nonEmpty(entry.path)) paths.push(entry.path)
  }
  return paths
}

/**
 * The content blocks a call produced, in the two shapes the contract carries.
 *
 * The wire's `ToolCallContent` is internally tagged (`#[serde(tag = "type", rename_all =
 * "snake_case")]`), so a block arrives as `{ type: 'diff', path, oldText?, newText }` and the
 * discriminator is the whole of how the arms are told apart. The two the contract does not draw —
 * the schema's `content` and `terminal` — are mapped to `unrecognised` rather than dropped, so a
 * surface can say a block arrived that this version does not draw instead of reporting the call as
 * having produced nothing.
 *
 * **Absent means keep, present means replace.** `ToolCallUpdateFields` says so in its own words —
 * "Collections (content, locations) are overwritten, not extended" (`tool_call.rs:262-265`) — which
 * is the same rule {@link toolPaths} applies to the other collection, and the reason a
 * status-only update cannot blank a diff the first frame established.
 *
 * A `diff` whose required fields are not strings is `unrecognised` and not a refusal: the reader
 * would refuse the whole payload for a malformed block, and a call the user can see is worth more
 * than a strict answer about one block inside it. The SDK has already been through this frame —
 * it deserializes `content` with skip-invalid-items, so a block that is not a `ToolCallContent` at
 * all never reaches the window — which is why this arm is a floor rather than the usual path.
 */
function toolContent(
  raw: unknown,
  prior: AgentToolContent[] | undefined,
): AgentToolContent[] {
  if (raw === undefined) return prior ?? []
  if (!Array.isArray(raw)) return prior ?? []
  const content: AgentToolContent[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.type !== 'string') {
      content.push({ type: 'unrecognised' })
      continue
    }
    if (entry.type !== 'diff') {
      content.push({ type: 'unrecognised' })
      continue
    }
    const { path, newText, oldText } = entry
    // Both of these may legitimately be empty — the engine's own builder produces `path: ""` and
    // an empty file as `newText` — so this is a type test and not `nonEmpty`'s.
    if (typeof path !== 'string' || typeof newText !== 'string') {
      content.push({ type: 'unrecognised' })
      continue
    }
    if (oldText !== undefined && oldText !== null && typeof oldText !== 'string') {
      content.push({ type: 'unrecognised' })
      continue
    }
    content.push({
      type: 'diff',
      path,
      oldText: typeof oldText === 'string' ? oldText : null,
      newText,
    })
  }
  return content
}

/**
 * The arguments, in the three states the host keeps apart — and in the two states the *wire*
 * keeps apart, which are not the same two.
 *
 * `undefined` and `null` are different messages on a `tool_call_update`: the field being absent
 * means "not mentioned, keep what you had" (the schema: "only changed fields need to be
 * included"), while an explicit `null` means the engine is saying there is nothing there. P0
 * §6.1's third frame is the first case — it reports a completion and says nothing about
 * `locations` or `rawInput` — and treating that as "absent" is what would blank the arguments
 * the previous frame established.
 *
 * The third host state — "the engine sent arguments this host could not parse" — cannot be
 * produced *from here*: the schema deserializes these fields with default-on-error, so by the
 * time a typed frame exists the two are already one value (the same limit T3 recorded for the
 * permission prompt's input).
 */
function toolInput(raw: unknown, prior: AgentToolInput | undefined): AgentToolInput {
  if (raw === undefined) return prior ?? { state: 'absent' }
  if (raw === null) return { state: 'absent' }
  // Parsed JSON always re-serializes; the value cannot be circular or a function.
  return { state: 'text', json: JSON.stringify(raw) as string }
}
