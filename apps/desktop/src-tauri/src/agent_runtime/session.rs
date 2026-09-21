//! Sessions: which engine session the host knows about, and what it is called.
//!
//! The run lifecycle on top of a session — starting a generation, ending one
//! exactly once, and routing the engine's updates into it — is in
//! [`super::runs`]. The seam is the one §6.1 draws: identity and registration
//! on this side, work in progress on the other.
//!
//! ACP has sessions but no runs. A session is a long conversation; a run is one
//! answer inside it. The host needs the second notion anyway, because
//! everything the UI does (stop, retry, "this answer is still coming") is
//! per-answer, and because §6.2 requires that one cancel ends exactly the
//! generation it was aimed at. The run id is therefore the host's invention,
//! carried alongside the engine's session id and never sent to the engine.
//!
//! **What is left here, and why.** This file passed the 600-line budget `docs/dev.md:286` puts on a
//! business source file, and the criterion that section states is the number of reasons a file
//! changes rather than its length — so the split is by subject. What stays is the host's own table
//! of sessions: the row it keeps ([`SessionSlot`]), the run state machine stamped on that row
//! ([`RunState`]), the §6.1 guard that refuses an id this host never received an answer for
//! ([`AgentRuntime::known_session`]), the control calls that keep the table in step with the
//! engine, and the three call bounds, which are read against each other. The subjects that were
//! separate are separate files, each with a header arguing why it is the one that moves when its
//! subject does:
//!
//! - [`error`] — the refusals a session call can make, and the code each maps to.
//! - [`emitter`] — the number a published frame carries, and the one critical section that keeps
//!   numbering and queue order the same order.
//! - [`streams`] — the reading half of a runtime: the streams the engine writes on.
//! - [`handshake`] — §3.4's first negotiation, once per incarnation and before any session.
//! - [`listing`] — what `session/list` answers, and which of its fields cross to a surface.
//! - [`load`] — adopting a session that already holds a conversation, and the replay drain.
//!
//! **Every path that named an item here still resolves.** Each child's public and crate-visible
//! items are re-exported below under the names they had, so `agent_runtime::session::X` and
//! `super::session::X` are unchanged for every caller — `runs`, `permissions`, `driver`, `update`
//! and the session IPC tests included.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::SessionId;
use serde_json::Value;
use tokio::sync::mpsc;

use super::acp_transport::{EngineConnection, EngineEvents};
use super::capabilities::{Handshake, SessionCapabilities};
use super::events::AgentIdentity;
use super::fs_capability::{ChangeRecord, FsCapability, VaultFiles};
use super::live_notes::LiveNotes;
use super::recovery::{Recovery, RecoveryOutcome, RecoveryRefusal};

mod emitter;
mod error;
mod handshake;
mod listing;
mod load;
mod streams;

pub use error::SessionError;
// The two re-exports whose names are not all used by every crate that compiles this file. Callers
// outside this module address them by the path they had before the split —
// `commands/agent_sessions.rs` names `session::{SessionListing, SessionPage}` and `driver.rs` names
// `session::RuntimeEvent` — while a test target that `#[path]`-includes this tree
// (`agent_recovery_test.rs`, `agent_settings_ipc_test.rs`) uses `SessionInfo` and
// `AgentRuntimeEvents` and none of the other three. `unused_imports` counts the names a crate uses
// rather than the paths that resolve, so the allowance sits on the re-export that keeps
// `session::X` resolving, instead of deleting a name that has a caller. `process.rs` has the same
// shape and the same reason.
#[allow(unused_imports)]
pub use listing::{SessionInfo, SessionListing, SessionPage};
#[allow(unused_imports)]
pub use streams::{AgentRuntimeEvents, RuntimeEvent};

pub(super) use emitter::Emitter;

/// How long the handshake may take. A process that cannot negotiate in this
/// long is not going to answer anything else either.
pub const INITIALIZE_BOUND: Duration = Duration::from_secs(20);

/// Session control calls are answered out of the engine's own state, so they
/// are quick by construction.
pub(super) const CONTROL_BOUND: Duration = Duration::from_secs(30);

/// `session/load` gets a bound of its own, because it is the one call in this group that is not
/// answered out of the engine's own table.
///
/// A load replays a conversation: every message, thought and tool call the session ever produced
/// is published as a `session/update` while the request is outstanding, so the time it takes
/// grows with the session rather than being a fixed lookup — the same reason §6.2 makes a
/// generation's bound a net rather than a budget. Longer than `CONTROL_BOUND` and far shorter
/// than a prompt's thirty minutes: a load streams no new tokens, so a session that takes minutes
/// to come back is a wedged engine rather than a long answer.
pub(super) const LOAD_BOUND: Duration = Duration::from_secs(120);

