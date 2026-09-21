//! Adopting an engine session that already holds a conversation, and the drain that ordering
//! depends on.
//!
//! **Why it is a file of its own.** It was a section of [`super`], which passed the 600-line budget
//! `docs/dev.md:286` puts on a business source file, and the criterion that section states is the
//! number of reasons a file changes rather than its length. This module moves when the *load path*
//! moves: the ordering `session/load` is registered and stamped in, what a replayed frame belongs
//! to, or whether the response waits for the replay. The parent moves when the host's own table of
//! sessions does, and a load is the one call that writes that table before it has an answer —
//! which is exactly why it is here, with its own measured defect (`agent_session_ipc_test.rs`'s
//! burst test) written down beside the wait that fixes it.

use std::path::Path;
use std::sync::atomic::Ordering;

use agent_client_protocol::schema::v1::SessionId;
use serde_json::Value;

use super::{AgentRuntime, RunState, SessionError, SessionInfo, SessionSlot, LOAD_BOUND};

impl AgentRuntime {
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
    pub(super) async fn drain_updates(&self) {
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
}
