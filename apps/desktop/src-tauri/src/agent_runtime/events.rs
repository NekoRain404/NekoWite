//! The host's own vocabulary for what the engine did.
//!
//! The protocol's frames are not the app's event contract — §6.2 says so in its
//! first line, and that is the section's real point. Ids on the wire are
//! per-connection, the engine has no host-wide ordering, and a `SessionUpdate`
//! variant is a protocol detail no Vue component should ever match on. This
//! module is the one place that translation happens, so a change on the wire
//! lands here and nowhere else.
//!
//! The discriminator is matched as a typed enum rather than as a JSON string:
//! `agent-client-protocol` already owns those shapes, including the
//! `_meta`/unknown-field tolerance the schema carries, and re-deriving them
//! from raw JSON here would be the second implementation this task exists to
//! avoid.
//!
//! It is also where a failure is described: [`TransportError`] and the way it
//! maps onto [`AgentFailureCode`] sit next to the codes themselves, because the
//! mapping and the codes are one decision — P0 §2.4 measured a failure that had
//! no code, and the two had to change together.
//!
//! The TypeScript side of the envelope is written in parallel (T1) against the
//! plan's field list — the list here is that contract, kept in step by hand,
//! and NOT an import.

use agent_client_protocol::schema::v1::{ContentBlock, ContentChunk, SessionUpdate};
use serde::Serialize;

use super::process::{FRAME_TOO_LARGE_MARKER, MAX_FRAME_BYTES};
use serde_json::{Value, json};

/// What an envelope means to the app.
///
/// The plan's list, plus nothing: a kind is a promise that a component can
/// render it. `PermissionRequest` is present but is not emitted from here —
/// engine→client permission requests are answered through the transport, and
/// no such frame has ever been observed (P0 §4, confirmed by §6.2), so the kind
/// exists to fix its spelling before T3/T7 find out what one looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentEventKind {
    TextDelta,
    ToolUpdate,
    PermissionRequest,
    CommandsChanged,
    FilesChanged,
    RunFinished,
    RunFailed,
}

/// Why a run or the runtime failed.
///
/// The plan's list verbatim, with one addition: `CertificateUntrusted`. P0 §2.4
/// measured a failure the plan's list has no home for — the engine reports an
/// untrusted certificate as `-32603 Internal error: unknown certificate
/// verification error`, which is a different condition from every code above
/// and one the UI must explain differently (the host's chain is fine; the
/// engine's store does not know it). Squeezing it into `invalid-response` would
/// put a TLS trust problem in front of the user labelled as a protocol bug.
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
}

/// Everything that can go wrong between issuing a request and reading its
/// answer.
#[derive(Debug, Clone)]
pub enum TransportError {
    /// No answer within the caller's bound.
    Timeout { method: String },
    /// The connection is over: the engine exited, or its side of the transport
    /// closed. Every request still outstanding fails with this.
    Disconnected { detail: String },
    /// The engine negotiated a protocol this host does not implement.
    ProtocolIncompatible { found: u16 },
    /// The engine answered with a JSON-RPC error.
    Engine { message: String },
}

impl TransportError {
    /// The condition, as the contract names it.
    pub fn failure_code(&self) -> AgentFailureCode {
        match self {
            TransportError::Timeout { .. } => AgentFailureCode::Timeout,
            TransportError::Disconnected { .. } => AgentFailureCode::ProcessExited,
            TransportError::ProtocolIncompatible { .. } => AgentFailureCode::ProtocolIncompatible,
            TransportError::Engine { message } if certificate_failure(message) => {
                AgentFailureCode::CertificateUntrusted
            }
            // Engine-side codes beyond the measured one are not mapped: P0 §4
            // lists permissions and authentication as unverified, so guessing
            // which failure means "authentication required" would be inventing
            // the mapping T3/T7 are meant to measure.
            TransportError::Engine { .. } => AgentFailureCode::InvalidResponse,
        }
    }

    /// The sentence the user sees.
    ///
    /// Only the certificate case is reworded, and P0 §2.4 requires it: the
    /// engine's own text for it names neither the host nor the remedy, and
    /// §2.4 forbids passing that string on. Every other engine message is kept
    /// as it is — it is the engine's own words about its own failure, and this
    /// layer has nothing better to say.
    pub fn failure_message(&self) -> String {
        if self.failure_code() == AgentFailureCode::CertificateUntrusted {
            return "the engine could not verify the server's certificate. The server's chain \
                    may be issued by an authority the engine's CA store does not contain — an \
                    internal or brand-new root — or the system CA store may be missing or out \
                    of date. The connection was not attempted insecurely."
                .to_string();
        }
        match self {
            TransportError::Timeout { method } => {
                format!("the engine did not answer {method} in time")
            }
            TransportError::Disconnected { detail } => {
                format!("the engine connection closed: {detail}")
            }
            TransportError::ProtocolIncompatible { found } => {
                format!("the engine speaks ACP protocol version {found}, which this app does not")
            }
            TransportError::Engine { message } => message.clone(),
        }
    }
}

