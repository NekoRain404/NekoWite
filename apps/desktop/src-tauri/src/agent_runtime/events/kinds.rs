//! The closed vocabularies: what an envelope may mean, and why a run failed.
//!
//! Both enums are the *contract* rather than an implementation of it — every variant is a spelling
//! the window matches on, and the TypeScript half is kept in step by hand
//! (`agent-contracts/payloads/index.ts`). That is why they are here and not beside the code that
//! produces them: the frame mapping in `super::normalize` may learn a new shape and the failure
//! reading in `super::transport` may learn a new condition without moving a single name in these
//! two lists.
//!
//! What changes this file: a kind or a code is added, removed or respelled — and then the window's
//! parity pin is what has to be edited with it (`src/platform/gateways/agent-contracts-parity.test.ts`,
//! which reads this file rather than the parent, because reading the parent would find the `pub use`
//! and pass while the list it guards had drifted).

use serde::Serialize;

/// What an envelope means to the app.
///
/// A kind is a promise that a component can render it, so one appears here exactly
/// when the host has a *producer* for it: `super::normalize`'s `normalize_update`, the emitter the
/// runtime publishes through, and the permission tables are the whole of what
/// publishes on this enum. The plan's §6.2 list is the floor and the frozen contract
/// (`agent-contracts/payloads/index.ts`) is the ceiling — the contract owns the spelling,
/// and it is wider than this enum on purpose, carrying a kind for every stable
/// `SessionUpdate` the pinned schema names. `ConfigChanged` and `ThoughtDelta` are
/// the kinds here the plan's list does not name: the engine sends both, so the host
/// forwards both, and both vocabularies already declared them.
///
/// The two lists are not the same size and must not be forced to be. The contract
/// carries kinds this host has no producer for (`plan-changed`, `mode-changed`,
/// `session-changed`, `usage-changed`), and an enum arm with no producer would be a
/// promise nothing keeps. The direction that must stay empty is the other one: a kind
/// here that the contract cannot read is a frame the window refuses, so every variant
/// below has a spelling in `payloads.ts`.
///
/// `UserDelta` was on the producer-less list until the replay measurement found what
/// it cost: `session/load` does replay the user's turns, and the frame carrying them
/// fell to `_ => None`, so every restored conversation was silently missing half of
/// itself. The window had been able to draw it the whole time.
///
/// `PermissionRequest` is the one kind that is not emitted from here —
/// engine→client permission requests are answered through the transport, and
/// no such frame has ever been observed (P0 §4, confirmed by §6.2), so the kind
/// exists to fix its spelling before T3/T7 find out what one looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentEventKind {
    TextDelta,
    /// The engine's copy of the *user's* half (`user_message_chunk`), which is what it sends back
    /// when a session is restored.
    ///
    /// A kind of its own rather than `TextDelta`: the user's words belong on the user's side of
    /// the timeline, and the host's own row for the same message is a different statement about
    /// the conversation rather than a second half of one (the contract settled this at T1 —
    /// `payloads.ts`'s `'user-delta'`, and the timeline's `origin`). It is also Zed's reading of
    /// the same frame, which is where the decision comes from: `acp_thread.rs` pushes a
    /// `UserMessage` entry for it rather than appending to the answer.
    UserDelta,
    /// The engine's own disclosed reasoning (`agent_thought_chunk`), which P0 §2.3 measured on the
    /// wire beside the answer.
    ///
    /// A kind of its own rather than text: §5.1 forbids showing *invented* reasoning, not reasoning
    /// the engine chose to disclose, and the contract settled the same question the same way
    /// (`agent-contracts/payloads/index.ts`'s `'thought-delta'`, T1's §2). Folding it into
    /// `TextDelta` would put "thinking" on the answer's side of the timeline, which is the one
    /// outcome §5.1 cannot allow.
    ThoughtDelta,
    ToolUpdate,
    PermissionRequest,
    CommandsChanged,
    ConfigChanged,
    /// The session's context occupancy and cumulative cost (`usage_update`).
    ///
    /// The contract has carried this kind since T1 — `payloads.ts`'s `'usage-changed'`,
    /// `readContextUsage`, the reducer's arm and the view's `usage` — with no producer on this
    /// side, so the window was built to render a fact nothing here sent. **The pinned engine was
    /// measured sending the frame** (see the mapping below for where the sending code is), which is
    /// what makes this arm a producer rather than a promise.
    UsageChanged,
    FilesChanged,
    RunFinished,
    RunFailed,
}

/// Why a run or the runtime failed.
///
/// The plan's list verbatim, with two additions. `CertificateUntrusted`: P0 §2.4
/// measured a failure the plan's list has no home for — the engine reports an
/// untrusted certificate as `-32603 Internal error: unknown certificate
/// verification error`, which is a different condition from every code above
/// and one the UI must explain differently (the host's chain is fine; the
/// engine's store does not know it). Squeezing it into `invalid-response` would
/// put a TLS trust problem in front of the user labelled as a protocol bug.
///
/// `TurnInFlight`: §6.2 allows one active generation per session, and the
/// refusal this host answers a second one with had no code of its own — it was
/// published as `Cancelled`, which says the turn *ended*. The window's own
/// half of the same refusal (`tauri-agent.ts`) was published as
/// `BufferConflict`, which is this list's word for a stream that cannot be
/// continued. Both told a reader the wrong fact, and the answer that names the
/// condition is the same on both sides of the boundary.
///
/// `AttachmentUnsupported`: a block that needs a prompt capability ACP requires
/// the *client* to have checked, sent to an engine whose own handshake does not
/// report it. It is not `InvalidResponse` — that is a frame the host could not
/// read — and it is not `BufferConflict`, which is about a stream or a session's
/// state. The condition is that the engine said no to this kind of content, and a
/// reader told anything else would go looking for a protocol bug.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentFailureCode {
    RuntimeUnavailable,
    ProtocolIncompatible,
    AuthenticationRequired,
    PermissionDenied,
    Cancelled,
    SessionStale,
    BufferConflict,
    ProcessExited,
    Timeout,
    InvalidResponse,
    CertificateUntrusted,
    TurnInFlight,
    AttachmentUnsupported,
    /// A `session/load` named a session this host already holds.
    ///
    /// Extension. §6.2's state machine, said as a condition: the session is open, and the call
    /// asked to open it. It was published as `BufferConflict` — this list's word for a *stream*
    /// that cannot be continued (a sequence older than the replay buffer, a view that outgrew what
    /// the host holds) — which named neither the session nor its state, and sent a reader looking
    /// for a protocol bug. Not `TurnInFlight` either: nothing is running, and the two refusals
    /// leave the user different things to do.
    SessionOpen,
    /// A `session/load` for this session is already on the wire.
    ///
    /// Extension, and its own arm rather than [`Self::SessionOpen`] because the two are different
    /// facts about the same click: the first means there is nothing to do, the second means waiting
    /// is what there is to do. It was published as `BufferConflict` for the same reason the arm
    /// above was — and the transient one is the one where the wrong word costs the most, because a
    /// reader told "already open" stops trying.
    LoadInFlight,
}
