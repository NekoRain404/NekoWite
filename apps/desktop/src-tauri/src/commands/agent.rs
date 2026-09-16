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
//!
//! The session half of §9's 会话与授权 IPC is the same shape one layer up. A session is addressed
//! by the engine's own id, and which runtime that id belongs to is not something a caller gets to
//! assert: [`AgentIpcState`] holds the one session this app started, and every command here
//! answers from it. The vault a session works in is the root the *user* opened — checked against
//! [`VaultRegistry`], not taken from the request — because the engine's file capability confines
//! every read and write it *delegates* to that root, so a root a renderer invented would be a
//! confinement drawn around a directory the user never chose. Delegated traffic is all it covers:
//! P0 §7's preamble measured the same engine writing a file through its own tools with zero
//! reverse requests, and no root chosen here confines those.
//!
//! The wording lives here too, for the reason the permission half's `refusal_message` does: it is
//! about what the user's click did, while the layer below answers with the fact.

use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use crate::agent_runtime::driver::Session;
use crate::agent_runtime::events::AgentIdentity;
use crate::agent_runtime::permissions::{
    cancel_run, PermissionAnswer, PermissionPrompt, PermissionRefusal, PermissionTable,
};
use crate::agent_runtime::snapshot::SessionSnapshot;
use crate::state::{AgentRuntimeState, VaultRegistry};

/// The channel the runtime's events are published on.
///
/// One channel for every session, not one per session: §6.2's envelope carries the composite
/// identity, so a frame already says which session, run and sequence it belongs to — and a
/// channel per session would leak a listener for every session a window ever opened. The adapter
/// (`tauri-agent/ipc.ts`) declares the same name from the other side; it is the wire's, and the
/// two spellings are one decision.
pub const AGENT_EVENT_CHANNEL: &str = "agent-event";

/// What every agent command needs: the session this app is running, if any.
///
/// One slot, `None` until `agent_start` fills it — the shape `KeyVault` and `AgentRuntimeState`
/// use, and here for a reason of Tauri's rather than of taste: `manage` sets a type's state once,
/// so a second `agent_start` after a stop has nowhere to put a fresh value except *inside* a
/// state that already exists. The slot is that inside, and it is also what makes the answer to
/// "is an engine running" one value rather than a set of Arc fields that could disagree.
pub struct AgentIpcState {
    session: Mutex<Option<Session>>,
}

impl Default for AgentIpcState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

impl AgentIpcState {
    /// The running session, or the sentence that says there is none.
    pub fn session(&self) -> Result<Session, String> {
        self.session
            .lock()
            .map_err(|_| "the agent session state was poisoned by a panic".to_string())?
            .as_ref()
            .cloned()
            .ok_or_else(|| "no agent session is running: start one first".to_string())
    }

    /// Installs the session a start produced, replacing whatever was there.
    pub fn install(&self, session: Session) {
        if let Ok(mut slot) = self.session.lock() {
            *slot = Some(session);
        }
    }

    /// Takes the session out, answering it to the caller: the caller is the one that has to end
    /// its turns and answer its prompts, and it must do that before the runtime goes.
    pub fn clear(&self) -> Option<Session> {
        self.session.lock().ok().and_then(|mut slot| slot.take())
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
pub fn agent_permission_answer<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AgentIpcState>,
    answer: PermissionAnswer,
) -> Result<(), String> {
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
        .map_err(|refusal| refusal_message(&refusal))?;
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

/// Hand the pet's projection whatever a moment in the runtime's life means for a task.
///
/// One helper for the four places a task changes without a frame (a start, a stop, a prompt, an
/// answer), so the three things each of them has to get right are written once: the feed is
/// reached through the managed state, a change is published on the channel the window listens on,
/// and a feed that cannot answer costs the push rather than the command — none of these calls is
/// what the user asked for, and turning one into a rejected promise would report a pet problem as
/// a failed prompt.
fn report_pet_tasks<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    fact: impl FnOnce(
        &crate::state::DesktopPetState,
    ) -> Result<Option<Vec<crate::desktop_pet::PetTaskProjection>>, String>,
    what: &str,
) {
    // `try_state` rather than `state`: a build without the pet's state installed — this crate's
    // own test apps, and any launch where `setup` could not build it — has no list to feed, and a
    // command that panicked over it would turn a missing pet into a rejected prompt.
    let Some(pet) = app.try_state::<crate::state::DesktopPetState>() else {
        return;
    };
    match fact(&pet) {
        Ok(Some(tasks)) => crate::desktop_pet::publish_tasks(app, &tasks),
        Ok(None) => {}
        Err(detail) => eprintln!("nekowite: the pet's task list did not follow {what}: {detail}"),
    }
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
    let session = state.session()?;
    cancel_run(&session.runtime, &session.permissions, &session_id)
        .await
        .map_err(|error| error.failure_message())
}

// ---------------------------------------------------------------------------
// The session half
// ---------------------------------------------------------------------------

/// A running runtime instance, as `agent_start` answers it — the contract's `AgentRuntimeHandle`.
///
/// Three fields and not a session id: the epoch is minted per (agent, profile, vault) when an
/// instance starts, and the session, which is the engine's own id, arrives with
/// `agent_open_session` and is what the window joins to this to build the five-field identity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeHandle {
    pub agent_id: String,
    pub profile_id: String,
    pub runtime_epoch: String,
}

