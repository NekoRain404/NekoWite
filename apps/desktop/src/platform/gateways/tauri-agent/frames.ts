/**
 * The reconciliation layer: the host's frames in, the contract's events out.
 *
 * §6.1 draws the adapter's job as "map protocol events to the host envelope", and this is the
 * half of that which can be tested without a process. It exists because the Rust runtime and the
 * TypeScript contract were built to their own readings of the same measurements and their
 * vocabularies do not all agree — three places, and each one needed a decision about which side
 * was right. None of them was a typo:
 *
 *  1. **`tool-update` is wrapped, and partial.** The runtime forwards the schema's `ToolCall` /
 *     `ToolCallUpdate` inside `{ "update": … }`, where the contract wants a flat and complete
 *     payload. That one needs state to be honest, so it lives in `tools.ts` with the projection
 *     that completes it; this file dispatches to it and does the rest.
 *  2. **`stopReason` is spelled the contract's way.** The runtime normalizes the engine's
 *     `snake_case` `StopReason` to kebab at the source (`runs.rs`, `wire_stop_reason`), so what
 *     arrives here is already `end-turn`, and `end_turn` is what a producer that did not normalize
 *     would send. The mapping below stays as this layer's job for exactly that producer — and
 *     mechanically, without a table, because a sixth stop reason belongs to the protocol rather
 *     than to this window and either spelling goes to the same validator.
 *  3. **`usage` is the engine's object, and its field set is not fixed.** P0 §6.3 measured
 *     `thoughtTokens` in one turn and `cachedReadTokens` in another, neither summing to
 *     `totalTokens` (1721 + 6 ≠ 8895). The contract's three numbers are kept, the optional ones
 *     are dropped (it has nowhere to put them), and `null` is answered when any of the three is
 *     missing — never a computed or defaulted number, because §5.1's rule is that an unknown
 *     cost is not zero.
 *
 * ## What this file does about a frame it cannot read
 *
 * Nothing about a bad frame is silent here. A frame that names a run but has a payload this
 * window cannot turn into a contract payload becomes a **`run-failed` event on that run**,
 * carrying `invalid-response` and the reason. That is the failure mode the plan is written
 * against: the ending of a turn is an event, so a frame that fails validation would otherwise
 * leave `prompt`'s promise unsettled and the composer disabled forever, with no error anywhere.
 * A frame whose *identity* is unreadable is not turned into an event at all — there is no
 * session to attribute one to, and §6.1 forbids inventing a session id — so it is returned as
 * the failure for the caller to report out of band.
 */

import {
  AgentFailure,
  readAgentEvent,
  type AgentEvent,
  type AgentUsage,
} from '../agent-contracts'
import { count, invalid, isRecord, nonEmpty } from './fields'
import { mapToolUpdate, type ToolProjection } from './tools'

/** The envelope fields `readAgentEvent` validates, read here as well so a frame that cannot be
 *  attributed is told apart from one whose payload could not be translated. */
export interface FrameShape {
  agentId: string
  profileId: string
  runtimeEpoch: string
  vaultId: string
  sessionId: string
  runId: string | null
  sequence: number
}

/**
 * The envelope's identity and host bookkeeping, or null.
 *
 * Deliberately the same rules as `agent-contracts/validation.ts` — five non-empty identity
 * fields, `runId` a string or null, `sequence` a non-negative integer. The duplication is the
 * price of the distinction this file needs (a bad envelope is not attributable; a bad payload
 * is), and it cannot let anything through on its own: the frame is handed to the contract's
 * validator afterwards either way.
 */
export function readFrameShape(frame: unknown): FrameShape | null {
  if (!isRecord(frame)) return null
  const sequence = frame.sequence
  const runId = frame.runId
  if (!nonEmpty(frame.agentId) || !nonEmpty(frame.profileId) || !nonEmpty(frame.runtimeEpoch)) {
    return null
  }
  if (!nonEmpty(frame.vaultId) || !nonEmpty(frame.sessionId)) return null
  if (runId !== null && typeof runId !== 'string') return null
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) return null
  return {
    agentId: frame.agentId,
    profileId: frame.profileId,
    runtimeEpoch: frame.runtimeEpoch,
    vaultId: frame.vaultId,
    sessionId: frame.sessionId,
    runId,
    sequence,
  }
}

/**
 * One frame from the host, as a contract event — or as the reason it is not one.
 *
 * `readAgentEvent` is the validator for everything this returns: a payload this file does not
 * translate is passed straight through, so a kind the contract does not know, or a payload it
 * cannot read, is reported by the single place that owns that judgement rather than by a
 * second, weaker copy of it here.
 */
