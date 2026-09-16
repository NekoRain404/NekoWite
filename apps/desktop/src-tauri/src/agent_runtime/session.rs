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

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::SessionId;
use serde_json::Value;
use tokio::sync::mpsc;

use super::acp_transport::{EngineConnection, EngineEvents, PermissionRequest};
use super::fs_capability::{ChangeRecord, FsCapability, VaultFiles};
use super::events::{
    AgentEventEnvelope, AgentEventKind, AgentFailureCode, AgentIdentity, TransportError,
};

/// How long the handshake may take. A process that cannot negotiate in this
/// long is not going to answer anything else either.
pub const INITIALIZE_BOUND: Duration = Duration::from_secs(20);

/// Session control calls are answered out of the engine's own state, so they
/// are quick by construction.
pub(super) const CONTROL_BOUND: Duration = Duration::from_secs(30);

/// Why a session call was refused.
#[derive(Debug, Clone)]
pub enum SessionError {
    Transport(TransportError),
    /// The host was asked about a session it never opened: §6.1 forbids
    /// inventing a session id, and answering about one would be exactly that.
    UnknownSession { session_id: String },
    /// §6.2: one active generation per session. A second prompt is refused
    /// rather than queued behind the first, because a silent queue turns a
    /// user's second thought into a surprise answer minutes later.
    RunInProgress { session_id: String },
}

impl SessionError {
    /// The condition, as the contract names it.
    pub fn failure_code(&self) -> AgentFailureCode {
        match self {
            SessionError::Transport(error) => error.failure_code(),
            // A session the host does not have is a session whose runtime epoch
            // has moved on — the app restarted, the vault was switched — which
            // is what `session-stale` describes.
            SessionError::UnknownSession { .. } => AgentFailureCode::SessionStale,
            SessionError::RunInProgress { .. } => AgentFailureCode::Cancelled,
        }
    }

    /// The sentence the user sees.
    pub fn failure_message(&self) -> String {
        match self {
            SessionError::Transport(error) => error.failure_message(),
            SessionError::UnknownSession { session_id } => {
                format!("session {session_id} is no longer open")
            }
            SessionError::RunInProgress { .. } => {
                "this session is already answering; wait for it or stop it".to_string()
            }
        }
    }
}

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

/// Stamps and sends host envelopes.
///
/// The sequence counter is shared by the update dispatcher and every run task,
/// and it has to be: two counters would hand the UI two streams that each look
/// monotonic while together they are not.
#[derive(Clone)]
pub(super) struct Emitter {
    identity: AgentIdentity,
    sequence: Arc<AtomicU64>,
    events: mpsc::UnboundedSender<AgentEventEnvelope>,
}

impl Emitter {
    pub(super) fn emit(
        &self,
        session_id: &str,
        run_id: Option<String>,
        kind: AgentEventKind,
        payload: Value,
    ) {
        let envelope = AgentEventEnvelope {
            agent_id: self.identity.agent_id.clone(),
            profile_id: self.identity.profile_id.clone(),
            runtime_epoch: self.identity.runtime_epoch.clone(),
            vault_id: self.identity.vault_id.clone(),
            session_id: session_id.to_string(),
            run_id,
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            kind,
            payload,
        };
        // The receiver is [`AgentRuntimeEvents`], held by the one task that drives the runtime.
        // A send that fails means that task is gone, which is the shutdown path, not an event to
        // report.
        let _ = self.events.send(envelope);
    }
}

/// The reading half of one runtime: the streams the engine writes on.
///
/// Split from [`AgentRuntime`] at construction, exactly as [`EngineConnection::connect`] hands
/// back an [`EngineEvents`] beside the connection — and for the reason that split's own doc
/// gives, one layer up: asking takes `&self`, reading takes `&mut`, and the object every caller
/// asks through must not be the object the reader is parked on.
///
/// Two accessors on one `&mut self` cannot be held at once, and the driver needs both: while it
/// waits for a `session/update`, a permission request may arrive, and answering a permission is a
/// command that must not be blocked behind the wait. One task owning both receivers by value is
/// the shape that has no lock to hold across a wait, and therefore no way for the stop §6.2
/// requires to be stuck behind a pending request (T3 found the shape this replaces).
///
/// **It ends on its own.** Both channels are the runtime's: when the runtime goes, both `recv`s
/// answer `None`, so a driver ends with the incarnation it feeds and needs no handle to be
/// aborted through — which is also why nothing here carries a generation counter.
pub struct AgentRuntimeEvents {
    incoming: mpsc::UnboundedReceiver<AgentEventEnvelope>,
    permissions: mpsc::UnboundedReceiver<PermissionRequest>,
}

