//! The ACP connection to the engine.
//!
//! This is deliberately thin. Framing, JSON-RPC, request/response correlation,
//! the schema types and the process lifecycle all come from
//! `agent-client-protocol` 2.1.0 — the same crate, at the same pinned version,
//! that Zed uses — so what is left here is the wiring: build the client, point
//! it at the engine, and bridge what it hands back into this crate's channels.
//! Hand-rolling any of that would duplicate a maintained library and make us
//! less like Zed, not more.
//!
//! Two things the SDK does not do, and this module therefore does:
//!
//! - **Timeouts.** There is no timeout anywhere in the SDK's request path; a
//!   prompt against a wedged engine waits forever. Every call here carries its
//!   own bound, chosen per call because §6.2 requires the handshake and a long
//!   generation not to share one timer.
//! - **Classification.** An engine failure arrives as an opaque error, and P0
//!   §2.4 requires the certificate condition to be recognised and reworded
//!   rather than passed through.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, InitializeRequest, InitializeResponse, NewSessionRequest,
    NewSessionResponse, PromptRequest, RequestPermissionRequest, ReadTextFileRequest,
    ReadTextFileResponse, RequestPermissionResponse, SessionConfigValueId, SessionId,
    SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, TextContent,
    WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::{
    AcpAgent, Agent, ByteStreams, Client, ConnectionTo, JsonRpcRequest, Responder, UntypedMessage,
    on_receive_notification, on_receive_request,
};
use tokio::sync::{mpsc, oneshot};

use super::events::{TransportError, classify};
use super::fs_capability::{self, FsRequest};
use super::process::{
    BoundedFrameReader, EngineLaunch, FRAME_TOO_LARGE_MARKER, MAX_FRAME_BYTES, SHUTDOWN_GRACE,
    StderrLog, pump_stderr, secrets_of, signal_group,
};
use super::usage::{self, PromptEnding};

/// An engine→client request waiting for an answer.
///
/// ACP asks the client for permission and the engine blocks until it is
/// answered, so §6.2 is explicit that backpressure may coalesce text but must
/// never lose one of these. Handing the `Responder` on rather than answering
/// here keeps the decision — and the option ids, which are the engine's to
/// define (§6.3) — with the layer that owns it (T3).
pub struct PermissionRequest {
    pub request: RequestPermissionRequest,
    pub responder: Responder<RequestPermissionResponse>,
}

/// A live ACP connection to one engine process.
pub struct EngineConnection {
    connection: ConnectionTo<Agent>,
    /// Two senders, dropped together. The first ends the connection task,
    /// which drops the transport — and with it the child's stdin, so the
    /// engine sees EOF. The second hands the child to the supervisor, which
    /// applies §6.2's sequence: a bounded wait for the engine to exit on its
    /// own, then `SIGTERM` to the group, then `SIGKILL`.
    stop: Mutex<Option<(oneshot::Sender<()>, oneshot::Sender<()>)>>,
    /// Why the bounded reader stopped reading, when it was the bound.
    trip: std::sync::Arc<Mutex<Option<String>>>,
}

/// What the engine says, as opposed to what it is asked.
///
/// Split from the handle because reading needs `&mut` and asking does not, and
/// the task that reads must not be the same object every caller of `prompt`
/// has to borrow.
pub struct EngineEvents {
    pub updates: mpsc::UnboundedReceiver<SessionNotification>,
    pub permissions: mpsc::UnboundedReceiver<PermissionRequest>,
    /// The engine's `fs/*` requests, waiting to be served against a vault.
    pub fs: mpsc::UnboundedReceiver<FsRequest>,
}

