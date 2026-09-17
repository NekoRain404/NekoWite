//! Session history as the window asks for it: what the engine holds, and reopening one of them.
//!
//! Its own command file for the reason `agent_capabilities.rs` and `agent_registry.rs` have theirs:
//! this is a *subject* — the sessions that already exist — and not another call on the session in
//! front of the user. `commands/agent.rs` is the session a window is *in*; every command there
//! addresses it by an id that must already be open. Two of the three here are about ids that are
//! not open yet, which is why they cannot live there.
//!
//! ## Why the vault is checked rather than taken
//!
//! `agent_load_session` is the one command in this file that admits a *new* session to the host,
//! and the root it admits it under becomes the confinement for every `fs/*` request the engine
//! delegates to this app (`SessionSlot::vault_root`). §6.1's rule is that the renderer names a
//! vault and does not choose one, and `agent_open_session`'s doc gives the reason in full: a root
//! a renderer invented would be a confinement drawn around a directory the user never opened. The
//! same two checks therefore appear here, in the same order, for the same reason — and they are
//! `AgentRuntime::load_session`'s `cwd` parameter rather than being re-derived inside it, because
//! only this boundary has the [`VaultRegistry`] that can canonicalize a path.
//!
//! ## What is deliberately not here
//!
//! A `cwd` filter or a cursor on the listing. Both are optional in the schema and the pinned
//! engine was measured answering `{}` in one page (the probe's answer carried no `nextCursor`), so
//! the parameters would be a surface with nothing behind it. `SessionPage::next_cursor` travels
//! out of the runtime all the same, so the day an engine paginates the fact is already on the
//! wire rather than being discovered.

use serde::Serialize;

use crate::agent_runtime::session::{SessionListing, SessionPage};
use crate::state::VaultRegistry;

use super::agent::{AgentHostSession, AgentIpcState};

/// One page of the engine's own session table, as this host reads it out.
///
/// A page rather than a bare array, so `nextCursor` has somewhere to be: the schema defines its
/// absence as "there are no more results", which means a caller handed only the array could not
/// tell a complete list from a truncated one. See `SessionPage`'s own note.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionHistory {
    pub sessions: Vec<SessionListing>,
    /// Opaque. The engine's own token, passed back to it and interpreted by nothing here.
    pub next_cursor: Option<String>,
}

/// Frees a session on the engine and takes it out of this host's table.
///
/// **Not a deletion, and the answer must not be read as one.** The schema gives that job to
/// `session/delete` — "deleting an existing session from `session/list`" — and the pinned engine
/// neither advertises nor implements it (`agent_session_lifecycle_test.rs` prints its `-32601`).
/// The probe measured the other half in the same run: a closed session **stays in
/// `session/list`**, so a window that closed a session and redrew its history will find the row
/// still there, and that is the two methods meaning what they say.
///
/// Refused for a session this host does not hold, before the engine is asked: §6.1's rule is that
/// an id this host never received is not one it forwards.
#[tauri::command]
pub async fn agent_close_session(
    ipc: tauri::State<'_, AgentIpcState>,
    session_id: String,
) -> Result<(), String> {
    let session = ipc.session()?;
    session
        .runtime
        .close_session(&session_id)
        .await
        .map_err(|error| error.failure_message())
}

/// The sessions this engine holds.
///
/// One of the four methods §4 of the scan report measured the engine serving and this host never
/// calling — and the one a user notices first, because it is what a history surface is drawn from.
/// Free: answered out of the engine's own database, no session opened, no credential used, no
/// provider reached.
///
/// The gate on whether a window may *offer* this is the engine's own handshake —
/// `sessionCapabilities.list`, reported as the `session-list` row of
/// `agent_session_capabilities`. This command does not repeat the check: a handshake is one
/// engine's report about itself, and refusing here would be this host answering for an engine on
/// evidence it did not have. The call goes through, and an engine that meant no answers with its
/// own refusal, classified and worded by the transport.
#[tauri::command]
pub async fn agent_list_sessions(
    ipc: tauri::State<'_, AgentIpcState>,
) -> Result<AgentSessionHistory, String> {
    let session = ipc.session()?;
    let page: SessionPage = session
        .runtime
        .list_sessions()
        .await
        .map_err(|error| error.failure_message())?;
    Ok(AgentSessionHistory {
        sessions: page.sessions,
        next_cursor: page.next_cursor,
    })
}

/// Reopens a session the engine holds, in a vault the user has open.
///
/// The session becomes one of this host's own: registered, stamped with the epoch a window
/// validates events against, given a snapshot log to replay from, and — if the engine replays its
/// conversation during the load — emitting those frames on the same channel every other frame of
/// this runtime travels on. What the caller receives is the same handle `agent_open_session`
/// answers, so a window that already knows how to follow a session needs no second code path.
///
/// **Refused for a session this host already holds** (`AlreadyOpen`), and for a vault mismatch
/// before the engine is asked at all. Both are sentences about the user's click rather than
/// failures of the engine, which is why they travel as text like every other refusal here.
#[tauri::command]
pub async fn agent_load_session(
    vaults: tauri::State<'_, VaultRegistry>,
    ipc: tauri::State<'_, AgentIpcState>,
    vault_id: String,
    cwd: String,
    session_id: String,
) -> Result<AgentHostSession, String> {
    let session = ipc.session()?;
    // §6.1, exactly as `agent_open_session` states it: the renderer names a vault, it does not
    // choose one.
    if vault_id != session.identity.vault_id {
        return Err(format!(
            "this engine was started for the vault {} and not for {vault_id}",
            session.identity.vault_id
        ));
    }
    // The canonical root, not the string the renderer sent — and the string this session will be
    // confined to for every file request the engine delegates.
    let root = vaults.authorize(&cwd)?;
    let info = session
        .runtime
        .load_session(&session_id, &root)
        .await
        .map_err(|error| error.failure_message())?;
    // §6.2's log, opened for the loaded session before this returns: a replayed frame that arrived
    // while the load was in flight has already been recorded by the driver, and this is what makes
    // the entry exist for a window that takes its snapshot the instant this answers.
    session.snapshots.opened(&info.session_id);
    Ok(AgentHostSession {
        session_id: info.session_id,
        config_options: info.config_options,
        model_option_id: session.model_option_id.clone(),
    })
}