/// Turns an SDK error into this crate's vocabulary.
pub(super) fn classify(error: agent_client_protocol::Error) -> TransportError {
    // The bound reports itself through the reader's error text, and it deserves
    // its own sentence: "the connection closed" would send the reader looking
    // for a crash that did not happen.
    if error.to_string().contains(FRAME_TOO_LARGE_MARKER) {
        return TransportError::Engine {
            message: format!(
                "the engine sent a frame larger than the {MAX_FRAME_BYTES}-byte limit, so the run \
                 was stopped rather than buffered"
            ),
        };
    }
    if agent_client_protocol::is_incoming_transport_closed(&error) {
        return TransportError::Disconnected {
            detail: error.to_string(),
        };
    }
    TransportError::Engine {
        message: error.to_string(),
    }
}

/// Whether an engine error is the certificate condition of P0 §2.4.
///
/// The engine gives it no code of its own — it arrives as the generic `-32603
/// Internal error` — so the message is the only evidence there is. The match is
/// kept narrow for that reason: it must contain `certificate` and one of the
/// phrasings the TLS libraries actually use, so that an unrelated internal
/// error is not relabelled as a trust problem and sent down the wrong advice.
fn certificate_failure(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("certificate")
        && [
            "unknown certificate verification error",
            "unable to verify",
            "self-signed",
            "self signed",
            "certificate has expired",
            "unable to get local issuer",
            "depth lookup",
        ]
        .iter()
        .any(|phrase| message.contains(phrase))
}

/// Who is speaking, for the composite identity check of §6.1.
///
/// The host stamps every envelope with all four, so that a frame delayed across
/// a vault switch, a profile change or an app restart can be recognized as
/// belonging to a runtime that is no longer current instead of being applied to
/// whatever session happens to be open now. A session id alone cannot carry
/// that: the engine issues its own session ids and knows nothing about which
/// vault the user has in front of them.
#[derive(Debug, Clone)]
pub struct AgentIdentity {
    pub agent_id: String,
    pub profile_id: String,
    /// Identifies one incarnation of the runtime; a restart makes a new one.
    pub runtime_epoch: String,
    pub vault_id: String,
}

/// One host event, ready for the IPC boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub agent_id: String,
    pub profile_id: String,
    pub runtime_epoch: String,
    pub vault_id: String,
    pub session_id: String,
    /// `None` for an event that belongs to the session rather than to one
    /// generation — the command list arrives that way, measured in P0 §2.2.
    pub run_id: Option<String>,
    /// The HOST's counter, not the engine's: the engine has no notion of a
    /// single ordered stream across sessions, and the UI needs one number it
    /// can compare to decide whether an event is newer than what it applied.
    pub sequence: u64,
    pub kind: AgentEventKind,
    pub payload: Value,
}

/// A `session/update` turned into the host's vocabulary.
///
/// `None` means "deliberately not forwarded", and the reasons are different
/// enough to name:
///
/// - **`AgentThoughtChunk`** — measured in P0 §2.3 and absent from the plan's
///   kind list. The plan forbids showing *invented* reasoning (§5.1) and this
///   channel is not invented, so it is a real decision rather than an
///   oversight — but it is the contract's decision (T1 was asked to make it),
///   and this layer must not make it by accident. Dropping is the choice that
///   cannot put a fake "thinking" line in front of a user if the contract never
///   grows a place for it; adding the kind later is one arm here.
/// - **everything else the schema can name** — user echoes, plan frames, mode
///   and config-option updates, compaction, and the `Other` escape hatch. §6.2
///   requires that `unknown` never reaches a component, so an update this host
///   has no kind for is not forwarded as a mystery blob to be guessed at.
pub fn normalize_update(update: &SessionUpdate) -> Option<(AgentEventKind, Value)> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            let text = text_of(chunk)?;
            Some((AgentEventKind::TextDelta, json!({ "text": text })))
        }
        // P0 §6.1: a tool call is a `ToolCall` followed by `ToolCallUpdate`
        // frames whose `status` runs pending → in_progress → completed, with
        // `toolCallId` as the key that ties the three together. Both are
        // forwarded verbatim: the shape is the schema's, and re-packaging it
        // here would only lose the fields T5 needs to correlate them.
        SessionUpdate::ToolCall(call) => {
            Some((AgentEventKind::ToolUpdate, json!({ "update": call })))
        }
        SessionUpdate::ToolCallUpdate(update) => {
            Some((AgentEventKind::ToolUpdate, json!({ "update": update })))
        }
        // Measured in P0 §2.2: the command list arrives as a notification after
        // `session/new`, replaces the previous list whole, and carries the
        // engine's own command names.
        SessionUpdate::AvailableCommandsUpdate(commands) => Some((
            AgentEventKind::CommandsChanged,
            json!({ "commands": commands.available_commands }),
        )),
        _ => None,
    }
}

/// The text of a chunk, when it carries any.
///
/// A chunk is a content block, and only a text block has text: an image or a
/// resource link in the same stream is not a hole in the message, it is a part
/// this host has no kind for, and returning `None` keeps it from being rendered
/// as an empty string.
fn text_of(chunk: &ContentChunk) -> Option<String> {
    match &chunk.content {
        ContentBlock::Text(text) => Some(text.text.clone()),
        _ => None,
    }
}
