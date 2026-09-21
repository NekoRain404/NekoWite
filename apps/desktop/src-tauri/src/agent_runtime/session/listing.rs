//! What `session/list` answers: the row this host hands a surface, and how a page of them is asked
//! for.
//!
//! **Why it is a file of its own.** It was a section of [`super`], which passed the 600-line budget
//! `docs/dev.md:286` puts on a business source file, and the criterion that section states is the
//! number of reasons a file changes rather than its length. This module moves when the *row* moves:
//! a field the schema adds, a field a surface stops rendering, or a change to how a page is
//! paginated. The parent moves when the host's own table of sessions does. The call lives beside the
//! row it answers with because a row's `held` flag is this host's reading of that table, taken once
//! per answer rather than per row.
//!
//! Nothing here decides whether a session is open: `held` reports what the parent's table says, and
//! the id a listing carries is the engine's.

use serde::Serialize;
use serde_json::Value;

use super::{AgentRuntime, SessionError, CONTROL_BOUND};

/// A session the engine opened.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    /// The engine's option list, to be rendered as it came.
    pub config_options: Value,
}

/// One session the engine holds, as `session/list` described it.
///
/// A projection of the schema's `SessionInfo` rather than the type itself, for the reason
/// [`SessionInfo`] above is one: what crosses this boundary is the fields a surface renders, and
/// the schema's `_meta` is "reserved by ACP to allow clients and agents to attach additional
/// metadata" — an engine's private annexe rather than a fact about the session.
///
/// The two optional fields are the schema's own optionals and are left optional here. The pinned
/// engine was measured filling both (`agent_session_lifecycle_test.rs` §4.5 prints
/// `title: "New session - 2026-09-17T01:36:22.667Z"` and a matching `updatedAt`), but the schema
/// says an agent may omit them, and a title this host *invented* for a session that had none
/// would be a fact about the engine that the engine never stated. There is deliberately no
/// `created_at`: the schema has no such field, so sorting by creation is not something a
/// `session/list` answer can support (Zed's archive view sorts by a client-side store instead —
/// `zed-main/crates/agent_ui/src/threads_archive_view.rs:287-291`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListing {
    pub session_id: String,
    /// The working directory the session belongs to, as the engine reported it.
    pub cwd: String,
    /// The engine's own title for the session, when it has one.
    pub title: Option<String>,
    /// ISO 8601, the engine's own last-activity stamp, when it has one.
    pub updated_at: Option<String>,
    /// Whether **this host** holds the session right now — the one field on this row that is not
    /// the engine's.
    ///
    /// `session/list` answers the engine's own table, which outlives the process that wrote it:
    /// sessions an earlier run of this app opened are still listed, and they are the whole reason
    /// a history exists. This host's table is narrower and deliberately so — §6.1 has the host
    /// refuse an id it never received a `session/new` or `session/load` answer for
    /// (`AgentRuntime::known_session`) — so a row
    /// this flag is false for is one `agent_close_session` will refuse *before* the engine is
    /// asked. A surface offering the free action is offering a call, and this is the half of the
    /// answer the engine cannot give.
    ///
    /// Carried on the row rather than asked for per call, because it is a property of the answer
    /// and not of the caller: the engine's list and this host's table are both read at one
    /// instant, and a second round trip would be a second instant.
    pub held: bool,
}

impl SessionListing {
    fn of(info: &agent_client_protocol::schema::v1::SessionInfo, held: bool) -> Self {
        Self {
            session_id: info.session_id.to_string(),
            cwd: info.cwd.to_string_lossy().into_owned(),
            title: info.title.clone(),
            updated_at: info.updated_at.clone(),
            held,
        }
    }
}

/// One page of `session/list`.
///
/// The cursor travels with the entries rather than being dropped, because the schema defines
/// `nextCursor` as "if absent, there are no more results" — so a host that read only `sessions`
/// would be unable to tell a complete list from a truncated one, and a surface rendering the
/// first page of many as though it were all of them is the quiet kind of wrong. The pinned engine
/// was measured answering in one page (the probe's answer carried no cursor), so today this is a
/// shape that keeps the door open rather than a path anyone walks.
#[derive(Debug, Clone)]
pub struct SessionPage {
    pub sessions: Vec<SessionListing>,
    /// Opaque, and only ever sent back to the engine that issued it.
    pub next_cursor: Option<String>,
}

impl AgentRuntime {
    /// Lists the sessions the engine holds.
    ///
    /// One of the four methods §4 of the scan report measured the engine serving and this host
    /// never calling, so this is the first caller rather than a second opinion: no session is
    /// opened, no credential is used and no provider is reached.
    ///
    /// **No session id is required, and none is invented.** The answer is the engine's own list
    /// for this connection — the sessions its profile root holds — so this negotiates and asks,
    /// which is why it is a method on the runtime rather than on one of its sessions. What comes
    /// back is projected to [`SessionListing`] rather than to a session this host now believes
    /// it has: a listed session is not an open one, and §6.1 forbids the host from treating an id
    /// it has not received a `session/new` or `session/load` answer for as one of its own.
    ///
    /// **`cursor` is the page the engine named, handed back unchanged.** `session/list` is
    /// paginated, `next_cursor` is opaque and only ever means something to the engine that issued
    /// it, and a host that answered the first page and dropped the cursor would be a surface that
    /// can say there is more and never fetch it — which is the defect this parameter exists for.
    /// A cursor this connection never issued is the engine's to refuse; nothing here reads it.
    pub async fn list_sessions(&self, cursor: Option<&str>) -> Result<SessionPage, SessionError> {
        self.negotiate().await?;
        let response = self
            .connection
            .list_sessions(None, cursor, CONTROL_BOUND)
            .await
            .map_err(SessionError::Transport)?;
        // The one fact on a row that is this host's rather than the engine's, read from the table
        // this runtime keeps: the guard `close_session` checks before it asks the engine is
        // `known_session`, so a window that drew the free action from the engine's list alone
        // would draw it on rows this host is going to refuse. Read here, under one lock, rather
        // than answered per row by a second call.
        let held = self.sessions.lock().unwrap();
        Ok(SessionPage {
            sessions: response
                .sessions
                .iter()
                .map(|info| {
                    SessionListing::of(info, held.contains_key(&info.session_id.to_string()))
                })
                .collect(),
            next_cursor: response.next_cursor.clone(),
        })
    }
}
