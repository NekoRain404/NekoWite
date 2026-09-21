//! The permission half of the agent IPC: the answers a window may give, the prompts still awaiting
//! one, and the lasting grants the engine holds.
//!
//! **Why this is a module and not commands on `agent.rs`.** The parent had reached 634 lines against
//! the 600-line budget `docs/dev.md:286` puts on a business file, and the split is by *reason to
//! change* — the criterion that same section states. What makes this file change is the permission
//! *table* and the reads of it: an arm on `PermissionRefusal`, a prompt that must outlive a
//! snapshot, a grant route the engine grows. Nothing here changes because the engine starts, a
//! session opens, or a turn is sent.
//!
//! [`apply_permission_answer`] and [`pending_prompts`] are plain functions rather than commands, for
//! the reasons their own docblocks give: the first is what R2 drives without a Tauri app, and the
//! second is what the composition root folds into the one snapshot it serves.
//!
//! The identity check for an answer is not here — it is in the table the answer is raised against
//! (`permissions::PermissionBinding`), where the request that arrived is recorded, for the reason
//! the parent module's header argues.

use crate::agent_runtime::events::AgentIdentity;
use crate::agent_runtime::permission_grants::{self, GrantsReadout};
use crate::agent_runtime::permissions::{
    PermissionAnswer, PermissionPrompt, PermissionRefusal, PermissionTable,
};

use super::failure::AgentFailure;
use super::ipc_state::AgentIpcState;
use super::report_pet_tasks;

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

#[tauri::command]
pub fn agent_permission_answer<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AgentIpcState>,
    answer: PermissionAnswer,
) -> Result<(), AgentFailure> {
    let session = state.session()?;
    // Read out before the answer is consumed, because the pet's list has to follow *this* answer:
    // a run the user is no longer being asked about must stop saying `waiting-input` (§6.2), and
    // the only place that knows the host answered is here.
    let identity = AgentIdentity {
        agent_id: answer.session.agent_id.clone(),
        profile_id: answer.session.profile_id.clone(),
        runtime_epoch: answer.session.runtime_epoch.clone(),
        vault_id: answer.session.vault_id.clone(),
    };
    let (answered_session, request_id) =
        (answer.session.session_id.clone(), answer.request_id.clone());
    apply_permission_answer(&session.permissions, answer)
        .map_err(|refusal| AgentFailure::of_permission(&refusal))?;
    report_pet_tasks(
        &app,
        |state| {
            state
                .tasks
                .answered(&identity, &answered_session, &request_id)
        },
        "an answer",
    );
    Ok(())
}

/// The prompts still awaiting an answer, for a UI that is remounting.
///
/// §6.2 requires the snapshot to be taken before the event subscription starts; this is the
/// permission part of it. A plain function rather than a command, so the composition root can fold
/// it into the one snapshot it serves instead of the renderer having to ask twice.
pub fn pending_prompts(permissions: &PermissionTable) -> Vec<PermissionPrompt> {
    permissions.pending()
}

/// The permissions the engine has written down because the user answered "always".
///
/// **Why this is a command and not a profile read.** `permission.saved.list` is the engine's own
/// route, and the engine is the only thing holding the table: it is written per project into the
/// engine's database (`permission-configured.md` §5) and every later evaluation loads it, so a
/// second copy anywhere in this app would be a second answer to "will the engine ask me" that
/// could disagree with the one the engine acts on. There is no filter and no projection here
/// either — the engine's own four fields travel as they arrived, because a page that renamed or
/// grouped them would be describing a rule that is not the one being evaluated.
///
/// **The three answers are the point.** `not-running` is no engine, `unsupported` is an agent
/// whose adapter has no verified HTTP surface, and `listed` with no rows is the engine itself
/// saying it has written nothing down. A page that drew the third as the first would be claiming
/// consent it never established — the failure this whole surface exists to remove.
#[tauri::command]
pub async fn agent_permission_grants(
    ipc: tauri::State<'_, AgentIpcState>,
) -> Result<GrantsReadout, String> {
    match ipc.session_or_none() {
        None => Ok(GrantsReadout::NotRunning),
        Some(session) => permission_grants::list(session.http).await,
    }
}

/// Takes one lasting permission back, and answers what the engine holds afterwards.
///
/// The removal goes to the engine rather than to its database: only the engine knows what it has
/// cached for the project it is serving, and its own `remove` is what the next evaluation reads.
/// What comes back is the list *after* the removal, re-read from the engine — not the caller's row
/// struck out — for the reason the catalogued commands answer with the refreshed option list:
/// the authority's answer and the page's belief about it must not be two different things.
#[tauri::command]
pub async fn agent_permission_grant_revoke(
    ipc: tauri::State<'_, AgentIpcState>,
    grant_id: String,
) -> Result<GrantsReadout, String> {
    match ipc.session_or_none() {
        None => Ok(GrantsReadout::NotRunning),
        Some(session) => permission_grants::remove(session.http, &grant_id).await,
    }
}
