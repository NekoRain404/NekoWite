/**
 * The agent runtime contract — the public entry point.
 *
 * This path is the one every other task imports, so the split behind it is an
 * implementation detail. The pieces are divided by what they are about, not by size,
 * because a reader arriving at "how do I send a prompt" and a reader arriving at
 * "what does the engine's frame have to look like" are asking different questions:
 *
 *  - `agent-contracts/payloads.ts`       the payload vocabulary, one type per kind
 *  - `agent-contracts/envelope.ts`       the identity, the sequence, the kind/payload correlation
 *  - `agent-contracts/gateway.ts`        the calls the app makes, and the state it reads back
 *  - `agent-contracts/failure.ts`        the failure codes and the error they are carried in
 *  - `agent-contracts/validation.ts`     the one place a frame becomes a typed event
 *  - `agent-contracts/readers/*.ts`      the per-kind readers, by subject
 *
 * The kinds are `keyof` the payload map rather than a separate list, so a kind cannot
 * exist without a payload type; that is also why the payload types and the kind list
 * live in one module.
 *
 * Names are re-exported one by one rather than with `export *`, the way
 * `platform/gateways/memory.ts` does it: this is a contract, so what it offers should
 * be a list somebody chose, and a name that disappears from it should be a failing
 * typecheck rather than a silent absence.
 */

export { AGENT_FAILURE_CODES, AgentFailure, isAgentFailureCode } from './agent-contracts/failure'
export type { AgentFailureCode } from './agent-contracts/failure'

export { AGENT_PROMPT_ATTACHMENT_KINDS, AGENT_STOP_REASONS, promptAttachmentLabel } from './agent-contracts/payloads'
export type {
  AgentCommand,
  AgentConfigChoice,
  AgentConfigOption,
  AgentConfigOptionList,
  AgentConfigValue,
  AgentContextUsage,
  AgentCost,
  AgentEventKind,
  AgentPayloads,
  AgentPermissionKind,
  AgentPermissionOption,
  AgentPermissionRequest,
  AgentPlanEntry,
  AgentPromptAttachment,
  AgentRunEnding,
  AgentRunResult,
  AgentStopReason,
  AgentToolContent,
  AgentToolInput,
  AgentToolKind,
  AgentToolStatus,
  AgentUsage,
} from './agent-contracts/payloads'

export type { AgentEvent, AgentEventEnvelope, AgentIdentity } from './agent-contracts/envelope'

export { readAgentEvent } from './agent-contracts/validation'
export {
  readCapabilityReports,
  readChangeRecovery,
  readSessionHistory,
} from './agent-contracts/readers/session'

export {
  AGENT_CAPABILITY_FEATURES,
  AGENT_CAPABILITY_HOST_OFFERS,
  AGENT_RECOVERY_REFUSALS,
  AGENT_SESSION_STATES,
  isAgentSessionState,
} from './agent-contracts/gateway'
export type {
  AgentCapabilityDeclaration,
  AgentCapabilityFeature,
  AgentCapabilityFinding,
  AgentCapabilityOffer,
  AgentCapabilityReport,
  AgentChangeRecovery,
  AgentGateway,
  AgentModelOption,
  AgentOpenRequest,
  AgentRecoveryRefusalCode,
  AgentSession,
  AgentSessionHistory,
  AgentSessionSnapshot,
  AgentSessionState,
  AgentSessionSummary,
} from './agent-contracts/gateway'
