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
    ContentBlock, ContentChunk, Cost, SessionConfigKind, SessionConfigOption,
    SessionConfigSelectOption, SessionConfigSelectOptions, SessionUpdate,
};
use serde::Serialize;

use super::process::{FRAME_TOO_LARGE_MARKER, MAX_FRAME_BYTES};
use serde_json::{json, Value};

/// What an envelope means to the app.
///
/// A kind is a promise that a component can render it, so one appears here exactly
/// when the host has a *producer* for it: `normalize_update` below, the emitter the
/// runtime publishes through, and the permission tables are the whole of what
/// publishes on this enum. The plan's §6.2 list is the floor and the frozen contract
/// (`agent-contracts/payloads.ts`) is the ceiling — the contract owns the spelling,
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
    /// (`agent-contracts/payloads.ts`'s `'thought-delta'`, T1's §2). Folding it into `TextDelta`
    /// would put "thinking" on the answer's side of the timeline, which is the one outcome §5.1
    /// cannot allow.
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

/// Everything that can go wrong between issuing a request and reading its
/// answer.
#[derive(Debug, Clone)]
pub enum TransportError {
    /// No answer within the caller's bound.
    Timeout { method: String },
    /// The connection is over: the engine exited, or its side of the transport
    /// closed. Every request still outstanding fails with this.
    ///
    /// `detail` is the host's own sentence, and the transport appends the engine's last
    /// lines of stderr after it when it has any (`process::StderrLog::tail`): an engine
    /// that is gone has no other way left to say why. The appended text has been through
    /// `redact` before it is attached — it is read out of the log the pump filled, not
    /// off the pipe — so a failure sentence is still a place a credential cannot appear.
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
    ///
    /// The certificate sentence claims nothing the evidence cannot support, and
    /// the measurement that forced that is the live run's §5: the condition
    /// arrived once from a transient network fault, on a machine whose `curl`
    /// and `openssl` verified cleanly against the same CA bundle immediately
    /// before and after, and the two identical runs around it succeeded. The
    /// engine gives the transient case no code to tell it apart from a missing
    /// CA store — the same `-32603`/"unknown certificate verification error" is
    /// the whole of the evidence (see `certificate_failure` below) — so the
    /// sentence names the retry first, offers the CA cause as a likelihood
    /// *if the failure repeats*, and names the variable that addresses it. A
    /// confident diagnosis would send a user to change a CA configuration that
    /// was never wrong, which is a worse outcome than the opaque original.
    pub fn failure_message(&self) -> String {
        if self.failure_code() == AgentFailureCode::CertificateUntrusted {
            return "the engine could not verify the server's certificate. That is not proof of \
                    a CA problem: a transient network or TLS failure reports the same thing, so \
                    a retry is a reasonable first step. If it repeats, the likely cause is a \
                    chain the engine's CA store does not know — an internal or brand-new root, \
                    or a system store that is missing or out of date. NODE_EXTRA_CA_CERTS names \
                    an extra bundle the engine trusts; the app already passes the system store \
                    through it, so anything set there should include it. The connection was not \
                    attempted insecurely."
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
///
/// What is recognised is the *condition* — an engine that could not verify a
/// certificate — and deliberately not its cause, which this frame cannot
/// establish: the live run's §5 measured a transient network fault producing
/// the same sentence, on a healthy store, and nothing in the frame separates
/// the two. The matcher is unchanged by that finding and unchanged by the
/// wording work in [`TransportError::failure_message`]; what changed is the
/// claim the reworded sentence makes about the cause.
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
/// - **`AgentThoughtChunk`** was in this list and is no longer. P0 §2.3 measured
///   it on the wire; the contract was asked to decide and decided to keep it
///   (`payloads.ts`'s `'thought-delta'`, with a reducer arm, a collapsed timeline
///   row and its own copy), carrying the mapping forward to this layer in as many
///   words: 「the gap is in the mapping」 (T1 §2). A drop here would leave a kind
///   the whole window is built to render with no producer, which is the defect
///   §6.2's rule exists to prevent — reversed.
/// - **`UserMessageChunk`** was in this list too, for the same reason and with the
///   same outcome: the contract had a kind for it and this layer had no arm. See the
///   arm below.
/// - **everything else the schema can name** — plan frames, mode
///   updates, session metadata and usage, compaction, and the `Other` escape hatch.
///   §6.2 requires that `unknown` never reaches a component, so an update this host
///   has no kind for is not forwarded as a mystery blob to be guessed at.
pub fn normalize_update(update: &SessionUpdate) -> Option<(AgentEventKind, Value)> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            let text = text_of(chunk)?;
            Some((AgentEventKind::TextDelta, json!({ "text": text })))
        }
        // The engine's copy of the user's half. It is what `session/load` replays beside the
        // answers — the conversation's other half — and `user-delta` is the contract's own kind
        // for it (`payloads.ts`, `readText`, the reducer's `user` row and `AgentTimeline.vue`).
        //
        // **This arm is the producer that kind was missing.** It was declared at T1 with a
        // reducer arm, a timeline row and a renderer, and nothing on this side ever emitted it:
        // the frame fell to `_ => None` below, so a restored session drew only the agent's half
        // and drew it silently. Zed reads the same frame the same way (`acp_thread.rs` pushes a
        // `UserMessage` entry rather than appending to the answer), which is where this decision
        // comes from; its echo suppression is not copied, because this host keeps the engine's
        // copy in a row of its own (`origin: 'engine'`) rather than folding it into the message
        // it sent optimistically.
        //
        // Forwarded in the contract's shape for `user-delta` (`{ text }`), the same shape and the
        // same `text_of` reason as the two chunk kinds around it: a chunk carrying an image is
        // not an empty message.
        SessionUpdate::UserMessageChunk(chunk) => {
            let text = text_of(chunk)?;
            Some((AgentEventKind::UserDelta, json!({ "text": text })))
        }
        // The engine's reasoning channel, forwarded in the contract's shape for `thought-delta`
        // (`{ text }`) — the same shape as the answer's, and the same `text_of` reason for
        // refusing a chunk that carries no text: an image or a resource link is not an empty
        // thought.
        SessionUpdate::AgentThoughtChunk(chunk) => {
            let text = text_of(chunk)?;
            Some((AgentEventKind::ThoughtDelta, json!({ "text": text })))
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
        // The session's context window and its cumulative cost. The kind, the reader
        // (`readers/session.ts`'s `readContextUsage`), the reducer's arm and the view's `usage`
        // were all placed at T1; this arm is the producer they were missing, and the reason it was
        // missing is that nothing in this tree had seen the frame on the wire.
        //
        // **The engine was measured sending it, in the pinned artifact itself.** The binary P0 §1
        // pins (`binaries/opencode-x86_64-unknown-linux-gnu`) builds and sends this frame in two
        // places, both named `usage.*sendUpdate` in its own source strings: one on the ACP
        // session path (`ACPUsage.sendUpdate`) and one after a prompt (`ACP.promptUsage.sendUpdate`).
        // Both take the same three facts — the last assistant message's context tokens as `used`,
        // the model's own context limit as `size`, and the session's cumulative cost — and both are
        // guarded: no message, no provider or model id, or no known context limit for that model
        // means *no frame at all*. So this arm is correct and may be invisible on a provider whose
        // model the engine has no limit for; that is a fact about the engine's guard rather than
        // about this mapping, and it is why the window must treat `usage === null` as "nothing has
        // been reported" (§5.1) rather than as a zero.
        //
        // **The payload is mapped, not passed through**, for the reason `config_options` below
        // gives: the contract is the frozen side, and it reads `{ usedTokens, contextTokens, cost }`
        // — `cost` present as numbers or as an explicit null, so a consumer is never left guessing
        // between "no cost" and "the field was forgotten".
        SessionUpdate::UsageUpdate(update) => Some((
            AgentEventKind::UsageChanged,
            json!({
                "usedTokens": update.used,
                "contextTokens": update.size,
                "cost": context_cost(update.cost.as_ref()),
            }),
        )),
        _ => None,
    }
}

/// ACP's cumulative cost in the contract's shape, or an explicit `null`.
///
/// `null` rather than an absent member, and the difference is load-bearing: ACP makes `cost`
/// optional, the contract's `AgentContextUsage.cost` is `AgentCost | null`, and
/// `readContextUsage` refuses a payload where the member is missing — because "the engine
/// reported no cost" and "this producer forgot to say" are different statements, and §5.1 lets a
/// surface show only the first (§5.1: an unknown cost is not zero).
fn context_cost(cost: Option<&Cost>) -> Value {
    match cost {
        Some(cost) => json!({ "amount": cost.amount, "currency": cost.currency }),
        None => Value::Null,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// P0 §2.4's measured frame, verbatim, as the engine sends it.
    fn measured() -> TransportError {
        TransportError::Engine {
            message: "Internal error: unknown certificate verification error".to_string(),
        }
    }

    /// The half that must not weaken. Recognition is what keeps the condition
    /// legible; without it this arrives as an unrecognised internal error, which
    /// is exactly what §2.4 measured and rejected.
    #[test]
    fn the_measured_frame_is_still_classified_and_still_reworded() {
        assert_eq!(
            measured().failure_code(),
            AgentFailureCode::CertificateUntrusted
        );
        let message = measured().failure_message();
        assert!(
            !message.contains("unknown certificate verification error"),
            "the engine's own words must not reach the user: {message}"
        );
        assert!(
            message.contains("certificate"),
            "the condition is still named: {message}"
        );
    }

    /// The honesty of the sentence, as properties rather than as prose.
    ///
    /// The live run's §5 measured this exact condition arriving from a transient
    /// network fault and then succeeding twice with identical inputs, so a
    /// message that offers only the CA explanation sends a user to change a
    /// configuration that was never wrong. Three claims are required: the
    /// failure may be transient (a retry instruction), the CA cause is offered
    /// as a likelihood, and `NODE_EXTRA_CA_CERTS` is named so the cause is
    /// actionable. Reverting the wording to the confident diagnosis fails on the
    /// first, and the ordering assertion keeps a rewrite from burying the retry
    /// after the CA advice.
    #[test]
    fn the_certificate_message_offers_the_retry_before_the_ca_advice() {
        let message = measured().failure_message();
        assert!(
            message.contains("NODE_EXTRA_CA_CERTS"),
            "the variable that addresses a CA problem must be named: {message}"
        );
        assert!(
            message.to_lowercase().contains("transient"),
            "the message must say the failure can arrive from something that is not the \
             certificate at all: {message}"
        );
        // Any of these words is unambiguously a retry instruction, and the wording
        // this replaces contained none of them.
        let retry = ["retry", "try again", "it again"]
            .iter()
            .filter_map(|anchor| message.find(anchor))
            .min()
            .unwrap_or_else(|| {
                panic!("the message must say running the failure again is worth trying: {message}")
            });
        let cause = message
            .find("CA store")
            .unwrap_or_else(|| panic!("the message must still name the cause: {message}"));
        assert!(
            retry < cause,
            "the retry comes first, so a transient failure does not send the reader into \
             their CA configuration: {message}"
        );
    }

    /// What the matcher fires on, and what it does not — unchanged by the wording
    /// work, and pinned because a classification that cannot state its own
    /// boundary is the thing §2.4's "opaque error" complaint was about.
    ///
    /// Fires on: a message that contains `certificate` *and* one of the phrasings
    /// the TLS libraries use. Does not fire on: an internal error that merely
    /// mentions a certificate, a phrasing without a certificate, and the generic
    /// `-32603` with neither — those stay `invalid-response`, or reach the user
    /// as the engine's own words.
    #[test]
    fn the_match_covers_the_measured_phrasings_and_nothing_else() {
        for message in [
            "Internal error: unknown certificate verification error",
            "certificate verify failed: unable to get local issuer certificate",
            "certificate verify failed: self-signed certificate in certificate chain",
            "certificate verify failed: self signed certificate",
            "certificate verify failed: certificate has expired",
            "error:0A000086:SSL routines::certificate verify failed, depth lookup: self signed",
        ] {
            assert!(
                certificate_failure(message),
                "a measured certificate phrasing must match: {message}"
            );
        }
        for message in [
            "Internal error",
            "-32603 Internal error: an unexpected failure occurred",
            "certificate request rejected by policy",
            "unable to verify the workspace root",
            "the session has expired",
        ] {
            assert!(
                !certificate_failure(message),
                "this is not a certificate failure and must not be reworded as one: {message}"
            );
        }
    }
}
