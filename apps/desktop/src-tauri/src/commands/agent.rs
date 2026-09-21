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
use crate::agent_runtime::events::{AgentFailureCode, AgentIdentity};
use crate::agent_runtime::permission_grants::{self, GrantsReadout};
use crate::agent_runtime::permissions::{
    cancel_run, PermissionAnswer, PermissionPrompt, PermissionRefusal, PermissionTable,
};
use crate::agent_runtime::session::SessionError;
use crate::agent_runtime::snapshot::SessionSnapshot;
use crate::state::{AgentRuntimeState, VaultRegistry};

/// A failure as it crosses the IPC boundary: the condition's own code, and the sentence.
///
/// The contract's `AgentFailure` (`agent-contracts/failure.ts`) on this side of the wire — the same
/// pair of fields a `run-failed` frame carries, so a call and a turn name a condition the same way.
/// It exists because a command's rejection used to be the *sentence alone*: `SessionError::failure_code`
/// was written, tested and reached by nothing, so a window that received 「this session is already
/// answering」 had nothing to branch on and no way to learn which condition it had hit. That is the
/// same defect one layer up from a frame nothing can read, and the fix is the same: the fact
/// travels with the wording.
///
/// **This is a rejection, and it is the only thing on this surface that is.** A refusal that is
/// *data* — a registry entry a page renders, a skill arrangement the backend would not accept —
/// travels in the `Ok` arm as a value (`RegistryRefusal`, `SkillError`), and the settings clients
/// state that rule in their own headers. The agent surface is the other case, and deliberately: the
/// contract's `AgentGateway` declares every method as rejecting with an `AgentFailure`, because
/// 「the engine did not answer」 and 「this turn is already running」 are one channel to the caller —
/// a gateway method cannot return a value *and* fail to have run.
///
/// The code is computed here rather than taken from the caller, for the reason §6.1 gives about
/// identity: a renderer that could name the condition could name one it did not hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFailure {
    pub code: AgentFailureCode,
    pub message: String,
}

impl AgentFailure {
    pub fn new(code: AgentFailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The runtime's own refusal, as the contract names it: the code and the sentence are the two
    /// halves `SessionError` already keeps apart, and this only carries them across.
    pub fn of_session(error: &SessionError) -> Self {
        Self::new(error.failure_code(), error.failure_message())
    }

    /// A refused permission answer.
    ///
    /// Four of the five refusals are one condition on this vocabulary — `permission-denied`, "the
    /// answer did not take effect" — and the fifth names a session this host does not have, which
    /// is the same fact `SessionError::UnknownSession` answers with. The split is made here, where
    /// the refusal was raised, rather than by a window that would have to read five sentences to
    /// guess it; the sentences stay untouched and remain the part the user reads.
    pub fn of_permission(refusal: &PermissionRefusal) -> Self {
        match refusal {
            PermissionRefusal::UnknownSession { session_id } => Self::new(
                AgentFailureCode::SessionStale,
                format!("session {session_id} is not one this app opened"),
            ),
            other => Self::new(AgentFailureCode::PermissionDenied, refusal_message(other)),
        }
    }

    /// There is no engine to ask: no session has been started, or the state that holds one is gone.
    ///
    /// `runtime-unavailable` is the code the contract's own adapter uses for the same fact when it
    /// answers it alone (`tauri-agent.ts`), so a caller sees one word for "nothing is running"
    /// whichever side refused.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(AgentFailureCode::RuntimeUnavailable, message)
    }

    /// A session id this host does not hold — §6.1's guard, refused everywhere it appears.
    pub fn stale(message: impl Into<String>) -> Self {
        Self::new(AgentFailureCode::SessionStale, message)
    }

