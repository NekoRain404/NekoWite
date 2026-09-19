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
//! The connection's lifetime is here; the calls made over it are not. `acp_transport/calls.rs`
//! holds `initialize`, `session/new`, `session/set_config_option`, `session/prompt`,
//! `session/cancel` and the bounded `request` they all go through, because a call's rule is
//! "never wait forever and fail classified" while a connection's is "outlive every call and never
//! block the dispatch loop" — two rules that move for different reasons and neither of which can
//! be stated in the other's terms.
//!

use std::sync::Mutex;

use agent_client_protocol::schema::v1::{
    ReadTextFileRequest, ReadTextFileResponse, RequestPermissionRequest, RequestPermissionResponse,
    SessionNotification, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::{
    on_receive_notification, on_receive_request, AcpAgent, Agent, ByteStreams, Client,
    ConnectionTo, Responder,
};
use tokio::sync::{mpsc, oneshot};

use super::events::{classify, TransportError};
use super::fs_capability::FsRequest;
use super::process::{
    secrets_of, signal_group, BoundedFrameReader, EngineLaunch, EngineStderr, MAX_FRAME_BYTES,
    SHUTDOWN_GRACE,
};

// Declared by path rather than by name, for the reason `agent_runtime/skills.rs` gives about its
// three children: this file is reached two ways — normally from `agent_runtime/mod.rs`, and by
// test targets that hand-declare the tree through a `#[path]` include — and a `#[path]`-included
// file looks for its children in its own directory rather than in a subdirectory named after it.
// An explicit path resolves to the same file under both, which is what keeps every such target
// compiled against exactly the tree the library builds.
#[path = "acp_transport/calls.rs"]
mod calls;

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
    /// The engine's stderr, drained and redacted by the pump task — the same log, not
    /// a copy of it, and the signal that says the pipe has ended.
    ///
    /// Held on the connection so that a *later* failure can quote it: an engine that
    /// dies mid-run leaves "the connection closed" and nothing else, and its own last
    /// lines are the only account of why. It is read through
    /// [`EngineConnection::with_engine_stderr`], which is the one place it becomes
    /// text.
    stderr: EngineStderr,
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
        let (stdin, stdout, stderr, mut child) =
            agent
                .spawn_process()
                .map_err(|error| TransportError::Disconnected {
                    detail: error.to_string(),
                })?;

        // stderr must always be drained: a full pipe blocks the engine on its
        // own logging. It is bounded and redacted on the way in.
        //
        // **The handle comes back from the spawn, and it is what a failure reads.**
        // A log that exists only as an argument to `tokio::spawn` is one no failure can
        // read: written, bounded, redacted, and then dropped with the task that filled
        // it — which is exactly the state this line was in until a start failure had a
        // reader. `EngineStderr` carries the same log the pump writes *and* the pump's
        // end of the pipe, so the failures `with_engine_stderr` attaches this to can
        // wait for the pump to finish rather than sampling it.
        let stderr = EngineStderr::drain(stderr, secrets_of(launch));

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
            if tokio::time::timeout(SHUTDOWN_GRACE, child.status())
                .await
                .is_err()
            {
                // Gone means gone: a failed signal is not reported on its own,
                // because the only failure that matters is the child still
                // running, and the next wait establishes that.
                let _ = signal_group(pgid, "-TERM");
                if tokio::time::timeout(SHUTDOWN_GRACE, child.status())
                    .await
                    .is_err()
                {
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
                return Err(TransportError::Disconnected {
                    detail: with_stderr_tail(detail, &stderr).await,
                });
            }
        };

        Ok((
            EngineConnection {
                connection,
                stop: Mutex::new(Some((stop, child_stop))),
                trip,
                stderr,
            },
            EngineEvents {
                updates,
                permissions,
                fs,
            },
        ))
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

    /// The failure with the engine's own account of itself attached — where that is
    /// the engine's account to give.
    ///
    /// Only [`TransportError::Disconnected`] is touched, and the reason is the
    /// condition rather than the wording: it is the arm that means *the engine is
    /// gone*, so its stderr is the last thing anyone will hear from it and there will
    /// be no second chance to quote it. [`TransportError::Timeout`] can arrive from an
    /// engine that is alive and healthy — a long prompt that outgrew its bound has
    /// logging behind it that explains nothing — and [`TransportError::Engine`] is
    /// already the engine's own answer, said in its own words.
    ///
    /// It waits for the engine's end of stderr to close before it reads — see
    /// [`with_stderr_tail`] — so what it attaches is the engine's last line rather than
    /// whatever the pump had stored when the failure was noticed.
    async fn with_engine_stderr(&self, error: TransportError) -> TransportError {
        match error {
            TransportError::Disconnected { detail } => TransportError::Disconnected {
                detail: with_stderr_tail(detail, &self.stderr).await,
            },
            other => other,
        }
    }
}

/// `detail` with the engine's own last words appended, when there are any to show.
///
/// The text comes out of [`super::process::StderrLog`] and nowhere else, so everything
/// shown here has already passed through `redact` on its way in: this is a reader of the
/// log, never a second path to the pipe, and there is no route by which raw engine output
/// could reach a sentence a person reads.
///
/// **What the reading is.** [`EngineStderr::tail`] waits for the pump to reach the end
/// of the engine's stderr before it reads the log, and that is what turns this from a
/// sample into the engine's last line. The engine's death closes its end of the pipe, so
/// the pump's work is finished at the moment the engine is — everything written before
/// that close is in the buffer and is read before EOF — and a failure that arrives after
/// the engine is gone waits for a task that is already finishing rather than for a
/// delay. An engine that is alive but no longer answering keeps stderr open, which is
/// why that wait is bounded rather than absolute: see
/// [`super::process::STDERR_EOF_BOUND`].
async fn with_stderr_tail(detail: String, stderr: &EngineStderr) -> String {
    match stderr.tail().await {
        Some(tail) => format!("{detail}\n\n{tail}"),
        None => detail,
    }
}
