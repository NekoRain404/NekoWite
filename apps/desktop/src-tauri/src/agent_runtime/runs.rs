//! Runs: one generation inside a session, and the one ending it is allowed.
//!
//! Kept apart from [`super::session`] because the two answer different
//! questions. A session is an identity the host either knows or does not; a run
//! is a piece of work that can be stopped, and stopping it races the engine's
//! own answer by construction.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::schema::v1::{SessionId, SessionNotification};
use serde_json::{Value, json};

use super::events::{AgentEventKind, normalize_update};
use super::fs_capability::{FsCapability, FsRequest};
use super::session::{AgentRuntime, Emitter, RunState, SessionError, SessionSlot};

/// A generation gets its own, much longer bound than any control call, and §6.2
/// asks for that separation by name: one short timer for everything kills a
/// long answer that was working perfectly well. This is a net for a wedged
/// engine, not a budget for the answer.
const PROMPT_BOUND: Duration = Duration::from_secs(30 * 60);

impl AgentRuntime {
    /// Starts a generation and returns the host's run id for it.
    ///
    /// The answer arrives as events, not as this call's result: the run
    /// outlives it, and what this returns is only the host's name for the work
    /// that is now under way.
    pub fn prompt(&self, session_id: &str, text: &str) -> Result<String, SessionError> {
        let run_id = format!("run-{}", self.run_counter.fetch_add(1, Ordering::Relaxed));
        {
            let mut sessions = self.sessions.lock().unwrap();
            let slot = sessions
                .get_mut(session_id)
                .ok_or_else(|| SessionError::UnknownSession {
                    session_id: session_id.to_string(),
                })?;
            if slot.run.as_ref().is_some_and(|run| !run.finished) {
                return Err(SessionError::RunInProgress {
                    session_id: session_id.to_string(),
                });
            }
            slot.run = Some(RunState {
                run_id: run_id.clone(),
                cancelled: false,
                finished: false,
            });
        }

        let connection = std::sync::Arc::clone(&self.connection);
        let sessions = std::sync::Arc::clone(&self.sessions);
        let emitter = self.emitter.clone();
        let session = session_id.to_string();
        let run = run_id.clone();
        let text = text.to_string();

        // The prompt is awaited on its own task: the engine answers when the
        // generation is over, which may be minutes after this returns, and a
        // caller (a Tauri command) cannot be left holding that.
        tokio::spawn(async move {
            let ended = match connection
                .prompt(SessionId::new(session.as_str()), &text, PROMPT_BOUND)
                .await
            {
                // The stop reason and the usage arrive with the result (P0
                // §2.3), so they are the one part of an answer the host does not
                // have to infer. The usage is serialized as the engine sent it:
                // P0 §6.3 measured the field set changing between calls
                // (`thoughtTokens` in one, `cachedReadTokens` in another, and
                // `totalTokens` not the sum either time), so a struct with
                // defaults would invent numbers the UI must leave blank.
                Ok(response) => (
                    AgentEventKind::RunFinished,
                    json!({ "stopReason": response.stop_reason, "usage": response.usage }),
                ),
                Err(error) => (
                    AgentEventKind::RunFailed,
                    json!({ "code": error.failure_code(), "message": error.failure_message() }),
                ),
            };
            // A cancelled run has already ended, and the failure the engine
            // answers a cancel with must not be reported as a second, spurious
            // failure.
            finish_run(&sessions, &emitter, &session, &run, ended.0, ended.1);
        });

        Ok(run_id)
    }

    /// Stops the generation that is running on `session_id`.
    ///
    /// Cancelling a session with nothing running is a no-op rather than an
    /// error: the UI's Stop button can be pressed in the same instant the
    /// answer lands, and reporting that race as a failure would be reporting
    /// the user's own click as a fault.
    pub async fn cancel(&self, session_id: &str) -> Result<(), SessionError> {
        let run_id = {
            let mut sessions = self.sessions.lock().unwrap();
            let slot = sessions
                .get_mut(session_id)
                .ok_or_else(|| SessionError::UnknownSession {
                    session_id: session_id.to_string(),
                })?;
            match slot.run.as_mut() {
                None => return Ok(()),
                Some(run) if run.finished => return Ok(()),
                Some(run) => {
                    // Marked before the engine is told, so a chunk already on
                    // its way is dropped by the dispatcher instead of arriving
                    // after the host announced that the run had stopped.
                    run.cancelled = true;
                    run.run_id.clone()
                }
            }
        };

        let cancelled = self.connection.cancel(SessionId::new(session_id));
        // The run ends for the host either way. If the cancel could not even be
        // sent the connection is dead, and leaving the session marked as
        // running would refuse every future prompt on it.
        finish_run(
            &self.sessions,
            &self.emitter,
            session_id,
            &run_id,
            AgentEventKind::RunFinished,
            json!({ "stopReason": "cancelled", "usage": Value::Null }),
        );
        cancelled.map_err(SessionError::Transport)
    }
}

