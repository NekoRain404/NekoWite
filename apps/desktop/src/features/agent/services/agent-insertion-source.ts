/**
 * Where an SVG insertion is bound, as the surface that offers one needs it.
 *
 * Structural rather than the composition's own type: this feature declares the one method it calls,
 * and `app/agent-composition.ts` — which is the assembly site for this surface, not its dependency —
 * happens to satisfy it. A feature that imported the composition's type would be the arrow pointing
 * the wrong way, which is the same note `live-note-responder.ts` carries about the editor's lookup.
 */
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentSvgInsertionBinding } from './agent-svg-insertion'

export interface AgentInsertionSource {
  connectSvgInsertion(identity: AgentIdentity): AgentSvgInsertionBinding
}
