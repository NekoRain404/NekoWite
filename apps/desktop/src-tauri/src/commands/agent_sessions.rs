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

use crate::agent_runtime::session::{SessionError, SessionListing, SessionPage};
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
///
/// **That refusal is worded here, and it names this app.** The generic
/// [`SessionError::failure_message`](crate::agent_runtime::session::SessionError::failure_message)
/// for an unknown session — 「session X is no longer open」 — is right for a call about a session
/// the window was already following (a stale handle, an event for a session that has ended). It is
/// wrong for *this* call, which arrives from a list: the row is still there, the engine still
/// holds it, and what refused is this app's own boundary. A window that drew the engine's
/// sentence under a sentence of its own blaming the engine would be attributing this app's §6.1
/// guard to the engine — the two are different facts, and only one of them is something the user
/// can do anything about.
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
        .map_err(|error| close_refusal(&error))
}

/// What a refused close says, as this host's own sentence where the refusal is this host's.
///
/// A function rather than an arm of the command, for the reason `runs.rs` gives about its own
/// small helpers: the wording is a rule (below), and a rule that can only be exercised with a live
/// engine is a rule no test holds. The other half is that the sentence is read by a *list* whose
/// rows are drawn from the engine's table, so the two refusers must not be confused by accident.
fn close_refusal(error: &SessionError) -> String {
    match error {
        // §6.1's guard, and the one refusal on this path that is not the engine's. The row the
        // reader pressed is still in the engine's list — that is what makes it a *listed* session
        // — so the generic "session X is no longer open" would be both vague and, under the
        // panel's own lead-in, read as the engine's doing. Naming this app is the whole point:
        // 「the engine would not release it」 and 「this app will not release it」 are different
        // facts, and only the second one has anything the user can act on.
        SessionError::UnknownSession { session_id } => format!(
            "this app is not serving session {session_id} in this run, so it cannot ask the \
             engine to free it"
        ),
        // Everything else is the engine's or the transport's, and their own sentences are already
        // the ones the user acts on — the certificate case is the one `TransportError` rewords
        // itself, for the same reason this arm exists: a sentence has to name the thing that
        // refused.
        other => other.failure_message(),
    }
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
    // §6.2's log, told what is about to arrive before it does: a load replays a conversation as
    // ordinary events, and events replayed by a load are that session's *history* rather than a
    // turn of it — so the log records them without binding the load's run as the session's turn
    // (see `SessionSnapshots::adopting`; without it a restored conversation reaches a mounting
    // window as a turn that is still running). Cleared by the `opened` call below, on the same
    // answer the window's handle is minted from.
    session.snapshots.adopting(&session_id);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The one refusal on this path that is this app's rather than the engine's.
    ///
    /// A window draws this under a lead-in of its own, and the row it belongs to is a session the
    /// *engine* still lists — so a sentence that named neither refuser, or the wrong one, would
    /// leave a reader blaming the engine for §6.1's boundary. Asserted here rather than in a live
    /// run because the wording is the whole behaviour: the call itself is one round trip, and the
    /// engine is not even reached.
    #[test]
    fn an_unknown_session_is_refused_in_this_apps_own_words() {
        let error = SessionError::UnknownSession {
            session_id: "session-7".to_string(),
        };
        let sentence = close_refusal(&error);
        assert!(
            sentence.contains("this app"),
            "the refusal must name the refuser: {sentence}"
        );
        assert!(
            sentence.contains("session-7"),
            "and the session it is about: {sentence}"
        );
        // The generic sentence is right where it is used — a handle that went stale under a window
        // that was already following the session — and wrong here, where nothing about it says
        // that what refused was this app. Keeping the two apart is the fix, so the test is the
        // difference between them.
        assert_ne!(sentence, error.failure_message());
    }

    /// Every other refusal on this path is the engine's or the transport's, and their own
    /// sentences are passed through untouched — the certificate case is the one the transport
    /// rewords itself, and this command has nothing to add to it.
    #[test]
    fn an_engines_own_refusal_is_passed_through_unchanged() {
        for error in [
            SessionError::AlreadyOpen {
                session_id: "session-7".to_string(),
            },
            SessionError::LoadInFlight {
                session_id: "session-7".to_string(),
            },
            SessionError::RunInProgress {
                session_id: "session-7".to_string(),
            },
        ] {
            assert_eq!(close_refusal(&error), error.failure_message());
            assert!(
                !close_refusal(&error).contains("this app"),
                "only the host's own guard is worded as the host's",
            );
        }
    }
}