impl EngineConnection {
    /// Spawns the engine and completes its side of the ACP handshake.
    ///
    /// Must be called from a Tokio runtime: the connection runs as a task, and
    /// it has to outlive this call — the ACP connection is live for as long as
    /// the engine is, not for the duration of one request.
    pub async fn connect(
        launch: &EngineLaunch,
    ) -> Result<(EngineConnection, EngineEvents), TransportError> {
        let (updates_tx, updates) = mpsc::unbounded_channel();
        let (permissions_tx, permissions) = mpsc::unbounded_channel();
        let (fs_tx, fs) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let (stop, stop_rx) = oneshot::channel();
        let (child_stop, child_stop_rx) = oneshot::channel();

        // The SDK's own spawn, used through its documented escape hatch. Spawn
        // and `process_group(0)` stay the SDK's, including its reasoning about
        // `npx`/`uvx` wrappers.
        //
        // The hatch is needed because §6.2's size bound cannot be applied to a
        // connection the SDK wires internally: `AcpAgent`'s own `connect_to`
        // builds the line streams inside itself and hands out no seam, and its
        // line splitter has no maximum. So the pipes are taken here, stdout is
        // wrapped in a bounded adapter, and the SDK still does the framing,
        // JSON-RPC and dispatch on top.
        let agent = AcpAgent::new(launch.agent_config());
        let (stdin, stdout, stderr, mut child) = agent.spawn_process().map_err(|error| {
            TransportError::Disconnected {
                detail: error.to_string(),
            }
        })?;

        // stderr must always be drained: a full pipe blocks the engine on its
        // own logging. It is bounded and redacted on the way in.
        tokio::spawn(pump_stderr(
            stderr,
            std::sync::Arc::new(Mutex::new(StderrLog::default())),
            secrets_of(launch),
        ));

        // The child's own supervisor. It owns the child, so nothing here has to
        // name the SDK's stream types, and it is what makes teardown §6.2's
        // sequence rather than an immediate kill.
        let pgid = child.id() as i32;
        tokio::spawn(async move {
            // A dropped sender means "shut down" either way: the runtime asks,
            // or the runtime is gone.
            let _ = child_stop_rx.await;
            // Bounded wait for a normal exit first — the engine has just seen
            // stdin EOF and may be finishing a write it started.
            if tokio::time::timeout(SHUTDOWN_GRACE, child.status()).await.is_err() {
                // Gone means gone: a failed signal is not reported on its own,
                // because the only failure that matters is the child still
                // running, and the next wait establishes that.
                let _ = signal_group(pgid, "-TERM");
                if tokio::time::timeout(SHUTDOWN_GRACE, child.status()).await.is_err() {
                    let _ = signal_group(pgid, "-KILL");
                    // Reap it, so the pid is not left as a zombie.
                    let _ = child.status().await;
                }
            }
        });

        let trip = std::sync::Arc::new(Mutex::new(None));
        let frames = ByteStreams::new(
            stdin,
            BoundedFrameReader::new(stdout, MAX_FRAME_BYTES, std::sync::Arc::clone(&trip)),
        );
        let mut task = Some(tokio::spawn(async move {
            // One sender per handler: each closure captures its own, and the
            // originals stay alive here so the receiver does not end while the
            // connection is still open.
            let fs_writes = fs_tx.clone();
            let fs_reads = fs_tx;

            Client
                .builder()
                .name("nekowite")
                .on_receive_notification(
                    async move |notification: SessionNotification, _cx| {
                        // A send that fails means the runtime is gone; the
                        // handler still has to answer the dispatch loop.
                        let _ = updates_tx.send(notification);
                        Ok(())
                    },
                    on_receive_notification!(),
                )
                .on_receive_request(
                    async move |request: RequestPermissionRequest,
                                responder: Responder<RequestPermissionResponse>,
                                _cx| {
                        let _ = permissions_tx.send(PermissionRequest { request, responder });
                        Ok(())
                    },
                    on_receive_request!(),
                )
                // P0 §7.2: the engine asks the HOST to perform a write. The
                // handler only forwards — the work happens on the runtime's own
                // task, because completing it here would run a blocking fsync
                // inside the SDK's dispatch loop and stop the connection from
                // answering anything else.
                .on_receive_request(
                    async move |request: WriteTextFileRequest,
                                responder: Responder<WriteTextFileResponse>,
                                _cx| {
                        let _ = fs_writes.send(FsRequest::Write { request, responder });
                        Ok(())
                    },
                    on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: ReadTextFileRequest,
                                responder: Responder<ReadTextFileResponse>,
                                _cx| {
                        let _ = fs_reads.send(FsRequest::Read { request, responder });
                        Ok(())
                    },
                    on_receive_request!(),
                )
                .connect_with(frames, move |cx: ConnectionTo<Agent>| {
                    async move {
                        // Hand the connection to the runtime before settling in,
                        // so no request can be issued before there is one.
                        let _ = ready_tx.send(cx);
                        // Hold the connection open until the runtime says stop:
                        // `connect_with` returns when this returns, and the
                        // session only lives as long as the connection does.
                        let _ = stop_rx.await;
                        Ok(())
                    }
                })
                .await
        }));

        let connection = match ready_rx.await {
            Ok(connection) => connection,
            Err(_) => {
                // The connection died before it was usable. The task holds the
                // reason — a missing binary, a handshake the engine refused —
                // and that reason is the whole value of this error.
                let detail = match task.take() {
                    Some(handle) => match handle.await {
                        Ok(Ok(())) => "the connection closed before it was established".to_string(),
                        Ok(Err(error)) => classify(error).failure_message(),
                        Err(error) => error.to_string(),
                    },
                    None => "the connection could not be established".to_string(),
                };
                return Err(TransportError::Disconnected { detail });
            }
        };

        Ok((
            EngineConnection {
                connection,
                stop: Mutex::new(Some((stop, child_stop))),
                trip,
            },
            EngineEvents {
                updates,
                permissions,
                fs,
            },
        ))
    }

