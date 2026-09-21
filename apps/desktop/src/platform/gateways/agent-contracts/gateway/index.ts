/**
 * The gateway surface, at the path every caller already imports.
 *
 * `./gateway` was one file and is now this directory, so `tauri-agent.ts`, `memory-agent/`,
 * `readers/session.ts` and the `agent-contracts.ts` barrel keep the specifier they had. The pieces
 * are divided by what makes them change:
 *
 *  - `gateway/session.ts`      the lifecycle, the handle, and the engine's own session table
 *  - `gateway/capabilities.ts` §3.4's capability row, feature by feature
 *  - `gateway/recovery.ts`     why a change could not be put back
 *  - `gateway/calls.ts`        the calls the app makes, and the point a subscription continues from
 *
 * Names are re-exported one by one rather than with `export *`, the way `agent-contracts.ts` does it
 * and for the reason it gives: this is a contract, so what it offers should be a list somebody
 * chose, and a name that disappears from it should be a failing typecheck rather than a silent
 * absence.
 */

export { AGENT_SESSION_STATES, isAgentSessionState } from './session'
export type {
  AgentModelOption,
  AgentSession,
  AgentSessionHistory,
  AgentSessionState,
  AgentSessionSummary,
} from './session'
export { AGENT_CAPABILITY_FEATURES, AGENT_CAPABILITY_HOST_OFFERS } from './capabilities'
export type {
  AgentCapabilityDeclaration,
  AgentCapabilityFeature,
  AgentCapabilityFinding,
  AgentCapabilityOffer,
  AgentCapabilityReport,
} from './capabilities'
export { AGENT_RECOVERY_REFUSALS } from './recovery'
export type { AgentChangeRecovery, AgentRecoveryRefusalCode } from './recovery'
export type { AgentGateway, AgentOpenRequest, AgentSessionSnapshot } from './calls'
