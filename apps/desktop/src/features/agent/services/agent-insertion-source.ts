/**
 * Where an SVG insertion is bound, as the surface that offers one needs it.
 *
 * Structural rather than the composition's own type: this feature declares the one method it calls,
 * and `app/agent-composition.ts` — which is the assembly site for this surface, not its dependency —
 * happens to satisfy it. A feature that imported the composition's type would be the arrow pointing
 * the wrong way, which is the same note `live-note-responder.ts` carries about the editor's lookup.
 */
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type {
  AgentInsertionCapture,
  AgentInsertionOutcome,
  AgentInsertionPlanRequest,
  AgentInsertionPlanResult,
  AgentSvgInsertionPlan,
} from './agent-svg-insertion'

/**
 * The insertion service, bound to a session and an editor.
 *
 * Declared HERE rather than beside the object that implements it: every type in the signature is
 * this feature's own, and the binding is the feature's interface that `app/agent-composition.ts`
 * implements. It was declared in the assembly site, which put the vocabulary in a file whose job is
 * choosing adapters — and left the feature unable to name the thing it is handed without importing
 * upwards, which is the arrow this module's header says must not happen.
 *
 * `plan` takes the request without its identity — the binding's is the one in force — so a call site
 * cannot plan an insertion for a session it does not hold, and every plan carries the identity that
 * {@link AgentSvgInsertionBinding.commit} re-checks.
 */
export interface AgentSvgInsertionBinding {
  readonly identity: AgentIdentity
  /** The target for a spot in a note, or why that spot cannot be inserted into. */
  capture(path: string, from: number, to: number): AgentInsertionCapture
  plan(request: Omit<AgentInsertionPlanRequest, 'identity'>): AgentInsertionPlanResult
  /** The note edit. The caller reports whether it has already written the attachment, because the
   *  order cannot be checked here and a note must not link a file nothing wrote. */
  commit(plan: AgentSvgInsertionPlan, attachmentSaved: boolean): AgentInsertionOutcome
}

/** Where an SVG insertion is bound. The composition is the one implementation. */
export interface AgentInsertionSource {
  connectSvgInsertion(identity: AgentIdentity): AgentSvgInsertionBinding
}
