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

use agent_client_protocol::schema::v1::{SessionId, SessionNotification, SessionUpdate};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::capabilities::SessionCapabilities;
use super::events::{normalize_update, AgentEventKind};
use super::fs_capability::{FsCapability, FsRequest};
use super::session::{AgentRuntime, Emitter, RunState, SessionError, SessionSlot};
use super::usage::PromptStopReason;

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
            let slot =
                sessions
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
                    json!({
                        "stopReason": wire_stop_reason(&response.stop_reason),
                        "usage": response.usage,
                    }),
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
            let slot =
                sessions
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
            // The contract's spelling, which for this one reason is also the engine's: the two
            // agree here, so a cancelled run reads the same whether it was normalized above or
            // written by this host on the user's behalf.
            json!({ "stopReason": "cancelled", "usage": Value::Null }),
        );
        cancelled.map_err(SessionError::Transport)
    }
}

/// The engine's stop reason, in the one spelling that crosses the wire.
///
/// The SDK's `StopReason` is `snake_case` (`end_turn`, `max_turn_requests`) and D1's frozen
/// contract spells the same five reasons `kebab-case` (`agent-contracts/payloads.ts`, which is what
/// its validator accepts and what the window's reducer reads). Both spellings would then be live on
/// this side of the boundary, so every Rust reader of a `run-finished` frame would have to know
/// both — which is how `task_projection::outcomes` came to accept either, a tolerance that was a
/// second way to say one fact and therefore a second place to get it wrong. Publishing the
/// contract's spelling here is what leaves one spelling to know.
///
/// Mechanical rather than a `match`, for the reason `frames.ts` gives about the same value: a table
/// here would be a second copy of the protocol's enum, and a sixth reason would silently fall out
/// of it. The replacement is total — the protocol's names separate words with `_` and use no other
/// ones — and the same replacement is applied to a reason this host does not know, so that the wire
/// carries one spelling whatever the engine sent.
///
/// An unfamiliar reason is published as **the engine's own word**, never as a name this host
/// invented and never as `unrecognised`: the contract's `readEnding` reads a non-empty string its
/// list does not hold as an ending this version does not know, keeping that word in
/// `unrecognisedReason`, so the two halves agree by the contract's own reading rather than by this
/// side borrowing the contract's word for it (`payloads.ts`, `AGENT_STOP_REASONS`'s doc says why
/// the spelling is deliberately not in the wire's list). No variant is faked in either direction:
/// this side reports what the engine said.
fn wire_stop_reason(reason: &PromptStopReason) -> Value {
    match reason {
        PromptStopReason::Known(reason) => match serde_json::to_value(reason) {
            Ok(Value::String(name)) => Value::String(name.replace('_', "-")),
            // Not reachable for the schema's unit enum. Deliberately not repaired either: a value
            // that is not a name is passed through rather than replaced by one the engine never
            // sent.
            Ok(other) => other,
            Err(_) => Value::Null,
        },
        PromptStopReason::Unrecognised(word) => Value::String(word.replace('_', "-")),
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
        let Some(run) = sessions
            .get_mut(session_id)
            .and_then(|slot| slot.run.as_mut())
        else {
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
///
/// `reported` is the runtime's capability store, reached directly rather than through
/// [`AgentRuntime`] because this task is spawned *by* that runtime's constructor — the map is the
/// one thing that exists before the runtime does. It is the same map [`AgentRuntime::capabilities`]
/// answers from, so what is recorded here is what a report reads.
///
/// `drains` is the load path's half of §6.2's "the engine replays the session while the call is
/// outstanding": it is the one way a caller can ask this task to finish what the engine has
/// already sent before it draws a line under its own request. See the barrier in the loop below.
pub(super) async fn dispatch_updates(
    mut updates: tokio::sync::mpsc::UnboundedReceiver<SessionNotification>,
    mut drains: tokio::sync::mpsc::UnboundedReceiver<oneshot::Sender<()>>,
    sessions: std::sync::Arc<Mutex<HashMap<String, SessionSlot>>>,
    reported: std::sync::Arc<Mutex<HashMap<String, SessionCapabilities>>>,
    emitter: Emitter,
) {
    // Once the runtime is gone, no drain can be asked for; the arm is dropped rather than left
    // to answer `None` on every turn, which would be a busy loop between the runtime's death and
    // the transport's.
    let mut drains_open = true;
    loop {
        tokio::select! {
            update = updates.recv() => match update {
                Some(notification) => forward_update(&sessions, &reported, &emitter, &notification),
                // The connection is over. There is nothing left to forward and nothing that
                // could ask for a drain.
                None => break,
            },
            drain = drains.recv(), if drains_open => match drain {
                Some(answered) => {
                    // **The barrier a `session/load` ends on.** Every notification the transport
                    // had already handed over is in the queue below — its handler pushes and the
                    // response resolves on one task, in that order — so draining what is queued
                    // here is what makes "the load is over" a statement about frames that have
                    // been published rather than a race with a task that has not run yet.
                    //
                    // Without it the load's response closes its run while its own replay is still
                    // queued, and `forward_update`'s guard — correctly, for a turn — discards
                    // every frame behind it. Measured: 128 of a 200-frame replay reached the
                    // snapshot a mounting window is given, and the rest were dropped 72 at a time
                    // (see `agent_session_ipc_test.rs`'s burst test).
                    while let Ok(notification) = updates.try_recv() {
                        forward_update(&sessions, &reported, &emitter, &notification);
                    }
                    // A caller that gave up waiting is not an error: the frames are forwarded
                    // either way, and this is the answer, not the work.
                    let _ = answered.send(());
                }
                None => drains_open = false,
            },
        }
    }
}

/// Turns one `session/update` into a host envelope — or does not.
fn forward_update(
    sessions: &Mutex<HashMap<String, SessionSlot>>,
    reported: &Mutex<HashMap<String, SessionCapabilities>>,
    emitter: &Emitter,
    notification: &SessionNotification,
) {
    // Recorded before any of the early returns below, because this update is a capability fact as
    // well as an event: §3.4's row makes the published list what `/` is available on, and P0 §2.2
    // measured it arriving the instant `session/new` returns — which is *before* the host has
    // registered the session, the ordering the `None` arm below is about. A list dropped here is a
    // `/` menu the panel would be told does not exist.
    //
    // The list replaces the previous one whole (§4.1); what is kept is its size, because the
    // commands themselves reach the `/` menu as events and a capability answer only needs to know
    // whether the engine answered.
    if let SessionUpdate::AvailableCommandsUpdate(update) = &notification.update {
        reported
            .lock()
            .unwrap()
            .entry(notification.session_id.to_string())
            .or_default()
            .commands_published(update.available_commands.len());
    }

    // `None` is the deliberate drop documented in `events` — a thought chunk,
    // or an update this host has no kind for. Neither reaches a component as an
    // unknown.
    let Some((kind, payload)) = normalize_update(&notification.update) else {
        return;
    };
    let session_id = notification.session_id.to_string();

    let run_id = if is_session_scoped(kind) {
        // Decided before the run is looked at, because these kinds describe the session
        // rather than one of its turns: the engine's command list and its option list are
        // facts about what it offers, and they stay true whatever became of a run — the
        // window's reducer says so in its own words ("everything describing the *session* …
        // stays true after a cancel, and is applied exactly as before").
        //
        // **Their `runId` is therefore null, always.** §6.2's envelope defines that field as
        // the generation an event belongs to (see `AgentEventEnvelope`), and these belong to
        // none — P0 §2.2 measured the command list arriving that way. Which also means a
        // session-scoped frame that arrives mid-turn is *not* stamped with that run: the
        // stamp would say the fact belongs to a turn it would outlive, and it would make an
        // unreadable payload fail that turn — `tauri-agent/frames.ts` reports a frame it
        // cannot read as `run-failed` when the frame names a run. An engine's config change
        // must never be able to end a run.
        //
        // **And the run guard below does not apply to them.** That guard exists to stop a
        // dead run's *content* from reviving the answer it wrote; a session-scoped frame is
        // not that content. Gating them there instead dropped every one that arrived after a
        // session's first turn — which is exactly when an engine answers a config change —
        // leaving a panel with the list it saw at `session/new` and nothing after it.
        //
        // Nor is the session's registration required, which is why this branch never reads
        // the session table: the engine sends the command list the instant `session/new`
        // returns, and that can be *before* the host has inserted the session (measured
        // ordering). Requiring registration here would drop a session-scoped frame on an
        // ordering that is the normal one, not an exceptional one. The id being the engine's
        // own, on a connection this host opened, is what makes stamping it honest.
        None
    } else {
        let sessions = sessions.lock().unwrap();
        let run = sessions.get(&session_id).and_then(|slot| slot.run.as_ref());
        match run {
            // A cancelled or completed run is over. The engine is free to keep
            // sending chunks for it — a cancel is a request, not a fence — and
            // forwarding them would make a stopped answer look alive again,
            // which §6.2 rules out in as many words.
            Some(run) if run.cancelled || run.finished => return,
            Some(run) => Some(run.run_id.clone()),
            // A run-scoped update with no run to belong to: either the session
            // is one this host never opened, or its run never started. §6.1
            // forbids stamping a session id this host never received, and text
            // that belongs to no run cannot be placed in the timeline at all.
            None => return,
        }
    };

    emitter.emit(&session_id, run_id, kind, payload);
}

/// Whether a kind describes the session rather than one of its turns.
///
/// The same line the window's reducer draws when it decides what a cancelled run may still
/// be told about (`agent-event-reducer.ts`: its `RUN_CONTENT` and `RUN_END` are the
/// turn-scoped kinds, and everything else is a session fact). Kept as a `match` with no
/// wildcard on purpose: a kind added to the vocabulary has to be classified here rather than
/// falling into whichever branch happens to be the default.
///
/// `FilesChanged` is on this side of the line because the reducer puts it there (touched
/// files stay true after a cancel). Nothing produces one yet, so the classification is a
/// statement about the kind rather than about traffic.
fn is_session_scoped(kind: AgentEventKind) -> bool {
    match kind {
        AgentEventKind::CommandsChanged
        | AgentEventKind::ConfigChanged
        // The session's context occupancy and its cumulative cost are facts about the session, not
        // about the turn that happened to produce them — the same reason the window's reducer does
        // not name `usage-changed` in its `RUN_CONTENT`. So a frame that arrives after a cancel is
        // still a true statement about the session, and it is kept.
        | AgentEventKind::UsageChanged
        | AgentEventKind::FilesChanged => true,
        AgentEventKind::TextDelta
        // The user's half of a restored turn is turn content like the answer's: the reducer's
        // `RUN_CONTENT` names it beside `text-delta`, and a replayed frame carries the load's own
        // run — which is the run it has to be stamped with for the window to place it at all.
        | AgentEventKind::UserDelta
        | AgentEventKind::ThoughtDelta
        | AgentEventKind::ToolUpdate
        | AgentEventKind::PermissionRequest
        | AgentEventKind::RunFinished
        | AgentEventKind::RunFailed => false,
    }
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