    /// Negotiates the protocol.
    ///
    /// The version is checked here as well as by the SDK's own guard: a version
    /// this host does not implement must fail as `protocol-incompatible` at the
    /// handshake, or every later call fails in a way that reads as an engine
    /// bug.
    pub async fn initialize(&self, bound: Duration) -> Result<InitializeResponse, TransportError> {
        // The capability is declared here and nowhere else. P0 §7.2 measured the
        // engine sending `fs/write_text_file` even under an empty capability
        // set; advertising it is what makes a *delegated* write one this host
        // performs, through the app's own write path. It is not exclusivity: P0
        // §7's default-configuration probe measured the same engine writing a
        // file through its own tools with zero reverse requests, so what arrives
        // here is a write the engine handed over, not a gate every write must pass.
        let initialize =
            InitializeRequest::new(ProtocolVersion::V1).client_capabilities(fs_capability::client_capabilities());
        let response = self.request("initialize", initialize, bound).await?;
        if response.protocol_version != ProtocolVersion::V1 {
            return Err(TransportError::ProtocolIncompatible {
                found: response.protocol_version.as_u16(),
            });
        }
        Ok(response)
    }

    /// Opens a session in `cwd`.
    pub async fn new_session(
        &self,
        cwd: &Path,
        bound: Duration,
    ) -> Result<NewSessionResponse, TransportError> {
        self.request("session/new", NewSessionRequest::new(cwd.to_path_buf()), bound)
            .await
    }

    /// Selects one of the engine's own options on a session.
    pub async fn set_config_option(
        &self,
        session_id: SessionId,
        config_id: String,
        value: String,
        bound: Duration,
    ) -> Result<SetSessionConfigOptionResponse, TransportError> {
        // The value is wrapped as the engine's own option id rather than as a
        // bare string, because the option may be a boolean or a group id: the
        // type is what keeps a caller from sending a shape the engine's list
        // never offered.
        let request = SetSessionConfigOptionRequest::new(
            session_id,
            config_id,
            SessionConfigValueId::new(value),
        );
        self.request("session/set_config_option", request, bound).await
    }