/// One session, as the host tracks it.
pub(super) struct SessionSlot {
    /// The engine's own options, stored as they were returned: the UI renders
    /// the engine's list, not one this host rebuilt (§6.3's rule that option
    /// ids are the engine's to define).
    config_options: Value,
    /// The run in progress or the last one to end, so a late answer can be
    /// recognized as belonging to something already over.
    pub(super) run: Option<RunState>,
    /// The root this session's file requests are confined to.
    ///
    /// Kept from `session/new`, because the engine's `fs/*` requests name a
    /// session and a path but never a vault: a path is only confined relative to
    /// a root THIS host chose, so the root has to be remembered from the call
    /// that established the session rather than taken from the request.
    pub(super) vault_root: String,
}

#[derive(Clone)]
pub(super) struct RunState {
    pub(super) run_id: String,
    /// Set the moment the user asks to stop, before the engine is told, so a
    /// chunk already in flight is dropped rather than delivered to a UI that
    /// has been told the run is over.
    pub(super) cancelled: bool,
    /// Set by whichever of cancellation and the engine's answer got there
    /// first; only that one may emit the ending.
    pub(super) finished: bool,
}

/// One engine process, driven as sessions and runs.
///
/// Every method here takes `&self`: what is left of the runtime after [`AgentRuntime::new`] is
/// the asking half, so it can be shared (`Arc`) across the IPC layer and reached from a command
/// without a lock. The reading half is [`AgentRuntimeEvents`], and it has one owner.
pub struct AgentRuntime {
    pub(super) connection: Arc<EngineConnection>,
    pub(super) sessions: Arc<Mutex<HashMap<String, SessionSlot>>>,
    pub(super) fs: Arc<FsCapability>,
    /// The baselines the delegated writes left, and the one recovery that judges them.
    ///
    /// Held here as well as in [`FsCapability`] — the same `Arc`, not a second table — because the
    /// capability is what *writes* a baseline and the commands are what *use* one, and a command
    /// reaching through the file-request server for a review operation would be one module
    /// answering for another's subject.
    pub(super) recovery: Arc<Recovery>,
    pub(super) emitter: Emitter,
    pub(super) run_counter: AtomicU64,
    /// What the engine has reported about itself, per session.
    ///
    /// Keyed by the engine's own session id and written by whoever heard first: the session
    /// response, or the command list the engine publishes right after it — which P0 §2.2 measured
    /// arriving as a notification and which `runs` forwards even when the session is not registered
    /// yet. So the entry is created by the reporter rather than only by [`Self::open_session`];
    /// reads pass through [`Self::capabilities`], which answers only about sessions this host
    /// registered, so an id the engine named but this host never opened is unreadable.
    reported: Arc<Mutex<HashMap<String, SessionCapabilities>>>,
    /// The handshake's answer, once per incarnation — the first of the two negotiations §3.4 names.
    handshake: Mutex<Option<Handshake>>,
    /// The update dispatcher's drain channel: the one place a caller can ask it to finish what the
    /// engine has already sent.
    ///
    /// It exists for `session/load` and nothing else. A load's response is what ends the run the
    /// replay belongs to, and the frames are handed over on a task of their own — so a response
    /// that closed the run without waiting for them would discard the conversation it just
    /// restored. See [`AgentRuntime::drain_updates`].
    flush: mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>,
    /// The sessions a `session/load` is in flight for, right now.
    ///
    /// The pre-registration [`Self::load_session`] does before it sends is what lets replayed
    /// frames find the session — and it is also why a second load of the same id must be refused:
    /// both calls would pass the "is it already open" check, both would insert a slot, and the
    /// second would overwrite the first's run id, so the first's replay frames would be stamped
    /// with a run the slot no longer names. That is a duplicate RPC against one session, which is
    /// what Zed's `pending_sessions` map exists to prevent ("underlying ACP load_session should be
    /// called exactly once for concurrent loads",
    /// `zed-main/crates/agent_servers/src/acp.rs:4090`).
    ///
    /// **Refused rather than shared**, which is where this differs from Zed's answer. Zed returns
    /// the in-flight task to the second caller; this host refuses, for the reason [`SessionError::
    /// RunInProgress`] refuses a second prompt — a caller that silently receives another call's
    /// answer cannot tell that it was not the one that asked. What the user sees is a sentence
    /// instead of a second spinner on the same row.
    loading: Mutex<std::collections::HashSet<String>>,
    /// Serializes the handshake, so two sessions opened at once share one.
    negotiating: tokio::sync::Mutex<()>,
}

