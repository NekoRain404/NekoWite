/**
 * The runtime validator for an event envelope: the one place a frame from outside
 * this process becomes a typed event, or is rejected with a reason.
 *
 * §6.2 forbids handing an `unknown` payload to a component, so every kind has a
 * reader here and a consumer can switch on `kind` and get the payload type it names.
 * The readers themselves live in `readers/`, split by subject; this file is the walk
 * over the envelope and the table that dispatches to them.
 *
 * The readers are hand-written rather than pulled from a validation library. The
 * project has no such dependency, and for a bounded union this size a schema language
 * would add a concept to learn and a dependency to keep current while replacing about
 * a hundred lines of obvious checks — checks that are also where the protocol's enums
 * are enforced, which is work a generic schema cannot do better here.
 *
 * This is the only *strict* layer in the stack: the protocol's own schema is
 * deliberately lenient (`x-deserialize-default-on-error`, and items skipped rather
 * than rejected), so the Rust layer has already defaulted or dropped whatever it
 * could before a frame arrives. What that means for `invalid-response` is that it
 * reports a frame the host cannot use — not necessarily a frame the engine got
 * wrong, and never a frame whose damaged parts could be restored here.
 */

import { AgentFailure } from './failure'
import type { AgentEvent, AgentIdentity } from './envelope'
import type { AgentEventKind, AgentPayloads } from './payloads'
import { asRecord, str } from './readers/fields'
import {
  readConfigChanged,
  readContextUsage,
  readModeChanged,
  readRunFailure,
  readRunResult,
  readSessionChanged,
} from './readers/session'
import { readCommands, readPlan, readText } from './readers/stream'
import { readFilesChanged, readPermissionRequest, readToolUpdate } from './readers/tools'

function invalid(message: string): AgentFailure {
  return new AgentFailure('invalid-response', message)
}

/**
 * The per-kind readers, and the only place the correlation between a kind and its
 * payload exists at runtime. The mapped type makes this exhaustive: a new kind in
 * `AgentPayloads` is a missing entry here, not a kind that slips through unvalidated.
 */
const payloadReaders: {
  [K in AgentEventKind]: (raw: unknown) => AgentPayloads[K] | null
} = {
  'text-delta': readText,
  'user-delta': readText,
  'thought-delta': readText,
  'tool-update': readToolUpdate,
  'permission-request': readPermissionRequest,
  'commands-changed': readCommands,
  'plan-changed': readPlan,
  'mode-changed': readModeChanged,
  'config-changed': readConfigChanged,
  'session-changed': readSessionChanged,
  'usage-changed': readContextUsage,
  'files-changed': readFilesChanged,
  'run-finished': readRunResult,
  'run-failed': readRunFailure,
}

function readIdentity(envelope: Record<string, unknown>): AgentIdentity | AgentFailure {
  const agentId = str(envelope, 'agentId')
  const profileId = str(envelope, 'profileId')
  const runtimeEpoch = str(envelope, 'runtimeEpoch')
  const vaultId = str(envelope, 'vaultId')
  const sessionId = str(envelope, 'sessionId')
  if (!agentId || !profileId || !runtimeEpoch || !vaultId || !sessionId) {
    return invalid(
      'the event identity is incomplete: agentId, profileId, runtimeEpoch, vaultId and sessionId are all required',
    )
  }
  return { agentId, profileId, runtimeEpoch, vaultId, sessionId }
}

/**
 * Narrow one frame into an event, or say why it is not one.
 *
 * Fields this host does not know are ignored — an engine that adds one must not break
 * a window that has not been rebuilt — while a required field that is missing or
 * malformed is an `invalid-response` naming the kind. The failure is a return value,
 * not a throw: this runs on the receive path, where a bad frame is an input to report
 * rather than an exception to unwind.
 *
 * The check is per-event and stateless by design. Ordering, duplication and staleness
 * are properties of a *sequence* of events, so they belong to the reducer that holds
 * the session's state — a lone frame cannot be judged against a sequence it is not
 * part of.
 */
export function readAgentEvent(raw: unknown): AgentEvent | AgentFailure {
  const envelope = asRecord(raw)
  if (!envelope) return invalid('the event envelope is not an object')

  const identity = readIdentity(envelope)
  if (identity instanceof AgentFailure) return identity

  const runId = envelope.runId
  if (runId !== null && typeof runId !== 'string') {
    return invalid('runId must be a string or null')
  }

  const sequence = envelope.sequence
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    return invalid('sequence must be a non-negative integer')
  }

  // `Object.hasOwn` rather than `in`: the reader map is an ordinary object, so `in`
  // would let a kind of `toString` reach a payload reader that does not exist.
  const kind = envelope.kind
  if (typeof kind !== 'string' || !Object.hasOwn(payloadReaders, kind)) {
    return invalid(`unknown event kind: ${String(kind)}`)
  }

  const payload = payloadReaders[kind as AgentEventKind](envelope.payload)
  if (!payload) return invalid(`malformed ${kind} payload`)

  // The reader map above is what correlates kind with payload; TypeScript cannot
  // follow a lookup through it, so this is the one cast in the module.
  return { ...identity, runId, sequence, kind, payload } as AgentEvent
}
