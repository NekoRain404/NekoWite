/**
 * The frames more than one Tauri-agent suite feeds through the adapter.
 *
 * They live here rather than beside one suite because they are *measured* shapes — P0 §2.3 and
 * §6.1's captures — and a second copy of one is a second reading of one fact, which is the failure
 * the mapping suite exists for: the Rust runtime and this contract once disagreed about three frame
 * shapes with both suites green. What is shared is the identity every frame carries, the host
 * envelope builder, and `run-finished`'s measured ending; the frames a single suite reads (the
 * wrapped tool calls, the engine's option list) stay beside that suite.
 */

export const IDENTITY = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-1',
  sessionId: 'ses_fake_1',
}

/** A host envelope, in the shape `AgentEventEnvelope` serializes to (`#[serde(rename_all =
 *  "camelCase")]` on the Rust struct): the identity, the run, the host's sequence, the kind. */
export function frame(
  kind: string,
  payload: unknown,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...IDENTITY, runId: 'run-0', sequence: 7, kind, payload, ...overrides }
}

/** P0 §2.3's measured ending, with the fixture's own numbers: `{"stopReason":"end_turn",
 *  "usage":{"inputTokens":11,"outputTokens":2,"totalTokens":13,"thoughtTokens":1}}`, as the
 *  Rust runtime re-serializes it (`runs.rs`: `json!({ "stopReason": …, "usage": … })`). */
export const RUN_FINISHED = {
  stopReason: 'end_turn',
  usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13, thoughtTokens: 1 },
}