impl AgentRuntime {
    /// Takes ownership of a live connection and starts reading it, returning the two halves.
    /// Must be called from a Tokio runtime.
    /// `files` is the app's own file path. It is a parameter rather than a call
    /// because this module must not reach into the app's storage by absolute
    /// path; see [`VaultFiles`] for why the tests hand in the real one.
    ///
    /// `live_notes` is the other port, and it is a parameter for the same reason in the other
    /// direction: asking a window is Tauri's surface, which this module must not know about,
    /// so whoever owns that surface supplies the end that reaches a window. One value rather
    /// than two because a table and the windows it asks are one mechanism — see [`LiveNotes`].
    pub fn new(
        identity: AgentIdentity,
        connection: EngineConnection,
        events: EngineEvents,
        files: Arc<dyn VaultFiles>,
        live_notes: LiveNotes,
    ) -> (Self, AgentRuntimeEvents) {
        let connection = Arc::new(connection);
        let sessions: Arc<Mutex<HashMap<String, SessionSlot>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (emitter, incoming) = Emitter::new(identity);
        let reported: Arc<Mutex<HashMap<String, SessionCapabilities>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Made before the dispatcher is spawned, because the dispatcher takes the reading half and
        // this is the only way back to it. See [`Self::drain_updates`].
        let (flush, drains) = mpsc::unbounded_channel();
        tokio::spawn(super::runs::dispatch_updates(
            events.updates,
            drains,
            Arc::clone(&sessions),
            Arc::clone(&reported),
            emitter.clone(),
        ));
        // One recovery for the incarnation, shared with the capability that feeds it: the
        // baselines a delegated write leaves are the material a recovery puts back, and two of
        // them would be two answers to "can this change be undone".
        let recovery = Arc::new(Recovery::new(Arc::clone(&files)));
        let fs = Arc::new(FsCapability::new(files, live_notes, Arc::clone(&recovery)));
        tokio::spawn(super::runs::dispatch_fs(
            events.fs,
            Arc::clone(&sessions),
            Arc::clone(&fs),
        ));

        (
            Self {
                connection,
                sessions,
                fs,
                recovery,
                emitter,
                run_counter: AtomicU64::new(0),
                reported,
                handshake: Mutex::new(None),
                flush,
                loading: Mutex::new(std::collections::HashSet::new()),
                negotiating: tokio::sync::Mutex::new(()),
            },
            AgentRuntimeEvents {
                incoming,
                permissions: events.permissions,
            },
        )
    }

