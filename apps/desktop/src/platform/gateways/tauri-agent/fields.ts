/**
 * The shared predicates the mapping is built from.
 *
 * The same four the contract's own validator uses (`agent-contracts/readers/fields.ts`), and
 * for the same reason that file gives: a frame arriving from outside this process is `unknown`
 * until something checks it, and a bounded union of hand-written checks is clearer than a
 * schema language here. They are local rather than imported because that module is internal to
 * the contract — the barrel exports the reader, not its parts — and because the two have
 * different jobs: those read a *valid* payload, these decide whether a payload is one this
 * adapter can build at all.
 */

import { AgentFailure } from '../agent-contracts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * What the composite keys in this adapter are joined with.
 *
 * A tool call and a run are both keyed by several identity fields (agent, profile, epoch,
 * session, and the engine's own id), and a separator that can appear *inside* a part would let
 * two different tuples join into the same string — which, for a projection keyed that way, means
 * one engine's row completing another's frame. No id, epoch or session name can contain a NUL,
 * so a joined key cannot be ambiguous.
 *
 * Written as a call rather than as an escape in a string literal so the source stays plain
 * ASCII: a literal NUL byte in a source file makes every tool that reads it treat the file as
 * binary.
 */
export const KEY_SEPARATOR = String.fromCharCode(0)

/** A field that has to be there and has to say something. The contract's readers refuse an
 *  empty id or title, so an empty string is not a value this adapter may pass on. */
export function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function invalid(message: string): AgentFailure {
  return new AgentFailure('invalid-response', message)
}

/** A token count, where a token count is what the field holds. `Number.isSafeInteger` and the
 *  sign are checked because a negative or fractional token count is a number the panel would
 *  render and the user would have to disbelieve. */
export function count(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null
}
