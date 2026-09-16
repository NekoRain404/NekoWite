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

use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, SessionConfigKind, SessionConfigOption, SessionConfigSelectOption,
    SessionConfigSelectOptions, SessionUpdate,
};
use serde::Serialize;

use super::process::{FRAME_TOO_LARGE_MARKER, MAX_FRAME_BYTES};
use serde_json::{Value, json};

/// What an envelope means to the app.
///
/// A kind is a promise that a component can render it, so one appears here exactly
/// when the host has a *producer* for it: `normalize_update` below, the emitter the
/// runtime publishes through, and the permission tables are the whole of what
/// publishes on this enum. The plan's §6.2 list is the floor and the frozen contract
/// (`agent-contracts/payloads.ts`) is the ceiling — the contract owns the spelling,
/// and it is wider than this enum on purpose, carrying a kind for every stable
/// `SessionUpdate` the pinned schema names. `ConfigChanged` is the first kind here
/// that the plan's list does not name: the engine can send one, so the host can
/// forward one, and both vocabularies already declared it.
///
/// `PermissionRequest` is the one kind that is not emitted from here —
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
    ConfigChanged,
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
///   updates, session metadata and usage, compaction, and the `Other` escape hatch.
///   §6.2 requires that `unknown` never reaches a component, so an update this host
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
        // The engine's own option list — the model selector among its entries, plus
        // whatever else the engine offers — as the full set with its current values.
        // The same kind of fact as the command list above (the engine telling the
        // session what it now offers), and forwarded for the same reason: the
        // contract declares the kind, the window's reducer keeps `view.config` from
        // it, and a frame dropped here is the one thing that keeps the panel from
        // ever showing an engine's own options.
        //
        // **The payload is mapped, not passed through.** The schema and the contract
        // do not share a shape for this one (see `config_options` below), and the
        // contract is the frozen side: `readConfigChanged` reads `{ options: [{ id,
        // name, description?, value }] }` and nothing else.
        SessionUpdate::ConfigOptionUpdate(update) => Some((
            AgentEventKind::ConfigChanged,
            json!({ "options": config_options(&update.config_options) }),
        )),
        _ => None,
    }
}

/// The schema's option list, in the contract's shape.
///
/// Three differences, and each one is a reason this is a mapping rather than a
/// pass-through:
///
///  - the discriminator. The contract tags the *value* (`value.kind`), the wire
///    flattens a `type` onto the option itself (`select` / `boolean`) — the two do
///    not even agree on how to spell "kind" (`toggle` and `boolean`);
///  - the current value: `value.current` against the wire's `currentValue`;
///  - a select's choices: an untagged union on the wire (a flat list, or a list of
///    *groups* of them) and a flat list in the contract. The grouped case is
///    flattened here, which loses the group's name — `AgentConfigChoice` has nowhere
///    to put it. That is the residual T4b §7 reported (the same flattening
///    `tauri-agent/session.ts` does for the catalog), not a decision taken here.
///
/// An option whose type this host cannot express is left out rather than sent as
/// something it is not: the contract's reader refuses a whole payload containing one
/// entry it cannot read, so a single unreadable option would cost the engine's entire
/// list. Nothing reaches that arm from the wire today — the schema skips an option it
/// cannot deserialize — which is why leaving it out is a floor rather than a policy.
fn config_options(options: &[SessionConfigOption]) -> Vec<Value> {
    options.iter().filter_map(config_option).collect()
}

/// One option, or `None` for a kind the contract has no arm for.
fn config_option(option: &SessionConfigOption) -> Option<Value> {
    let value = match &option.kind {
        SessionConfigKind::Select(select) => json!({
            "kind": "select",
            "current": select.current_value.to_string(),
            "choices": config_choices(&select.options),
        }),
        SessionConfigKind::Boolean(toggle) => json!({
            "kind": "toggle",
            "current": toggle.current_value,
        }),
        // `SessionConfigKind` is `#[non_exhaustive]`: a type the pinned schema does not
        // name yet is a shape this host cannot put in the contract's two arms.
        _ => return None,
    };
    let mut mapped = json!({
        "id": option.id.to_string(),
        "name": option.name,
        "value": value,
    });
    // Absent and empty differ: the contract's `description` is optional, and an engine
    // that sent none did not send an empty one.
    if let Some(description) = &option.description {
        mapped["description"] = json!(description);
    }
    Some(mapped)
}

/// A select's choices, in one flat list, in the engine's order.
fn config_choices(options: &SessionConfigSelectOptions) -> Vec<Value> {
    fn choice(option: &SessionConfigSelectOption) -> Value {
        let mut mapped = json!({
            "value": option.value.to_string(),
            "name": option.name,
        });
        if let Some(description) = &option.description {
            mapped["description"] = json!(description);
        }
        mapped
    }

    match options {
        SessionConfigSelectOptions::Ungrouped(values) => values.iter().map(choice).collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter().map(choice))
            .collect(),
        // `#[non_exhaustive]`, as above: a grouping this host has never seen is not a
        // set of choices it may invent.
        _ => Vec::new(),
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
