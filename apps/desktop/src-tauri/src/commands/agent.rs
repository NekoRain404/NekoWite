//! The agent IPC surface: the commands the renderer calls, and the checks and wording that belong
//! to this side of the boundary.
//!
//! §6.1 draws this file's boundary as "validates and delegates": no protocol lives here, and no
//! decision about a request is made here. What *does* live here is the answer to §6.1's other rule
//! — **the renderer is not a trusted source of identity** (§11.1: a forged session id, or a forged
//! agentId/profileId, must be refused at this boundary).
//!
//! The concrete consequence: nothing this layer receives selects anything. The ids in an answer are
//! compared with the identity the backend recorded when the request arrived
//! (`permissions::PermissionBinding`), and a difference is a refusal — the renderer cannot name a
//! vault, a session or a run into existence. That check needs the recorded request, so it lives in
//! the permission table with it rather than being attempted twice from here.

use std::sync::Arc;

use crate::agent_runtime::AgentRuntime;
use crate::agent_runtime::permissions::{
    PermissionAnswer, PermissionPrompt, PermissionRefusal, PermissionTable, cancel_run,
};
use crate::agent_runtime::AgentIdentity;

/// What every agent command needs: the runtime, and the permission table it answers through.
///
/// Built by the composition root, which is also where the runtime's identity is chosen — they are
/// one decision, because the table refuses every answer whose identity is not the one it was built
/// with.
pub struct AgentIpcState {
    /// `Arc`, not `Mutex`: every call the IPC layer makes takes `&self`; only the permission stream
    /// itself needs `&mut`, and that is the driver's.
    pub runtime: Arc<AgentRuntime>,
    pub permissions: Arc<PermissionTable>,
}

impl AgentIpcState {
    pub fn new(identity: AgentIdentity, runtime: AgentRuntime) -> Self {
        let permissions = PermissionTable::new(identity, &runtime);
        Self {
            runtime: Arc::new(runtime),
            permissions,
        }
    }
}

/// The user's decision on one permission request.
///
/// Takes the table rather than the whole state, so the check can be driven without a Tauri app —
/// which is what R2 does — and returns the runtime's own typed refusal, so the renderer can be
/// told *which* fact it hit rather than only how it was worded.
pub fn apply_permission_answer(
    permissions: &PermissionTable,
    answer: PermissionAnswer,
) -> Result<(), PermissionRefusal> {
    permissions.respond(&answer)
}

/// The sentence the renderer shows for a refused answer.
///
/// It lives on this side because it is presentation: the runtime answers with the fact, and the
/// wording is about what the user's click did. "no longer open" and "answered already" are
/// different facts about that click, and the difference is worth keeping (spec §3.5: Zed's
/// duplicate repaints the tool call though the engine never sees it).
pub fn refusal_message(refusal: &PermissionRefusal) -> String {
    match refusal {
        PermissionRefusal::Expired { request_id } => {
            format!("permission request {request_id} is no longer open")
        }
        PermissionRefusal::AlreadyAnswered { request_id } => {
            format!("permission request {request_id} was answered already")
        }
        PermissionRefusal::IdentityMismatch { field } => format!(
            "this answer does not belong to that request: {field} is not the one it was raised \
             under"
        ),
        PermissionRefusal::OptionNotOffered { option_id } => {
            format!("the engine did not offer the option {option_id}")
        }
        PermissionRefusal::UnknownSession { session_id } => {
            format!("session {session_id} is not one this app opened")
        }
    }
}

#[tauri::command]
pub fn agent_permission_answer(
    state: tauri::State<'_, AgentIpcState>,
    answer: PermissionAnswer,
) -> Result<(), String> {
    apply_permission_answer(&state.permissions, answer).map_err(|refusal| refusal_message(&refusal))
}

/// The prompts still awaiting an answer, for a UI that is remounting.
///
/// §6.2 requires the snapshot to be taken before the event subscription starts; this is the
/// permission part of it. A plain function rather than a command, so the composition root can fold
/// it into the one snapshot it serves instead of the renderer having to ask twice.
pub fn pending_prompts(permissions: &PermissionTable) -> Vec<PermissionPrompt> {
    permissions.pending()
}

#[tauri::command]
pub async fn agent_cancel_run(
    state: tauri::State<'_, AgentIpcState>,
    session_id: String,
) -> Result<(), String> {
    // Through `cancel_run` and not `AgentRuntime::cancel`: pending permission prompts are resolved
    // *before* the engine is told to stop, which is the order the protocol requires (see
    // `permissions::cancel_run`). A stop path that called the runtime directly would leave the
    // engine waiting on a request whose turn is already over.
    //
    // The caller supplies only a session id, deliberately: the run being stopped is looked up in
    // the backend's own session table, and a session this host never opened is refused there. A
    // renderer-supplied identity would be a second, weaker source for the same fact.
    cancel_run(&state.runtime, &state.permissions, &session_id)
        .await
        .map_err(|error| error.failure_message())
}