/// Ends a run exactly once, and emits that ending.
///
/// Cancellation and the engine's own answer race here by construction: the
/// engine may still send `stopReason` for a run the user cancelled a moment
/// ago. Only the first of the two may produce the envelope the UI closes the
/// run on — a second `run-finished` would move the session out of a state it
/// has already left. Returns whether this call was the one that ended it.
fn finish_run(
    sessions: &Mutex<HashMap<String, SessionSlot>>,
    emitter: &Emitter,
    session_id: &str,
    run_id: &str,
    kind: AgentEventKind,
    payload: Value,
) -> bool {
    {
        let mut sessions = sessions.lock().unwrap();
        let Some(run) = sessions.get_mut(session_id).and_then(|slot| slot.run.as_mut()) else {
            return false;
        };
        // The run id check is not decoration: a late answer for a previous run
        // on the same session must not close the run that replaced it.
        if run.finished || run.run_id != run_id {
            return false;
        }
        run.finished = true;
    }
    emitter.emit(session_id, Some(run_id.to_string()), kind, payload);
    true
}

/// Turns the engine's updates into host envelopes, one at a time and in order.
pub(super) async fn dispatch_updates(
    mut updates: tokio::sync::mpsc::UnboundedReceiver<SessionNotification>,
    sessions: std::sync::Arc<Mutex<HashMap<String, SessionSlot>>>,
    emitter: Emitter,
) {
    while let Some(notification) = updates.recv().await {
        forward_update(&sessions, &emitter, &notification);
    }
}

/// Turns one `session/update` into a host envelope — or does not.
fn forward_update(
    sessions: &Mutex<HashMap<String, SessionSlot>>,
    emitter: &Emitter,
    notification: &SessionNotification,
) {
    // `None` is the deliberate drop documented in `events` — a thought chunk,
    // or an update this host has no kind for. Neither reaches a component as an
    // unknown.
    let Some((kind, payload)) = normalize_update(&notification.update) else {
        return;
    };
    let session_id = notification.session_id.to_string();

    let run_id = {
        let sessions = sessions.lock().unwrap();
        let run = sessions.get(&session_id).and_then(|slot| slot.run.as_ref());
        match run {
            // A cancelled or completed run is over. The engine is free to keep
            // sending chunks for it — a cancel is a request, not a fence — and
            // forwarding them would make a stopped answer look alive again,
            // which §6.2 rules out in as many words.
            Some(run) if run.cancelled || run.finished => return,
            Some(run) => Some(run.run_id.clone()),
            // Session-scoped rather than run-scoped (P0 §2.2 measured the
            // command list arriving this way), and not gated on the host having
            // finished registering the session: the engine sends it the instant
            // `session/new` returns, which can be before that insert happens.
            // Requiring registration here would drop it on an ordering that is
            // the normal one, not an exceptional one.
            None if kind == AgentEventKind::CommandsChanged => None,
            // A run-scoped update with no run to belong to: either the session
            // is one this host never opened, or its run never started. §6.1
            // forbids stamping a session id this host never received, and text
            // that belongs to no run cannot be placed in the timeline at all.
            None => return,
        }
    };

    emitter.emit(&session_id, run_id, kind, payload);
}

/// How long a file request may wait for the session it names to be registered.
///
/// The engine is entitled to use a session the moment it receives our
/// `session/new` response — and that response reaches it from the SDK's reader
/// on a different path from the task that registers the session, so a request
/// can legitimately arrive inside that window (measured: it does, against the
/// fixture). Waiting briefly is what separates the two cases the host cannot
/// otherwise tell apart at that instant: a session that is about to appear, and
/// an id that was never ours. The bound is what keeps the second case a refusal
/// rather than a hang.
const REGISTRATION_WINDOW: std::time::Duration = std::time::Duration::from_millis(250);

/// Serves the engine's file requests, one at a time.
///
/// The session is resolved before anything is touched: the id in the request is
/// the engine's assertion, and a path is only confined relative to a root this
/// host chose, so an id with no session behind it is refused rather than guessed
/// at. Serving is serialized by the loop, which is also what keeps two agent
/// writes from interleaving their baselines.
pub(super) async fn dispatch_fs(
    mut requests: tokio::sync::mpsc::UnboundedReceiver<FsRequest>,
    sessions: std::sync::Arc<Mutex<HashMap<String, SessionSlot>>>,
    capability: std::sync::Arc<FsCapability>,
) {
    while let Some(request) = requests.recv().await {
        let session_id = request.session_id().to_string();
        let deadline = tokio::time::Instant::now() + REGISTRATION_WINDOW;
        let root = loop {
            let known = sessions
                .lock()
                .unwrap()
                .get(&session_id)
                .map(|slot| slot.vault_root.clone());
            if known.is_some() || tokio::time::Instant::now() >= deadline {
                break known;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        capability.serve(request, root.as_deref()).await;
    }
}
