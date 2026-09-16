//! The capability report, as the window asks for it.
//!
//! Its own command file for the reason `agent_registry.rs` and `agent_settings.rs` have theirs: this
//! is a *subject* — §3.4's capability row — and not another session call. What it needs from the two
//! layers below is one read each ([`AgentIpcState`]'s session and the instance slot), and what it
//! adds is the only decision that belongs at this boundary: **whose answer this is**.
//!
//! That decision is §3.4's 「重连和版本变化后重新检测」, and it is enforced here rather than trusted to
//! the caller: the negotiated facts are read only while the instance in the app's own slot is still
//! the incarnation the session was opened under. A runtime that has been stopped, replaced or
//! superseded by a newer `runtimeEpoch` has no answer left to give, and the report says so
//! (`unverified`) instead of repeating what its process once reported — which is exactly the claim a
//! panel must not be handed.
//!
//! The command adds no facts of its own. Both halves come from layers that own them: the
//! declaration from the engine's adapter ([`AgentInstance::declared_capability`], which answers
//! `Unverified` the moment the instance stops being live) and the negotiation from the runtime
//! ([`AgentRuntime::capabilities`], which answers only about sessions this host opened). The join is
//! [`capabilities::report`], a pure function.

use crate::agent_runtime::adapters::HostFeature;
use crate::agent_runtime::capabilities::{report, CapabilityReport};
use crate::agent_runtime::registry::AgentInstance;
use crate::agent_runtime::session::AgentRuntime;
use crate::state::AgentRuntimeState;

use super::agent::AgentIpcState;

/// What the engine reported about this session, declared beside negotiated.
///
/// Refusals are sentences, like the rest of this surface: a session this host never opened, and a
/// runtime that is not running, are conditions the user's click can act on, and the two are
/// different — the first is a stale window, the second is an app that has not started its engine.
#[tauri::command]
pub fn agent_session_capabilities(
    runtime_state: tauri::State<'_, AgentRuntimeState>,
    ipc: tauri::State<'_, AgentIpcState>,
    session_id: String,
) -> Result<Vec<CapabilityReport>, String> {
    let session = ipc.session()?;
    let instance = runtime_state
        .instance
        .lock()
        .map_err(|_| "the agent runtime state was poisoned by a panic".to_string())?;
    report_for(
        instance.as_ref(),
        &session.runtime,
        &session.identity.runtime_epoch,
        &session_id,
        session.model_option_id.as_deref(),
    )
}

/// The join, with the two rules this boundary owns made explicit.
///
/// Split from the command so the rules can be driven without a Tauri app — the shape
/// `apply_permission_answer` uses one file over — because the interesting cases (a runtime that went
/// away between the start and the question) are exactly the ones a window cannot be made to produce
/// on demand.
///
/// 1. **A session this host never opened is refused**, before anything is read: `unverified` rows
///    would be a softer way of answering an id §6.1 forbids answering about at all. The refusal is
///    the same sentence the snapshot command gives, because the two are the same fact.
/// 2. **A negotiation is only read while its incarnation is the live one.** The handle names the
///    epoch it was minted under, and an instance that is not that epoch — or is gone — cannot answer
///    for it: what its process reported is then history, not a fact about the engine in front of the
///    user (§3.4's 「重连和版本变化后重新检测」).
fn report_for(
    instance: Option<&AgentInstance>,
    runtime: &AgentRuntime,
    runtime_epoch: &str,
    session_id: &str,
    model_option_id: Option<&str>,
) -> Result<Vec<CapabilityReport>, String> {
    let negotiated = runtime
        .capabilities(session_id)
        .map_err(|_| format!("session {session_id} is not one this app opened"))?;
    let same_incarnation =
        instance.is_some_and(|live| live.identity().runtime_epoch == runtime_epoch);
    let declared = |feature: HostFeature| {
        instance.map_or(
            crate::agent_runtime::adapters::Capability::Unverified,
            |live| live.declared_capability(feature),
        )
    };
    Ok(report(
        declared,
        if same_incarnation {
            negotiated.as_ref()
        } else {
            None
        },
        model_option_id,
    ))
}