    /// Opens a session in `cwd`.
    ///
    /// No credentials are involved: P0 §2.2 measured `session/new` succeeding
    /// with none configured, the provider being chosen afterwards through the
    /// model option.
    pub async fn open_session(&self, cwd: &Path) -> Result<SessionInfo, SessionError> {
        self.negotiate().await?;
        let response = self
            .connection
            .new_session(cwd, CONTROL_BOUND)
            .await
            .map_err(SessionError::Transport)?;
        let session_id = response.session_id.to_string();
        let config_options = response
            .config_options
            .as_ref()
            .and_then(|options| serde_json::to_value(options).ok())
            .unwrap_or_else(|| Value::Array(Vec::new()));

        {
            let handshake = self.handshake.lock().unwrap().clone();
            let mut reported = self.reported.lock().unwrap();
            // The entry may already exist: the engine publishes its command list the instant
            // `session/new` returns, and that notification can be dispatched before this insert
            // (measured ordering, `runs::forward_update`). What arrived early is kept, and the two
            // facts this call owns are added to it.
            let facts = reported.entry(session_id.clone()).or_default();
            if let Some(handshake) = handshake {
                facts.negotiated(handshake);
            }
            facts.opened(&response);
        }
        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            SessionSlot {
                config_options: config_options.clone(),
                run: None,
                vault_root: cwd.to_string_lossy().into_owned(),
            },
        );
        Ok(SessionInfo {
            session_id,
            config_options,
        })
    }

    /// Frees a session on the engine after taking it out of this host's own table.
    ///
    /// The host's half is removed even when the engine refuses, and for the reason
    /// [`Self::cancel`](super::runs) gives about a dead connection: a session this host cannot
    /// talk to any more is not one it should keep answering about. What is *not* done is
    /// pretending the call freed anything on the engine — the scan report measured that a closed
    /// session stays in `session/list` (`session/delete` is the method that removes it, and this
    /// engine answers `-32601` for that), so a caller must not read a successful close as a
    /// removal from the list.
    pub async fn close_session(&self, session_id: &str) -> Result<(), SessionError> {
        self.known_session(session_id)?;
        let closed = self
            .connection
            .close_session(SessionId::new(session_id), CONTROL_BOUND)
            .await;
        self.sessions.lock().unwrap().remove(session_id);
        self.reported.lock().unwrap().remove(session_id);
        closed.map(|_| ()).map_err(SessionError::Transport)
    }

    /// What the engine reported about `session_id`.
    ///
    /// `Err` for a session this host never opened — §6.1: answering about an id it did not receive
    /// would be inventing one — and `Ok(None)` for a session it opened and has heard nothing about.
    /// The two are different answers, and a caller that merged them would be telling a forged id
    /// exactly what it tells a real one.
    ///
    /// Read fresh on every call rather than handed out as a value someone keeps: this is the
    /// engine's own report for one incarnation, and a copy that outlived either would be a claim
    /// about an engine nobody asked.
    pub fn capabilities(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionCapabilities>, SessionError> {
        self.known_session(session_id)?;
        Ok(self.reported.lock().unwrap().get(session_id).cloned())
    }

    /// Selects an option on an open session — in practice the model, which P0
    /// §2.3 measured working mid-session.
    ///
    /// The value is passed through as the engine's own option id: the host must
    /// not build `provider/model` strings of its own, because the list of what
    /// exists is the engine's.
    pub async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<Value, SessionError> {
        self.known_session(session_id)?;
        let response = self
            .connection
            .set_config_option(
                SessionId::new(session_id),
                config_id.to_string(),
                value.to_string(),
                CONTROL_BOUND,
            )
            .await
            .map_err(SessionError::Transport)?;
        let config_options = serde_json::to_value(&response.config_options)
            .unwrap_or_else(|_| Value::Array(Vec::new()));
        if let Some(slot) = self.sessions.lock().unwrap().get_mut(session_id) {
            slot.config_options = config_options.clone();
        }
        Ok(config_options)
    }

    /// The changes this runtime performed on the agent's behalf, oldest first.
    ///
    /// §7.2's attribution record; the review surface that reads it is T10's.
    pub fn changes(&self) -> Vec<ChangeRecord> {
        self.fs.changes()
    }

    /// The change to put back for one session's file, or nothing when this host performed none.
    ///
    /// **The session's own root decides what is looked under**, and it is read from the host's
    /// table rather than taken from the caller: a path is only a path inside one vault, and a
    /// recovery that paired one vault's record with another vault's file is the cross-root mistake
    /// every other call here refuses. §6.1's guard comes first for the same reason it does
    /// everywhere else — a session this host never opened has no root, and answering about one
    /// would be answering about a session the renderer invented.
    ///
    /// `Ok(None)` is «this host has no such change», which is not a failure of the call: the file
    /// may have been written by the engine with its own tools (P0 §7 measured that path existing),
    /// or by the user, and either way there is nothing here to put back.
    pub fn change_for(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Option<ChangeRecord>, SessionError> {
        self.known_session(session_id)?;
        let root = self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|slot| slot.vault_root.clone());
        Ok(root.and_then(|root| self.fs.change_for(&root, path)))
    }

    /// Put one of them back, judged again at this moment.
    ///
    /// The judgement lives in [`Recovery`] and is not repeated here: this is the runtime saying
    /// which table the changes are in, not a second opinion about whether one can be undone.
    pub fn recover(&self, change: &ChangeRecord) -> Result<RecoveryOutcome, RecoveryRefusal> {
        self.recovery.recover(change)
    }

    /// Ends the runtime and the engine with it.
    pub fn shutdown(&self) {
        self.connection.shutdown();
    }

    /// Whether the engine this runtime started is still running.
    ///
    /// The other half of [`Self::shutdown`], and the reason it is asked at all: this runtime holds the
    /// (agent, profile, vault) claim, and the registry refuses a second engine for that triple while
    /// the claim is held. An engine that exited on its own has released nothing — nothing runs on its
    /// way out — so a start has to be able to ask whether what it is about to replace is still there.
    /// Answered by the connection, which owns the process; see
    /// [`EngineConnection::engine_is_running`].
    pub fn engine_is_running(&self) -> bool {
        self.connection.engine_is_running()
    }

    /// Fails unless this host opened `session_id`.
    ///
    /// Public because the command boundary is where §6.1's guard is applied: a call that reaches
    /// the runtime from outside needs the same check the methods here make, and a second
    /// implementation of "is this a session of ours" at the IPC layer is how two answers to one
    /// question appear.
    pub fn known_session(&self, session_id: &str) -> Result<(), SessionError> {
        let known = self.sessions.lock().unwrap().contains_key(session_id);
        if known {
            Ok(())
        } else {
            Err(SessionError::UnknownSession {
                session_id: session_id.to_string(),
            })
        }
    }
}