    /// Starts a generation. The answer arrives as updates and finally as this
    /// ending, which carries the stop reason and the usage.
    ///
    /// The request is sent untyped — `UntypedMessage` carries the SDK's own
    /// [`PromptRequest`] as its params, so the engine sees the frame it always
    /// saw — and the response is read by [`usage::ending`] rather than by the
    /// SDK's router, for two reasons that are one measurement: `PromptResponse`
    /// holds usage as `Option<Usage>`, `Usage` requires `totalTokens`,
    /// `inputTokens` and `outputTokens` as non-optional `u64`s, and P0 §6.3
    /// measured the engine omitting one of them; and its `stopReason` is the
    /// pinned schema's five variants with no arm for a sixth, which §6.3's
    /// moving protocol surface makes a frame to read rather than to refuse.
    /// Nothing else about the response changes: a frame that reader will not
    /// read fails through `classify` exactly as the SDK's router would have
    /// failed it.
    pub async fn prompt(
        &self,
        session_id: SessionId,
        text: &str,
        bound: Duration,
    ) -> Result<PromptEnding, TransportError> {
        let prompt = vec![ContentBlock::Text(TextContent::new(text))];
        let request = UntypedMessage::new("session/prompt", PromptRequest::new(session_id, prompt))
            .map_err(classify)?;
        // The method the request itself carries, so the timeout this call may
        // report names the same call the engine was sent.
        let method = request.method().to_string();
        let raw: serde_json::Value = self.request(&method, request, bound).await?;

        usage::ending(&method, &raw).map_err(classify)
    }

    /// Asks the engine to stop the generation running on a session.
    ///
    /// A notification, not a request: the engine does not answer it, and the
    /// run ends when the prompt call itself returns.
    pub fn cancel(&self, session_id: SessionId) -> Result<(), TransportError> {
        self.connection
            .send_notification(CancelNotification::new(session_id))
            .map_err(classify)
    }

    /// Ends the connection, and with it the engine and its process group.
    ///
    /// The sequence is §6.2's 「先正常取消/退出再限时终止」, and each step is
    /// observable rather than assumed:
    ///
    /// 1. dropping the sender returns from `connect_with`, which drops the
    ///    transport and closes the child's stdin — the engine sees EOF;
    /// 2. the supervisor waits `SHUTDOWN_GRACE` for the engine to exit on its
    ///    own, so a process mid-write is not cut off;
    /// 3. only then `SIGTERM` to the group, then `SIGKILL` after a second
    ///    bounded wait, then a reap.
    ///
    /// Cancelling live *sessions* before this is the session layer's half of
    /// "stop it properly" (`AgentRuntime::shutdown` does it); this is the
    /// process half.
    pub fn shutdown(&self) {
        // Both senders go at once: the connection closes and the supervisor
        // starts counting, so the grace window is the engine's, not ours.
        self.stop.lock().unwrap().take();
    }

    async fn request<Req>(
        &self,
        method: &str,
        request: Req,
        bound: Duration,
    ) -> Result<Req::Response, TransportError>
    where
        Req: JsonRpcRequest,
        Req::Response: Send,
    {
        let pending = self.connection.send_request(request);
        // The SDK has no timeout of its own, so the bound is applied here. A
        // cancelled `block_task` leaves the request outstanding; the SDK's
        // router discards an answer that arrives for it afterwards.
        match tokio::time::timeout(bound, pending.block_task()).await {
            Ok(Ok(response)) => Ok(response),
            // The bound reports through the closed connection, so its own
            // reason is preferred over whatever the closure looked like.
            Ok(Err(error)) => Err(self.trip_reason().unwrap_or_else(|| classify(error))),
            Err(_) => Err(TransportError::Timeout {
                method: method.to_string(),
            }),
        }
    }

    /// The bound's own account of why the connection stopped, if it was.
    ///
    /// Without this the caller sees only that the transport closed, which
    /// reads as a crash; the reader is the one component that knows a frame
    /// grew past the limit, so it leaves the reason here on its way out.
    fn trip_reason(&self) -> Option<TransportError> {
        self.trip
            .lock()
            .unwrap()
            .clone()
            .map(|message| TransportError::Engine { message })
    }
}