impl AgentRuntimeHandle {
    pub fn of(identity: &AgentIdentity) -> Self {
        Self {
            agent_id: identity.agent_id.clone(),
            profile_id: identity.profile_id.clone(),
            runtime_epoch: identity.runtime_epoch.clone(),
        }
    }
}

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

/// Starts the engine for a vault: the first of the two calls that put a session in front of a
/// window.
#[tauri::command]
pub async fn agent_start(
    app: tauri::AppHandle,
    runtime_state: tauri::State<'_, AgentRuntimeState>,
    ipc: tauri::State<'_, AgentIpcState>,
    vault_id: String,
) -> Result<AgentRuntimeHandle, String> {
    let handle = {
        // The sink is the window's half of this: one channel, every session (see
        // [`AGENT_EVENT_CHANNEL`]). `emit` failing means no window is listening, which is the
        // shutdown path rather than an error to report.
        let emit = app.clone();
        let session =
            crate::state::start_session(&runtime_state, &app, &vault_id, move |envelope| {
                let _ = tauri::Emitter::emit(&emit, AGENT_EVENT_CHANNEL, envelope);
            })
            .await?;
        let handle = AgentRuntimeHandle::of(&session.identity);
        ipc.install(session);
        handle
    };
    Ok(handle)
}

/// Stops the engine, and every turn it was carrying.
#[tauri::command]
pub async fn agent_stop<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    runtime_state: tauri::State<'_, AgentRuntimeState>,
    ipc: tauri::State<'_, AgentIpcState>,
) -> Result<(), String> {
    // The prompts first, then the engine: a pending request belongs to a turn that is about to
    // end, and the engine is blocking on it — so it is answered `cancelled` while there is still
    // a connection to answer on (§6.2's 旧授权按钮失效, on the process-exit route).
    let session = ipc.clear();
    if let Some(session) = &session {
        session.permissions.revoke_all();
    }
    // The pet's tasks are restated before the instance goes: `retire` is the host saying "nothing
    // this instance was running can still be running", which §6.2 maps to `interrupted` and never
    // to a completion. Done while the identity is still in hand, because the instance's `Drop` is
    // what ends the incarnation and it takes the epoch with it.
    if let Some(session) = &session {
        let identity = session.identity.clone();
        report_pet_tasks(&app, |state| state.tasks.retire(&identity), "a stop");
    }
    // Taking the instance out of the slot is what stops the engine: its own `Drop` releases the
    // registration and asks the process to exit. Doing it here rather than leaving it to the
    // session's `Arc` is what makes the *registration* free the moment this returns, which is
    // what the next `agent_start` needs.
    let instance = runtime_state
        .instance
        .lock()
        .map_err(|_| "the agent runtime state was poisoned by a panic".to_string())?
        .take();
    drop(instance);
    Ok(())
}

/// Opens a session in a vault the user has open: the second of the two calls.
#[tauri::command]
pub async fn agent_open_session(
    vaults: tauri::State<'_, VaultRegistry>,
    ipc: tauri::State<'_, AgentIpcState>,
    vault_id: String,
    cwd: String,
) -> Result<AgentHostSession, String> {
    let session = ipc.session()?;
    // §6.1: the renderer names a vault, it does not choose one. A request for a vault this
    // runtime was not started for is refused rather than answered about the one it has.
    if vault_id != session.identity.vault_id {
        return Err(format!(
            "this engine was started for the vault {} and not for {vault_id}",
            session.identity.vault_id
        ));
    }
    // And the root the engine will be confined to is the one the *user* opened — not the string
    // the renderer sent. `authorize` answers with the canonical root, which is what makes
    // `cwd == vault` a fact rather than a claim.
    let root = vaults.authorize(&cwd)?;
    let info = session
        .runtime
        .open_session(&root)
        .await
        .map_err(|error| error.failure_message())?;
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
) -> Result<serde_json::Value, String> {
    let session = ipc.session()?;
    session
        .runtime
        .set_config_option(&session_id, &config_id, &value)
        .await
        .map_err(|error| error.failure_message())
}

/// Sends a turn. The answer is the host's run id; the turn's *ending* arrives as an event.
#[tauri::command]
pub async fn agent_prompt<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ipc: tauri::State<'_, AgentIpcState>,
    session_id: String,
    text: String,
) -> Result<String, String> {
    let session = ipc.session()?;
    let run_id = session
        .runtime
        .prompt(&session_id, &text)
        .map_err(|error| error.failure_message())?;
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
) -> Result<SessionSnapshot, String> {
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
        .ok_or_else(|| format!("session {session_id} is not one this app opened"))
}