    /// A vault or path the user never opened.
    ///
    /// The app's own confinement refusing to serve a folder nothing vouches for: the request asked
    /// for something outside what this window may reach, which is what `permission-denied` names.
    pub fn not_permitted(message: impl Into<String>) -> Self {
        Self::new(AgentFailureCode::PermissionDenied, message)
    }
}

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
    ///
    /// `runtime-unavailable` for both arms, and for the same reason: neither is a fact about a
    /// session — there is no session — so the code names the one thing they have in common, which
    /// is that nothing here can be asked. A window that branches on it is branching on "start an
    /// engine", which is exactly what the sentence tells the user to do.
    pub fn session(&self) -> Result<Session, AgentFailure> {
        self.session
            .lock()
            .map_err(|_| {
                AgentFailure::unavailable("the agent session state was poisoned by a panic")
            })?
            .as_ref()
            .cloned()
            .ok_or_else(|| {
                AgentFailure::unavailable("no agent session is running: start one first")
            })
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

    /// The same slot, read as a *state* rather than as a refusal.
    ///
    /// [`session`](Self::session) answers the sentence for a caller that cannot proceed without
    /// one. The grants readout is the opposite case: "no engine is running" is one of its own
    /// answers — a page must be able to draw it — so a caller that turned it into an error would
    /// have to reconstruct the state it threw away. A poisoned lock is still `None` here, because
    /// a panic on another task is not a session either.
    pub fn session_or_none(&self) -> Option<Session> {
        self.session.lock().ok().and_then(|slot| slot.clone())
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
) -> Result<(), AgentFailure> {
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
        .map_err(|error| AgentFailure::of_session(&error))
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
) -> Result<AgentRuntimeHandle, AgentFailure> {
    let handle = {
        // The sink is the window's half of this: one channel, every session (see
        // [`AGENT_EVENT_CHANNEL`]). `emit` failing means no window is listening, which is the
        // shutdown path rather than an error to report.
        let emit = app.clone();
        let session =
            crate::state::start_session(&runtime_state, &app, &vault_id, move |envelope| {
                super::agent_events::publish(&emit, &envelope);
            })
            .await
            .map_err(AgentFailure::unavailable)?;
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
) -> Result<(), AgentFailure> {
    stop_running_engine(&app, &runtime_state, &ipc)
}

/// The teardown itself, as a plain call rather than a command.
///
/// It is a function because there are two callers and they must not drift: `agent_stop`, when the
/// reader asks for the engine to come down, and `lib.rs`'s `RunEvent::Exit`, when the app is
/// closing and there is no reader to ask. The second was missing until 2026-09-21 and the reason
/// is worth keeping written down:
///
/// **`App::run` exits through `std::process::exit`.** Tauri's own doc on it says so
/// (`tauri-2.11.5/src/app.rs:1346`), and `std::process::exit` does not run destructors — so the
/// managed state was never dropped and `AgentInstance`'s `Drop` never ran. `agent_runtime::mod`'s
/// promise that 「the process group and its teardown」 belong to the transport was true the whole
/// time; nothing reached it on the exit path. This is the same shape as the rest of this
/// repository's recurring defect — built, correct, and unreachable.
///
/// **What that cost, corrected by measurement.** This docblock first said 「every launch left the
/// engine behind」, and that is not what happened. `tests/agent_exit_teardown_test.rs` closed the
/// real app with and without the exit arm: the engine was gone 1.00–1.60s after the quit with it
/// and 0.80–1.00s without, and the two overlap. `opencode` 1.18.29 exits on its own when its stdin
/// closes. So the orphan this was written to prevent does not occur, and a reader who wants the
/// reason an orphan could not occur should not be pointed here.
///
/// What the missing arm really cost is the pair below, and it is worth stating because it is the
/// bug the maintainer actually hit: **the registration was never released and the child was never
/// reaped.** The engine left unannounced, its epoch stayed claimed, and the next start was refused
/// with `AlreadyRunning` — for an engine that was not there — until the app was quit. The reaping
/// half now has a second owner as well (`agent_runtime`'s supervisor collects a child that exits on
/// its own, and `start_session` lets go of an instance whose engine is gone), so the wedge no
/// longer depends on this callback running.
///
/// The three steps and their order are `agent_stop`'s, unchanged.
pub fn stop_running_engine<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    runtime_state: &AgentRuntimeState,
    ipc: &AgentIpcState,
) -> Result<(), AgentFailure> {
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
    //
    // At exit this is the step that is easy to think of as unnecessary and is not: without it a
    // task the closing app was running stays `working` in the pet's list, and the next launch
    // draws a task no process is behind. The cost of getting it wrong outlives the process.
    if let Some(session) = &session {
        let identity = session.identity.clone();
        report_pet_tasks(app, |state| state.tasks.retire(&identity), "a stop");
    }
    // Taking the instance out of the slot is what stops the engine: its own `Drop` releases the
    // registration and asks the process to exit. Doing it here rather than leaving it to the
    // session's `Arc` is what makes the *registration* free the moment this returns, which is
    // what the next `agent_start` needs.
    let instance = runtime_state
        .instance
        .lock()
        .map_err(|_| AgentFailure::unavailable("the agent runtime state was poisoned by a panic"))?
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
