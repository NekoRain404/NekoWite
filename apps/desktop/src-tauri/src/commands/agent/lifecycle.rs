//! Starting and stopping the engine, and the runs it is carrying.
//!
//! **Why this is a module and not commands on `agent.rs`.** The parent had reached 634 lines against
//! the 600-line budget `docs/dev.md:286` puts on a business file, and the split is by *reason to
//! change* — the criterion that same section states. What makes this file change is an engine's
//! *incarnation*: how one comes up, what a stop has to release, what a run's cancellation resolves
//! first. Nothing here changes because a session's commands change, because a permission is
//! answered, or because a refusal is reworded.
//!
//! [`stop_running_engine`] is a plain function rather than a command, for the reason its own
//! docblock gives: `agent_stop` and `lib.rs`'s `RunEvent::Exit` are two callers of one teardown
//! that must not drift.
//!
//! [`AgentRuntimeHandle`] is the answer `agent_start` words itself in. The other payload of the two
//! calls — `AgentHostSession` — stays with the session-facing file that mints it, so the dependency
//! between the two halves of this split points one way.

use serde::Serialize;

use crate::agent_runtime::events::AgentIdentity;
use crate::agent_runtime::permissions::cancel_run;
use crate::state::AgentRuntimeState;

use super::failure::AgentFailure;
use super::ipc_state::AgentIpcState;
use super::report_pet_tasks;

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
        // [`AGENT_EVENT_CHANNEL`](super::AGENT_EVENT_CHANNEL)). `emit` failing means no window is
        // listening, which is the shutdown path rather than an error to report.
        let emit = app.clone();
        let session =
            crate::state::start_session(&runtime_state, &app, &vault_id, move |envelope| {
                crate::commands::agent_events::publish(&emit, &envelope);
            })
            .await
            .map_err(AgentFailure::unavailable)?;
        let handle = AgentRuntimeHandle::of(&session.identity);
        if let Err(failure) = ipc.install(session) {
            // The engine is up and nothing can address it — the slot that every other command reads
            // is poisoned. Taking it down again before refusing is the difference between a start
            // that failed and a process the app can never stop: `stop_running_engine` below reaches
            // the runtime's own slot even when the session slot refuses (see its docblock), and the
            // instance's `Drop` is what ends the engine.
            let _ = stop_running_engine(&app, &runtime_state, &ipc);
            return Err(failure);
        }
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
    //
    // **A poisoned slot does not stop the teardown.** `clear` refusing means *the session cannot be
    // read*, not that there is no engine: the runtime's own slot is a different mutex, and the steps
    // below — revoking the prompts, retiring the pet's tasks, taking the instance out to stop it —
    // are exactly what a teardown is for. Returning here would leave an engine running that nothing
    // can address, which is worse than the thing the refusal was about. The refusal is carried to
    // the end and answered after every step has run.
    let (session, refused) = match ipc.clear() {
        Ok(session) => (session, None),
        Err(failure) => (None, Some(failure)),
    };
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
    match refused {
        Some(failure) => Err(failure),
        None => Ok(()),
    }
}
