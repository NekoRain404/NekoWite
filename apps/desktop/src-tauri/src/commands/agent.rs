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
//! [`VaultRegistry`](crate::state::VaultRegistry), not taken from the request — because the engine's
//! file capability confines every read and write it *delegates* to that root, so a root a renderer
//! invented would be a confinement drawn around a directory the user never chose. Delegated traffic
//! is all it covers: P0 §7's preamble measured the same engine writing a file through its own tools
//! with zero reverse requests, and no root chosen here confines those.
//!
//! The wording lives here too, for the reason the permission half's `refusal_message` does: it is
//! about what the user's click did, while the layer below answers with the fact.
//!
//! **This file was split, and what is left of it is the seam.** It had reached 634 lines against the
//! 600-line budget `docs/dev.md:286` puts on a business file, and the split is by *reason to change*
//! — the criterion that same section states — rather than by arithmetic. Five subjects came out of
//! it, each in a file of its own beside this one:
//!
//! - `failure.rs` — how a refused call is reported to the window: the code, the sentence, and the
//!   wording a refused permission answer is given. Changes when a refusal's vocabulary changes.
//! - `ipc_state.rs` — the channel the runtime's frames are published on, and the one session slot
//!   every command here reads. Changes when the managed state's shape changes.
//! - `permissions.rs` — the user's answers, the prompts still awaiting one, and the lasting grants
//!   the engine holds. Changes when the permission table or a read of it changes.
//! - `lifecycle.rs` — the engine's start and stop, and the runs it carries. Changes when an
//!   incarnation comes up or goes down, not when a session's commands do.
//! - `session_ipc.rs` — the commands a window addresses at an open session, and the answer shape
//!   `agent_open_session` mints. Changes when the session contract changes.
//!
//! What stays here is what none of them may own: the **paths** every one of those commands is
//! reached by, and the one helper three of them share. `report_pet_tasks` is private to this
//! module and reached by its children as `super::report_pet_tasks` — the arrangement this project's
//! other split modules use for an item both of their halves reach for, and the narrowest scope that
//! compiles: a child sees a private item of its own parent, so no `pub(super)` is needed and no
//! command in another module can call it.
//!
//! **Why the commands are re-exported rather than left where they now live.** `lib.rs`'s
//! `generate_handler!` names each one as `commands::agent::<name>`, `build.rs`'s `COMMANDS` holds the
//! bare names, and several test targets import `commands::agent::{…}`. Those paths are part of this
//! module's contract, so every command moved out is re-exported below together with the two macros
//! `#[tauri::command]` emits beside it. That last part is not tidiness: `generate_handler!` builds
//! its path by renaming only the *last* segment of the path written in `lib.rs`, so a command that
//! moved without its `__cmd__*` and `__tauri_command_name_*` macros leaves that handler list failing
//! to compile while the command itself still resolves — the one failure mode a re-export exists to
//! prevent. They are `#[macro_export]`, which is what makes the `pub use` of a macro legal in the
//! first place.

mod failure;
mod ipc_state;
mod lifecycle;
mod permissions;
mod session_ipc;

use tauri::Manager;

pub use failure::{refusal_message, AgentFailure};
pub use ipc_state::{AgentIpcState, AGENT_EVENT_CHANNEL};
pub use lifecycle::{
    __cmd__agent_cancel_run, __cmd__agent_start, __cmd__agent_stop,
    __tauri_command_name_agent_cancel_run, __tauri_command_name_agent_start,
    __tauri_command_name_agent_stop, agent_cancel_run, agent_start, agent_stop,
    stop_running_engine, AgentRuntimeHandle,
};
pub use permissions::{
    __cmd__agent_permission_answer, __cmd__agent_permission_grant_revoke,
    __cmd__agent_permission_grants, __tauri_command_name_agent_permission_answer,
    __tauri_command_name_agent_permission_grant_revoke,
    __tauri_command_name_agent_permission_grants, agent_permission_answer,
    agent_permission_grant_revoke, agent_permission_grants, apply_permission_answer,
    pending_prompts,
};
pub use session_ipc::{
    __cmd__agent_open_session, __cmd__agent_prompt, __cmd__agent_session_snapshot,
    __cmd__agent_set_config_option, __tauri_command_name_agent_open_session,
    __tauri_command_name_agent_prompt, __tauri_command_name_agent_session_snapshot,
    __tauri_command_name_agent_set_config_option, agent_open_session, agent_prompt,
    agent_session_snapshot, agent_set_config_option, AgentHostSession,
};

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
