//! The session half of the agent IPC: the commands a window addresses at a session that is already
//! open, and the two answer shapes those calls are worded in.
//!
//! **Why this is a module and not commands on `agent.rs`.** The parent had reached 634 lines against
//! the 600-line budget `docs/dev.md:286` puts on a business file, and the split is by *reason to
//! change* — the criterion that same section states. What makes this file change is the contract of
//! a *session*: the fields `AgentHostSession` answers with, the config-option write, what a turn
//! carries, and what a mounting window has to take before it subscribes (§6.2). It does not change
//! because the engine starts or stops, because a permission is answered, or because a refusal is
//! reworded.
//!
//! [`AgentHostSession`] lives here rather than beside the engine's handle because this is the module
//! that mints it: `agent_open_session` below is one producer, `commands/agent_sessions.rs`'s resume
//! is the other, and both are session-facing. Keeping the struct with the first of them leaves the
//! dependency between the two halves of the split pointing one way — this file reads the state and
//! the wording, and nothing reads this file.
//!
//! The vault check in [`agent_open_session`] is §6.1's, argued at the enforcement point below: the
//! renderer names a vault, it does not choose one.

use serde::Serialize;

use crate::agent_runtime::snapshot::SessionSnapshot;
use crate::state::VaultRegistry;

use super::failure::AgentFailure;
use super::ipc_state::AgentIpcState;
use super::permissions::pending_prompts;
use super::report_pet_tasks;

/// A session the engine opened — the contract's `AgentHostSession`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostSession {
    pub session_id: String,
    /// The engine's own config options, as they came.
    pub config_options: serde_json::Value,
    /// Which of those options selects the model, or null when this engine has none.
    pub model_option_id: Option<String>,
}

/// Opens a session in a vault the user has open: the second of the two calls.
#[tauri::command]
pub async fn agent_open_session(
    vaults: tauri::State<'_, VaultRegistry>,
    ipc: tauri::State<'_, AgentIpcState>,
    vault_id: String,
    cwd: String,
) -> Result<AgentHostSession, AgentFailure> {
    let session = ipc.session()?;
    // §6.1: the renderer names a vault, it does not choose one. A request for a vault this
    // runtime was not started for is refused rather than answered about the one it has.
    if vault_id != session.identity.vault_id {
        // `session-stale`, and the code is the honest one rather than a second word for "no": the
        // caller is addressing an incarnation that is not the live one — it named the vault a
        // *different* runtime serves — which is the same condition a session id from a previous
        // epoch is. The sentence still names both vaults, because that is what the user reads.
        return Err(AgentFailure::stale(format!(
            "this engine was started for the vault {} and not for {vault_id}",
            session.identity.vault_id
        )));
    }
    // And the root the engine will be confined to is the one the *user* opened — not the string
    // the renderer sent. `authorize` answers with the canonical root, which is what makes
    // `cwd == vault` a fact rather than a claim.
    let root = vaults
        .authorize(&cwd)
        .map_err(AgentFailure::not_permitted)?;
    let info = session
        .runtime
        .open_session(&root)
        .await
        .map_err(|error| AgentFailure::of_session(&error))?;
    // §6.2's state machine: a session the engine admitted and nothing has been asked of yet.
    // Registered before the answer returns, so a frame that arrives first still has a log.
    session.snapshots.opened(&info.session_id);
    Ok(AgentHostSession {
        session_id: info.session_id,
        config_options: info.config_options,
        model_option_id: session.model_option_id.clone(),
    })
}

/// Moves one of the engine's own config options — in practice the model.
///
/// Answers the engine's own refreshed option list, in the shape `agent_open_session` answers
/// the original one in (the schema's, as it came), so a caller never has to guess the new
/// state or wait for an event that may not come. That is the reason Zed's equivalent returns
/// `Vec<acp::SessionConfigOption>` rather than `()` (`crates/acp_thread/src/connection.rs:311`
/// in the reference tree), and it is stricter here than there: the runtime's `set_config_option`
/// is what stores the list on the session, and this answer is that same value rather than a
/// second read of it.
///
/// It is *not* the contract's `config-changed` payload: that shape belongs to the event
/// boundary, where an adapter maps it (`agent_runtime::events::normalize_update`), and this
/// one is the same fact `AgentHostSession.config_options` carries.
#[tauri::command]
pub async fn agent_set_config_option(
    ipc: tauri::State<'_, AgentIpcState>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<serde_json::Value, AgentFailure> {
    let session = ipc.session()?;
    session
        .runtime
        .set_config_option(&session_id, &config_id, &value)
        .await
        .map_err(|error| AgentFailure::of_session(&error))
}

/// Sends a turn. The answer is the host's run id; the turn's *ending* arrives as an event.
///
/// `attachments` is what the reader put in the message beside its words, as the window described
/// them (`agent_runtime::attachments::PromptAttachment`). Optional so that a window which sends
/// none — and every older caller — asks for exactly the frame that existed before, and passed
/// through unread: whether the turn may carry each block is the engine's own report, and the
/// runtime is the layer that holds it.
#[tauri::command]
pub async fn agent_prompt<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ipc: tauri::State<'_, AgentIpcState>,
    session_id: String,
    text: String,
    attachments: Option<Vec<crate::agent_runtime::attachments::PromptAttachment>>,
) -> Result<String, AgentFailure> {
    let session = ipc.session()?;
    let run_id = session
        .runtime
        .prompt(&session_id, &text, &attachments.unwrap_or_default())
        .map_err(|error| AgentFailure::of_session(&error))?;
    // Marked from here and not from a frame, because no frame says "a turn began" — the runtime's
    // own answer is the run id, and a window that mounts while a turn is running has to be told
    // which turn it is looking at.
    session.snapshots.started(&session_id, &run_id);
    // The pet's list follows the same fact, for the same reason (§6.1): a pet that only learned
    // about work when the work was over could not show it as running at all.
    let identity = session.identity.clone();
    report_pet_tasks(
        &app,
        |state| state.tasks.started(&identity, &session_id, &run_id),
        "a prompt",
    );
    Ok(run_id)
}

/// The host's snapshot of one session: what a window that is mounting now must take *before* it
/// subscribes (§6.2), or the frames in the gap are lost.
#[tauri::command]
pub async fn agent_session_snapshot(
    ipc: tauri::State<'_, AgentIpcState>,
    session_id: String,
) -> Result<SessionSnapshot, AgentFailure> {
    let session = ipc.session()?;
    // The table is the authority on which prompts are still answerable, and it is read once: the
    // prompt list the snapshot carries and the state it reports are derived from this one answer,
    // so a prompt cannot be in one and missing from the other.
    let pending: Vec<String> = pending_prompts(&session.permissions)
        .into_iter()
        .map(|prompt| prompt.request_id)
        .collect();
    session
        .snapshots
        .snapshot(&session_id, &pending)
        .ok_or_else(|| {
            AgentFailure::stale(format!("session {session_id} is not one this app opened"))
        })
}
