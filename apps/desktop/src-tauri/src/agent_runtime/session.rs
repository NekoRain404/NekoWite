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
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use super::acp_transport::{EngineConnection, EngineEvents, PermissionRequest};
use super::capabilities::{Handshake, SessionCapabilities};
use super::events::{
    AgentEventEnvelope, AgentEventKind, AgentFailureCode, AgentIdentity, TransportError,
};
use super::fs_capability::{ChangeRecord, FsCapability, VaultFiles};
use super::live_notes::LiveNotes;

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

/// Why a session call was refused.
#[derive(Debug, Clone)]
pub enum SessionError {
    Transport(TransportError),
    /// The host was asked about a session it never opened: §6.1 forbids
    /// inventing a session id, and answering about one would be exactly that.
    UnknownSession {
        session_id: String,
    },
    /// §6.2: one active generation per session. A second prompt is refused
    /// rather than queued behind the first, because a silent queue turns a
    /// user's second thought into a surprise answer minutes later.
    RunInProgress {
        session_id: String,
    },
    /// A load named a session this host already holds.
    ///
    /// Not a fault in the engine: a session this app opened is open, and re-loading it would
    /// replace the slot a window is following — dropping its run, its vault root and its
    /// engine-reported options — with a second copy of itself. The user picked a row they are
    /// already in, and the answer is to say so rather than to reload underneath them.
    AlreadyOpen {
        session_id: String,
    },
    /// A `session/load` for this session is already in flight.
    ///
    /// Its own variant rather than a reuse of [`Self::AlreadyOpen`], because the two are different
    /// facts about the user's click and the wording is what they act on: one says the session is
    /// open (do nothing), the other says it is being opened (wait a moment). They also reach
    /// different states — the second is transient, and a caller that treated it as the first would
    /// tell the user their session was already open while it was still coming back.
    LoadInFlight {
        session_id: String,
    },
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
            // The session is one this host holds, so the epoch has not moved — what is wrong is
            // that the caller asked to open something that is already open, which is the same
            // class of "this call does not fit the session's state" that `RunInProgress` names.
            SessionError::AlreadyOpen { .. } => AgentFailureCode::BufferConflict,
            SessionError::LoadInFlight { .. } => AgentFailureCode::BufferConflict,
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
            SessionError::AlreadyOpen { session_id } => {
                format!("session {session_id} is already open in this window")
            }
            SessionError::LoadInFlight { session_id } => {
                format!("session {session_id} is still being reopened; wait for it to finish")
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

/// The sequence the first frame a runtime publishes carries.
///
/// Zero is not a sequence any frame may carry, and it is not a free choice: 0 is what this host
/// answers with when a session has published *nothing*. An empty [`super::snapshot::SessionLog`]
/// reports `sequence: 0`, the contract says the same in as many words ("or 0 when the session has
/// emitted nothing yet"), this host's own views sit at 0 until they have applied a frame, and
/// `task_projection`'s `FrameOrder::off_stream` uses 0 for a fact the host reports from its own view
/// rather than reads off a stream — which is what `notification_policy` branches on to tell the two
/// apart. A stream whose first frame was also 0 would make "nothing has been published" and "frame 0
/// was published" one value on the wire, and the window that mounted in between would drop the frame
/// **silently**: every delivery path compares with `>` against the caller's position (`channel.ts`'s
/// tail replay and live buffer, the reducer's own `judgeSequence`), and a hole is only recorded from
/// a position above zero — so the frame is filtered out at all three layers with no gap to show for
/// it. Numbering from one leaves 0 free to mean "no frame", which is what every one of those readers
/// already assumes it means.
///
/// The stream this numbers is one runtime incarnation's (the identity carries the epoch), so this is
/// the start of a sequence space, not of a global count: nothing persisted compares across it — the
/// pet's durable stream marks are deliberately dropped when the process changes.
const FIRST_SEQUENCE: u64 = 1;

/// Stamps and sends host envelopes.
///
/// The sequence counter is shared by the update dispatcher and every run task,
/// and it has to be: two counters would hand the UI two streams that each look
/// monotonic while together they are not.
///
/// **Numbering and delivery are one step, under one lock.** They were two — `fetch_add` and then a
/// send — and that is a real hole rather than a theoretical one: three producers emit on this path
/// (the update dispatcher, whichever task ends a run, and the permission table, which is reached
/// from the driver's own task), so a frame numbered `n` can be queued after a frame numbered `n + 1`.
/// The receiver takes the stream in queue order, and every consumer of the number treats a frame at
/// or below its position as a *replay or an out-of-order arrival* and drops it — the window's
/// reducer records a hole only for a frame *above* its position, so the late frame is dropped with
/// nothing said. A window that can tell it missed a frame is a different situation from one that
/// cannot; §6.2's handshake exists for the second to be impossible.
#[derive(Clone)]
pub(super) struct Emitter {
    identity: AgentIdentity,
    /// The next sequence to assign.
    ///
    /// A mutex rather than an atomic because the number and the queue push have to be one critical
    /// section — see the type's own note. What it costs: one uncontended lock/unlock per published
    /// frame, on the producer's side (the task that forwards the engine's updates), held for a
    /// read-and-increment plus the envelope's own construction and an unbounded channel's push —
    /// all of it allocation-bounded, none of it awaiting. Contention needs two producers in the same
    /// instant, which is a run ending or a permission request landing mid-turn, not steady state:
    /// for the length of one turn the update dispatcher is the only emitter, so the lock is taken
    /// and released by one task.
    sequence: Arc<Mutex<u64>>,
    events: mpsc::UnboundedSender<AgentEventEnvelope>,
}

impl Emitter {
    /// The runtime's emitter, and the channel the frames it publishes arrive on.
    ///
    /// Made in one place so that where a stream starts is this type's business and nobody else's:
    /// [`FIRST_SEQUENCE`] is the one line that decides whether a frame can carry the value every
    /// other module reads as "no frame".
    fn new(identity: AgentIdentity) -> (Self, mpsc::UnboundedReceiver<AgentEventEnvelope>) {
        let (events, incoming) = mpsc::unbounded_channel();
        (
            Self {
                identity,
                sequence: Arc::new(Mutex::new(FIRST_SEQUENCE)),
                events,
            },
            incoming,
        )
    }

    pub(super) fn emit(
        &self,
        session_id: &str,
        run_id: Option<String>,
        kind: AgentEventKind,
        payload: Value,
    ) {
        // Held until the frame is in the queue, so the frame that took `n` is queued before any
        // other emitter can take `n + 1`: the queue order is the numbering order, and no consumer
        // has to detect a reordering the emitter could have prevented.
        let mut next = self.sequence.lock().unwrap();
        let sequence = *next;
        *next += 1;
        let envelope = AgentEventEnvelope {
            agent_id: self.identity.agent_id.clone(),
            profile_id: self.identity.profile_id.clone(),
            runtime_epoch: self.identity.runtime_epoch.clone(),
            vault_id: self.identity.vault_id.clone(),
            session_id: session_id.to_string(),
            run_id,
            sequence,
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
        let fs = Arc::new(FsCapability::new(files, live_notes));
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

    /// Negotiates the protocol and returns the engine's answer.
    ///
    /// The answer is also this incarnation's capability evidence: §3.4's row makes the handshake
    /// the first of the two negotiations that decide what is available at runtime, so what it
    /// reported is kept here rather than dropped by a caller that only wanted the version.
    pub async fn initialize(
        &self,
    ) -> Result<agent_client_protocol::schema::v1::InitializeResponse, TransportError> {
        let response = self.connection.initialize(INITIALIZE_BOUND).await?;
        *self.handshake.lock().unwrap() = Some(Handshake::of(&response));
        Ok(response)
    }

    /// The handshake this incarnation read, if it has read one.
    ///
    /// **Per incarnation, not per session**, which is the fact a caller with no session needs:
    /// ACP makes `initialize` a connection's first request, so one process answers it once and
    /// every session on that process shares the answer. [`Self::capabilities`] reads the same
    /// value, one session at a time, because a session's *other* facts (its option list, its
    /// published command list) are per session; this accessor is for the half that is not.
    ///
    /// A clone rather than a reference: the caller is the settings IPC, which runs on another task
    /// and must not hold a lock on this runtime while it renders. The value is bounded by the same
    /// rule §3.4 gives the capability report — it belongs to a live incarnation — and a caller that
    /// has the instance is the caller that has the incarnation.
    pub fn handshake(&self) -> Option<Handshake> {
        self.handshake.lock().unwrap().clone()
    }

    /// The handshake, once per incarnation, before the first session.
    ///
    /// ACP's own rule, and the SDK's agent side enforces it in as many words: a connection's first
    /// request is `initialize` ("first ACP request must be initialize"). §3.4's capability row is
    /// where that matters to this app — the two negotiations decide what works, so no session is
    /// opened before the first of them has been read.
    ///
    /// Idempotent by the fact rather than by a counter: once the answer is kept, a second caller
    /// gets the first caller's result instead of a second `initialize` on one connection. The lock
    /// is held across the await on purpose — it is what makes two sessions opened at once share
    /// one handshake rather than race two.
    async fn negotiate(&self) -> Result<(), SessionError> {
        let _one_at_a_time = self.negotiating.lock().await;
        if self.handshake.lock().unwrap().is_some() {
            return Ok(());
        }
        self.initialize().await.map_err(SessionError::Transport)?;
        Ok(())
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
    pub async fn list_sessions(&self) -> Result<SessionPage, SessionError> {
        self.negotiate().await?;
        let response = self
            .connection
            .list_sessions(None, None, CONTROL_BOUND)
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

    /// Waits until every notification the engine has already sent has been turned into an event.
    ///
    /// The update dispatcher reads one channel and this is the only way to ask it where it is: a
    /// drain request is answered after the queue it shares with the engine's frames has been
    /// emptied. It is not a sleep and it is not a guess — the transport pushes a notification and
    /// resolves the response for the call it arrived during on one task, **in that order**, so
    /// everything queued when this is called is everything the engine had said beforehand. What it
    /// does not cover, and cannot, is a frame the engine sends *after* answering; that frame
    /// arrives after the request it belongs to and is a straggler by definition.
    ///
    /// Called by [`Self::load_session`] and nowhere else, because a load is the one request whose
    /// answer is not the last word about the work it did.
    async fn drain_updates(&self) {
        let (answered, drained) = tokio::sync::oneshot::channel();
        // A closed channel means the dispatcher is gone, which is the shutdown path: there is
        // nothing left to drain and nothing to report to a caller that is already leaving.
        if self.flush.send(answered).is_err() {
            return;
        }
        // A caller that stops waiting loses nothing: the frame is forwarded either way, and the
        // answer is a receipt rather than the work.
        let _ = drained.await;
    }

    /// Reopens a session the engine holds, adopting it as one of this host's own.
    ///
    /// **What makes this different from [`Self::open_session`].** A new session is born empty; a
    /// loaded one already has a conversation, and the engine hands that conversation back as
    /// `session/update` notifications published *while the load request is outstanding* — the
    /// load response itself carries only modes and configuration options.
    ///
    /// **So the session is registered before the request is sent, not after.** This is the one
    /// ordering the call depends on, and it is Zed's (`zed-main/crates/agent_servers/src/acp.rs`
    /// `open_or_create_session`: "Register the session before awaiting the RPC so that any
    /// `session/update` notifications that arrive during the call (e.g. history replay during
    /// `session/load`) can find the thread"). Without it `runs::forward_update` sees a
    /// run-scoped update for a session the host does not hold and drops it — silently, and with
    /// the session then appearing to have been restored empty.
    ///
    /// **A load is stamped with a run, and that run ends without a frame.** `forward_update`
    /// attaches turn content to the run a session has in flight, so a slot with `run: None` drops
    /// replayed text exactly as it drops text for a session that is not there. The run id is
    /// minted here and marked finished once the response arrives *and its replay has been drained*
    /// ([`Self::drain_updates`]): an update that arrives after that belongs to no turn this host is
    /// showing and is dropped, which is the same rule a late frame for a cancelled run gets.
    /// **The drain is what makes "after that" a fact rather than a race** — the response and the
    /// notifications that preceded it are handed over on different tasks, and a run closed on the
    /// response alone closes on frames that are still queued. **No ending is emitted** — a load is
    /// not a turn and the contract has no stop reason for one, so the caller learns it finished
    /// from this call's own answer, exactly as `prompt` learns its run id from its return value.
    ///
    /// The registration is rolled back when the engine refuses, so a failed load does not leave
    /// the host holding a session nothing opened.
    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &Path,
    ) -> Result<SessionInfo, SessionError> {
        self.negotiate().await?;
        {
            // Claimed *before* the open check, and released by whichever exit runs, so the two
            // facts cannot be observed apart: a second caller either sees the claim or sees the
            // registered session, never the gap between them in which it would insert its own.
            let mut loading = self.loading.lock().unwrap();
            if self.sessions.lock().unwrap().contains_key(session_id) {
                return Err(SessionError::AlreadyOpen {
                    session_id: session_id.to_string(),
                });
            }
            if !loading.insert(session_id.to_string()) {
                return Err(SessionError::LoadInFlight {
                    session_id: session_id.to_string(),
                });
            }
        }
        // The body is a separate function so that the release below is on the one path out of it:
        // a `?` added inside the body returns to *here*, not past the release. Holding the claim
        // across an await would mean holding a `std::sync::Mutex` guard across it — this is a
        // `HashSet` of session ids, taken and dropped in two synchronous steps, and the await
        // happens in between with the lock released.
        let result = self.adopt_loaded_session(session_id, cwd).await;
        self.loading.lock().unwrap().remove(session_id);
        result
    }

    /// The body of [`Self::load_session`], past the two refusals and holding the claim.
    async fn adopt_loaded_session(
        &self,
        session_id: &str,
        cwd: &Path,
    ) -> Result<SessionInfo, SessionError> {
        // Registered before the request — see this method's own note. The run is minted from the
        // same counter `prompt` uses, so a load and a turn can never share an id.
        let load_run = format!("load-{}", self.run_counter.fetch_add(1, Ordering::Relaxed));
        self.sessions.lock().unwrap().insert(
            session_id.to_string(),
            SessionSlot {
                config_options: Value::Array(Vec::new()),
                run: Some(RunState {
                    run_id: load_run.clone(),
                    cancelled: false,
                    finished: false,
                }),
                vault_root: cwd.to_string_lossy().into_owned(),
            },
        );

        let response = match self
            .connection
            .load_session(SessionId::new(session_id), cwd, LOAD_BOUND)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                // Rolled back, so a refused load leaves no trace: a slot with no answer behind it
                // would make every later command about this id answer as though it were open.
                self.sessions.lock().unwrap().remove(session_id);
                return Err(SessionError::Transport(error));
            }
        };

        // **The response is not the end of the replay.** The engine replays the conversation as
        // ordinary `session/update` notifications while this request is outstanding, and they are
        // handed to the host's own dispatcher to be turned into events — on a task of its own,
        // which this response does not wait for. So at this instant part of the conversation may
        // still be in that queue, and everything below this line is decided as though the load
        // were over: the run is marked finished, and a finished run's frames are dropped by
        // `runs::forward_update` — correctly, because that is what stops a stopped answer from
        // looking alive again.
        //
        // Measured against the fixture with a 200-frame replay written in one piece: 128 frames
        // reached the snapshot a mounting window is given, the other 72 were discarded after this
        // line, and the window's own channel never carried them either
        // (`agent_session_ipc_test.rs`, the burst test). So the load waits for the dispatcher
        // here. The wait is bounded by the frames the engine had already sent, not by the engine:
        // the transport pushes a notification and resolves this response on one task, in that
        // order, so what is queued when this line runs is exactly what the engine said before it
        // answered. A cancelled load takes the same path — `cancel` is a fence for the *run*, and
        // the frames of a load that is still being adopted are not the frames of a turn.
        self.drain_updates().await;

        let config_options = response
            .config_options
            .as_ref()
            .and_then(|options| serde_json::to_value(options).ok())
            .unwrap_or_else(|| Value::Array(Vec::new()));

        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(slot) = sessions.get_mut(session_id) {
                slot.config_options = config_options.clone();
                // Finished, not removed: the slot stays stamped with the load's run so that a
                // replayed update arriving after the response is dropped as belonging to a turn
                // this host is no longer showing. `prompt` treats a finished run as free.
                if let Some(run) = slot.run.as_mut() {
                    if run.run_id == load_run {
                        run.finished = true;
                    }
                }
            }
        }

        // The same two groups `open_session` records, from a load response rather than a new one.
        // The id was pre-registered, so a fact the engine published during the load — a command
        // list, a config change — is already in this entry and is added to rather than replaced.
        {
            let handshake = self.handshake.lock().unwrap().clone();
            let mut reported = self.reported.lock().unwrap();
            let entry = reported.entry(session_id.to_string()).or_default();
            if let Some(handshake) = handshake {
                entry.negotiated(handshake);
            }
            entry.reopened(&response);
        }

        Ok(SessionInfo {
            session_id: session_id.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    fn identity() -> AgentIdentity {
        AgentIdentity {
            agent_id: "opencode".to_string(),
            profile_id: "default".to_string(),
            runtime_epoch: "epoch-1".to_string(),
            vault_id: "vault-1".to_string(),
        }
    }

    fn emit_one(emitter: &Emitter) {
        emitter.emit(
            "ses-1",
            Some("run-0".to_string()),
            AgentEventKind::TextDelta,
            serde_json::json!({ "text": "x" }),
        );
    }

    /// The two statements two other modules are written against, held to the emitter that has to
    /// provide them: `task_projection::vocabulary`'s `FrameOrder::off_stream` ("zero is the sequence
    /// no runtime ever assigns") and `notification_policy`'s `if fact.sequence != 0` (which tells a
    /// host-reported fact from a frame off the stream).
    ///
    /// Both were false: the counter started at 0, so a stream's first frame carried the one number
    /// every other reader uses for "no frame". What that cost is not a label but a frame — an empty
    /// record answers `sequence: 0`, and every delivery path filters with `>` against the caller's
    /// position, so a window that took its snapshot before the first frame had it dropped at the
    /// tail, at the live buffer and at the reducer, with no hole recorded because a hole needs a
    /// position above zero to be seen from. `agent_session_ipc_test`'s
    /// `no_frame_a_runtime_publishes_carries_the_sequence_that_means_no_frame` is the same claim
    /// over the real runtime; this is the same claim over the emitter alone.
    #[test]
    fn the_first_frame_a_stream_publishes_is_not_the_sequence_that_means_no_frame() {
        let (emitter, mut incoming) = Emitter::new(identity());
        emit_one(&emitter);
        let first = incoming.try_recv().expect("the frame is published");
        assert_eq!(
            first.sequence, FIRST_SEQUENCE,
            "a stream starts at {FIRST_SEQUENCE}, so that 0 keeps meaning \"nothing published\""
        );
        assert_ne!(
            first.sequence, 0,
            "a frame carrying 0 is a frame every reader of the sequence discards as not one"
        );
    }

    /// The numbering and the queue order are one order.
    ///
    /// Three producers emit on this path and they run on different tasks, so a counter that is
    /// incremented separately from the send hands the queue `n + 1` before `n` whenever two of them
    /// are in flight at once. Nothing downstream can repair that: a consumer reads a frame at or
    /// below its position as a replay and drops it, and the hole is not recorded — the window's
    /// reducer only reports a gap for a frame *above* its position, so the late frame's absence is
    /// indistinguishable from a frame that never existed. This is the test that fails when the two
    /// steps are separate again, and it fails on the ordering rather than on a timeout because the
    /// threads are joined before the queue is read.
    #[test]
    fn concurrent_emitters_queue_frames_in_the_order_they_numbered_them() {
        const THREADS: usize = 8;
        const EACH: usize = 20_000;
        let (emitter, mut incoming) = Emitter::new(identity());
        let start = Arc::new(Barrier::new(THREADS));
        std::thread::scope(|scope| {
            for _ in 0..THREADS {
                let emitter = emitter.clone();
                let start = Arc::clone(&start);
                scope.spawn(move || {
                    // Released together: every producer is inside `emit` at the same time, which is
                    // the condition the numbering has to survive.
                    start.wait();
                    for _ in 0..EACH {
                        emit_one(&emitter);
                    }
                });
            }
        });

        let mut published = Vec::new();
        while let Ok(envelope) = incoming.try_recv() {
            published.push(envelope.sequence);
        }
        let total = (THREADS * EACH) as u64;
        assert_eq!(
            published.len() as u64,
            total,
            "every frame reached the queue"
        );
        let expected: Vec<u64> = (FIRST_SEQUENCE..FIRST_SEQUENCE + total).collect();
        if let Some(index) = published
            .iter()
            .zip(&expected)
            .position(|(queued, number)| queued != number)
        {
            let from = index.saturating_sub(4);
            panic!(
                "the queue is not in the order the numbers were handed out: at position {index} it \
                 holds {:?} where it should hold {:?} — a consumer drops the late frame as a replay \
                 and records no hole for it",
                &published[from..(index + 4).min(published.len())],
                &expected[from..(index + 4).min(expected.len())],
            );
        }
    }
}