/// What the runtime hands its reader: either stream, whichever has something.
pub enum RuntimeEvent {
    Event(AgentEventEnvelope),
    Permission(PermissionRequest),
}

impl AgentRuntimeEvents {
    /// The next host event, or `None` once the runtime has stopped.
    pub async fn next_event(&mut self) -> Option<AgentEventEnvelope> {
        self.incoming.recv().await
    }

    /// The next engine→client request waiting for an answer.
    ///
    /// Nothing answers it here: §6.3 requires the engine's own option ids to be what the user is
    /// offered, and choosing between them is T3/T7's. What this guarantees is only that the
    /// request is not lost, which §6.2 demands in as many words.
    pub async fn next_permission(&mut self) -> Option<PermissionRequest> {
        self.permissions.recv().await
    }

    /// Whichever of the two arrives first.
    ///
    /// One method rather than a `select!` at every call site, because two `&mut self` borrows of
    /// this type cannot be held at once — the property the split exists for: exactly one loop
    /// reads the engine. Both `recv`s are cancel-safe, so the arm that does not win loses nothing,
    /// and `select!` picks among ready arms at random rather than starving one of them.
    pub async fn next(&mut self) -> Option<RuntimeEvent> {
        tokio::select! {
            event = self.incoming.recv() => event.map(RuntimeEvent::Event),
            permission = self.permissions.recv() => permission.map(RuntimeEvent::Permission),
        }
    }
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
    pub(super) emitter: Emitter,
    pub(super) run_counter: AtomicU64,
}

impl AgentRuntime {
    /// Takes ownership of a live connection and starts reading it, returning the two halves.
    /// Must be called from a Tokio runtime.
    /// `files` is the app's own file path. It is a parameter rather than a call
    /// because this module must not reach into the app's storage by absolute
    /// path; see [`VaultFiles`] for why the tests hand in the real one.
    pub fn new(
        identity: AgentIdentity,
        connection: EngineConnection,
        events: EngineEvents,
        files: Arc<dyn VaultFiles>,
    ) -> (Self, AgentRuntimeEvents) {
        let connection = Arc::new(connection);
        let sessions: Arc<Mutex<HashMap<String, SessionSlot>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (outgoing, incoming) = mpsc::unbounded_channel();
        let emitter = Emitter {
            identity,
            sequence: Arc::new(AtomicU64::new(0)),
            events: outgoing,
        };

        tokio::spawn(super::runs::dispatch_updates(
            events.updates,
            Arc::clone(&sessions),
            emitter.clone(),
        ));
        let fs = Arc::new(FsCapability::new(files));
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
                emitter,
                run_counter: AtomicU64::new(0),
            },
            AgentRuntimeEvents {
                incoming,
                permissions: events.permissions,
            },
        )
    }

    /// Negotiates the protocol and returns the engine's answer.
    pub async fn initialize(
        &self,
    ) -> Result<agent_client_protocol::schema::v1::InitializeResponse, TransportError> {
        self.connection.initialize(INITIALIZE_BOUND).await
    }

    /// Opens a session in `cwd`.
    ///
    /// No credentials are involved: P0 §2.2 measured `session/new` succeeding
    /// with none configured, the provider being chosen afterwards through the
    /// model option.
    pub async fn open_session(&self, cwd: &Path) -> Result<SessionInfo, SessionError> {
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

    /// Ends the runtime and the engine with it.
    pub fn shutdown(&self) {
        self.connection.shutdown();
    }

    /// Fails unless this host opened `session_id`.
    pub(super) fn known_session(&self, session_id: &str) -> Result<(), SessionError> {
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

/// A session the engine opened.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    /// The engine's option list, to be rendered as it came.
    pub config_options: Value,
}
