/**
 * The failure vocabulary: what a gateway call or a turn can fail as.
 *
 * The list is a runtime value because the validator has to check a code that
 * arrives from outside the process, and the type is derived from it so a code
 * cannot exist in one without existing in the other.
 *
 * It is the plan's §6.2 list plus one extension, marked where it sits: P0 §2.4
 * measured that a certificate the runtime cannot verify fails with a message a
 * user cannot act on, and that it has to be recognised as its own condition — so
 * it needs a code of its own rather than arriving as unrecognised text. The ten
 * below are verbatim and in the plan's order.
 */
/**
 * Every code above. Exported as a value for the caller that has to map a foreign
 * runtime's errors onto this vocabulary, and for the tests that hold the
 * validator to each of them.
 */
export const AGENT_FAILURE_CODES = [
  'runtime-unavailable',
  'protocol-incompatible',
  'authentication-required',
  'permission-denied',
  'cancelled',
  'session-stale',
  'buffer-conflict',
  'process-exited',
  'timeout',
  'invalid-response',
  // Extension. P0 §2.4: without a sandbox CA the engine fails every prompt with
  // "unknown certificate verification error" — a valid certificate chain the
  // engine's bundled CA set does not know. It is a condition the user can act on
  // (a missing system CA, a self-signed or enterprise root), not an internal
  // error, so the boundary has to carry it classified instead of degrading it to
  // whatever unrecognised codes fall back to. Never a reason to disable
  // verification.
  'certificate-untrusted',
  // Extension. §6.2 allows one active generation per session, and a second one arriving is a
  // condition of its own — one this vocabulary had no name for, so two layers refused it under
  // borrowed ones and told every reader the wrong fact. `tauri-agent.ts` said `buffer-conflict`,
  // which is this list's word for a *stream* that cannot be continued (a sequence older than the
  // replay buffer) or a view that outgrew what the host will hold (`agent-event-reducer.ts`'s
  // capacity abort); `session.rs` said `cancelled`, which says the turn ended rather than that it
  // is still running. A reader had to open both sources to learn what either code meant, which is
  // the proof. This is the condition's own name, and it is what both layers answer now.
  'turn-in-flight',
  // Extension. A turn carried a content block that ACP requires the *client* to have checked the
  // engine's `promptCapabilities` for, and the engine's handshake did not report it. The host
  // refuses before the frame is built, so nothing was sent and the engine never saw a call it did
  // not say it answers. Not `invalid-response` — that is a frame this window could not read — and
  // not `buffer-conflict`, which is this list's word for a stream or a session's state; a reader
  // told either would go looking for a protocol bug instead of at the engine's own report.
  'attachment-unsupported',
  // Extension. A reopen named a session this host already holds, so there is nothing to do: the
  // row the reader pressed is the conversation they are in. It arrived as `buffer-conflict` —
  // this list's word for a *stream* that cannot be continued — which named neither the session
  // nor its state, and the host's own `SessionError::AlreadyOpen` carried the same borrowed word
  // from the other side (`session.rs`). Not `turn-in-flight`: nothing is running, and the two
  // refusals leave the reader different things to do.
  'session-open',
  // Extension, and its own code rather than `session-open` because the two are different facts
  // about one click: this one says the conversation is still coming back and waiting is what
  // there is to do. A reader told "already open" stops trying, which is the expensive direction
  // for a condition that lasts a moment — so the transient half is the one that most needed the
  // word it did not have.
  'load-in-flight',
] as const

export type AgentFailureCode = (typeof AGENT_FAILURE_CODES)[number]

/** The one runtime test of that list, kept next to it so the two stay together. */
export function isAgentFailureCode(raw: unknown): raw is AgentFailureCode {
  return typeof raw === 'string' && (AGENT_FAILURE_CODES as readonly string[]).includes(raw)
}

/**
 * A failure the gateway reports.
 *
 * It is thrown by the gateway's methods and *returned* by `readAgentEvent`: a
 * frame that cannot be understood is an expected input on the receive path, not
 * an exception. `code` is what callers branch and render on; `message` carries
 * the detail a person needs to see.
 *
 * It is a class rather than a plain object so that a rejected promise carries an
 * `Error` like every other rejection in this codebase — but it must never be
 * used as an event payload: payloads cross the Tauri IPC boundary, where a class
 * instance serializes to `{}` and loses both fields. `run-failed` therefore
 * carries the same two fields as plain data.
 */
export class AgentFailure extends Error {
  readonly code: AgentFailureCode

  constructor(code: AgentFailureCode, message: string) {
    super(message)
    this.name = 'AgentFailure'
    this.code = code
  }
}
