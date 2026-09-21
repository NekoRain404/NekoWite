//! What is stamped on every event, and which incarnation of the runtime said it.
//!
//! Its own module because the envelope is a boundary rather than a mapping: the composite identity
//! of §6.1 and the sequence the window orders by are what every frame carries whatever the frame
//! says, so this changes when the *shape* the UI reads changes — a field added, renamed or made
//! optional — and not when a frame shape or a failure mode does.

use serde::Serialize;
use serde_json::Value;

use super::kinds::AgentEventKind;

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