export function mapHostFrame(frame: unknown, tools: ToolProjection): AgentEvent | AgentFailure {
  if (!isRecord(frame)) return invalid('the host event is not an object')
  const shape = readFrameShape(frame)
  if (!shape) return invalid('the host event has no usable identity or sequence')

  const kind = typeof frame.kind === 'string' ? frame.kind : ''
  const payload = mapPayload(kind, frame.payload, shape, tools)
  const event = readAgentEvent({ ...shape, kind, payload })
  if (!(event instanceof AgentFailure)) return event

  // The envelope is known good, so the refusal is about the payload. A frame that belongs to a
  // run is reported on that run: the run's own ending is an event, so a frame the window cannot
  // read leaves `prompt` waiting on something that will never arrive — and the run is what the
  // UI has to be told about. A frame that belongs to no run (the command list, a request) has
  // nothing to fail, so it is returned for the caller to report rather than turning a
  // session-scoped frame into a failed turn.
  if (shape.runId === null) return event
  return {
    ...shape,
    kind: 'run-failed',
    payload: {
      code: 'invalid-response',
      message: `the agent runtime sent a ${kind || 'unlabelled'} frame this window could not read: ${event.message}`,
    },
  }
}

/** The payload, in the contract's shape — or the raw payload, for the validator to judge. */
function mapPayload(
  kind: string,
  payload: unknown,
  shape: FrameShape,
  tools: ToolProjection,
): unknown {
  switch (kind) {
    case 'tool-update':
      return mapToolUpdate(payload, shape, tools)
    case 'run-finished':
      return mapRunResult(payload)
    default:
      // `text-delta`, `commands-changed`, `config-changed`, `permission-request`, `run-failed`
      // and the kinds the runtime does not produce are already the contract's shape — the host's
      // payloads were built against this contract for exactly that reason — so they go to the
      // validator untouched rather than through a mapping that could only re-spell them.
      //
      // `config-changed` is the one of those whose wire shape is *not* the contract's: the
      // translation happens a layer below, in `agent_runtime::events::normalize_update`, so what
      // reaches here is already `{ options: [...] }`. Doing it there is what keeps a second
      // reader of the schema's `type`/`currentValue` from existing in this window.
      return payload
  }
}

/**
 * The engine's answer to a turn: the stop reason in the contract's spelling, and the usage.
 */
function mapRunResult(payload: unknown): unknown {
  if (!isRecord(payload)) return payload
  const stopReason = mapStopReason(payload.stopReason)
  if (stopReason === null) return payload
  return { stopReason, usage: mapUsage(payload.usage) }
}

/**
 * The wire's stop reason, in the contract's spelling.
 *
 * Mechanical, and deliberately so: the protocol spells all five in snake_case (`end_turn`,
 * `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) and the contract in kebab-case, so
 * a table here would be a second copy of the protocol's enum — one that a sixth reason would
 * silently fall out of. A value that is not one of the contract's (`AGENT_STOP_REASONS`) still
 * fails validation, loudly, which is the right place for that judgement.
 *
 * A no-op for the runtime's own frames today, since `runs.rs` normalizes at the source: what this
 * still covers is a frame from a producer that does not — and the reason it is checked here rather
 * than assumed is that the alternative to translating is validating every stop reason the engine
 * sends as unreadable.
 */
function mapStopReason(raw: unknown): string | null {
  return nonEmpty(raw) ? raw.replaceAll('_', '-') : null
}

/**
 * The engine's `Usage`, as the contract's three numbers — or null.
 *
 * `totalTokens` is passed through as the engine reported it and never computed: P0 §6.3 measured
 * that it is not `input + output` (1721 + 6 = 1727 against a reported 8895), which is the whole
 * reason the shape is three numbers from the source rather than a sum of two.
 *
 * A usage object missing any of the three answers null, and that is a decision rather than a
 * loss: §5.1 allows usage to be shown only when its source is reliable, and those three fields
 * are what the ACP `Usage` struct requires — an object without them is one the SDK could not
 * have deserialized, so what would arrive here is a shape from some other producer. `null`
 * renders as "not provided"; a defaulted 0 would render as a free turn.
 */
function mapUsage(raw: unknown): AgentUsage | null {
  if (!isRecord(raw)) return null
  const inputTokens = count(raw.inputTokens)
  const outputTokens = count(raw.outputTokens)
  const totalTokens = count(raw.totalTokens)
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null
  return { inputTokens, outputTokens, totalTokens }
}
