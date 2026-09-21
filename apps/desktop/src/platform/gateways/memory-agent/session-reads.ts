/**
 * The calls that answer about a session without changing it: its snapshot, the subscription
 * taken from one, the engine's capability report, and the refusal that says a change cannot
 * be put back.
 *
 * They share the one rule that makes them reads — a crash must not hide what the host
 * already knows, so the handle is checked and the engine is not asked — and they change
 * together for one reason: what a reader may still be told about a session whose runtime is
 * no longer the live one.
 */

import {
  AGENT_CAPABILITY_FEATURES,
  AGENT_CAPABILITY_HOST_OFFERS,
  type AgentCapabilityReport,
  type AgentChangeRecovery,
  type AgentEvent,
  type AgentSession,
  type AgentSessionSnapshot,
} from '../agent-contracts'
import { unverifiedCapability } from './scenario'
import { snapshotOf, subscribeTo } from './session'
import { engineCall, recordFor, type LiveRuntime } from './runtime'

/**
 * The double holds no files, so it holds no change to put back.
 *
 * `no-baseline` is the honest arm rather than a stub that pretends: this double's sessions are
 * conversations with no vault behind them, and every file fact a real host would answer about
 * — what a path held before an agent's write — is a fact about a disk this object does not
 * have. A panel driven by it therefore shows the refusal a real host gives for a file the
 * engine changed with its own tools, which is the state a reader reaches most often and the
 * one worth being able to see without an engine.
 *
 * The handle is still checked, because that part *is* this double's: a session it never minted
 * is refused exactly as `loadSession` refuses one, and a test that hands it a foreign handle
 * must see that rather than a plausible refusal about a file.
 */
export async function recoverChange(
  runtime: LiveRuntime,
  session: AgentSession,
  path: string,
): Promise<AgentChangeRecovery> {
  engineCall(runtime, session)
  return { kind: 'refused', path, code: 'no-baseline' }
}

export async function capabilities(
  runtime: LiveRuntime,
  session: AgentSession,
): Promise<readonly AgentCapabilityReport[]> {
  // A handle check, not an engine call: `crash` must not hide the report, because the report is
  // what a page draws to say what the engine could not do — and a session of a *previous*
  // runtime is refused here exactly as it is everywhere else.
  recordFor(runtime, session.sessionId)
  const declared = runtime.options.capabilities ?? {}
  // Every feature, from the contract's one list, in its order: a double that answered only the
  // features a test named would be teaching a page to expect a short report, and the short
  // report is the failure §3.4's row exists to prevent.
  return AGENT_CAPABILITY_FEATURES.map((feature) => ({
    feature,
    declared: 'unverified',
    finding: declared[feature] ?? unverifiedCapability(feature),
    // From the contract's table rather than from an option: what this app offers is a fact
    // about this build's own command surface, and a row whose `host` moved with a test's script
    // would be teaching a page that this app's half is the engine's to report.
    host: AGENT_CAPABILITY_HOST_OFFERS[feature],
  }))
}

export async function snapshot(
  runtime: LiveRuntime,
  session: AgentSession,
): Promise<AgentSessionSnapshot> {
  return snapshotOf(recordFor(runtime, session.sessionId))
}

export async function subscribe(
  runtime: LiveRuntime,
  from: AgentSessionSnapshot,
  onEvent: (event: AgentEvent) => void,
): Promise<() => void> {
  return subscribeTo(recordFor(runtime, from.identity.sessionId), from, onEvent)
}
