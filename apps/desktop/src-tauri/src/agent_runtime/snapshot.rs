//! The host's snapshot of a session: the bounded replay a window that mounts late is given.
//!
//! §6.2 requires two things of the host here, and this module is exactly those two. **The UI takes
//! the snapshot before it subscribes**, because frames that arrive during the gap are otherwise
//! lost — so the snapshot has to carry what the runtime already published. And **the host keeps a
//! version and a bounded replay policy**, so a caller whose state is older than what is still
//! replayable is told (`buffer-conflict`) rather than handed a stream with a hole in it.
//!
//! Three things it deliberately is not:
//!
//! - **Not a second source of truth.** Every frame here is one the runtime already published,
//!   kept as it was published — same identity, same sequence — so a replayed frame and a live one
//!   cannot arrive differently. Nothing is recomputed, and nothing the runtime holds is mirrored.
//! - **Not per run.** The state a view draws is per session and outlives a run: a window that
//!   remounts between two turns has to be told which turn it is looking at, and whether the last
//!   one ended.
//! - **Not guarded by a counter of its own.** One of these belongs to one incarnation, so a frame
//!   from a previous incarnation cannot reach it — and where a frame *could* cross that line, the
//!   epoch it already carries is what makes it recognizable. §6.2's `runtimeEpoch` is minted once,
//!   by [`super::registry`]'s claim, and a second counter here would be a second answer to a
//!   question that must have exactly one.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use super::events::{AgentEventEnvelope, AgentEventKind, AgentIdentity};

/// How many envelopes one session's window holds.
///
/// A bound is required rather than optional (§6.2's 有界重放策略) because this is memory the host
/// keeps for a window that may never remount. It is a *window*, not a ledger: a caller that ends
/// up outside it is refused with `buffer-conflict` and takes a fresh snapshot, which is the
/// recovery §6.2 names — so the cost of being wrong here is a re-read, never a hole.
pub const REPLAY_WINDOW: usize = 512;

/// One session's window, where its turn stands, and what the view draws.
///
/// The state machine is its own file — see [`session_log`] for why and for the two axes it keeps
/// apart. [`SessionState`] and [`SessionLog`] are reached from there, and the parent's `record`,
/// `opened`, `adopting`, `abandoned`, `started` and `snapshot` are the only readers.
mod session_log;

pub use session_log::SessionState;
use session_log::{ending_of, Ending, SessionLog};

/// The identity a snapshot answers under: the runtime's four fields plus the session's.
///
/// The contract's `AgentIdentity` field for field. The runtime's envelope splits the session id
/// out into its own field, and the snapshot has to put it back — a snapshot whose identity was
/// not checkable against the caller's own would be exactly the "answers about another session"
/// §6.2 refuses.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotIdentity {
    pub agent_id: String,
    pub profile_id: String,
    pub runtime_epoch: String,
    pub vault_id: String,
    pub session_id: String,
}

impl SnapshotIdentity {
    fn of(identity: &AgentIdentity, session_id: &str) -> Self {
        Self {
            agent_id: identity.agent_id.clone(),
            profile_id: identity.profile_id.clone(),
            runtime_epoch: identity.runtime_epoch.clone(),
            vault_id: identity.vault_id.clone(),
            session_id: session_id.to_string(),
        }
    }
}

/// One session, as a window that is mounting now receives it — the contract's
/// `AgentHostSnapshot`, field for field.
///
/// `events` and `permissions` are the host's own envelopes rather than contract payloads: the
/// adapter maps both through one function, so a replayed frame and a live one cannot come out
/// differently. They are disjoint — a permission request is a question, and the same frame in
/// both lists would be two prompts for one request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub identity: SnapshotIdentity,
    pub state: SessionState,
    pub run_id: Option<String>,
    /// The highest sequence this session's stream reached: the position a caller's own
    /// `sequence` is compared against to decide what is a replay and what is news.
    pub sequence: u64,
    pub events: Vec<AgentEventEnvelope>,
    pub permissions: Vec<AgentEventEnvelope>,
}

/// Every session's window, for one runtime incarnation.
///
/// `identity` is the runtime's own (agent, profile, epoch, vault) — the fields every envelope it
/// publishes carries, which is what lets a frame be checked as this runtime's before it is kept.
pub struct SessionSnapshots {
    identity: AgentIdentity,
    window: usize,
    sessions: Mutex<HashMap<String, SessionLog>>,
}

impl SessionSnapshots {
    /// `window` is how many envelopes a session keeps; the caller passes
    /// [`REPLAY_WINDOW`], and a test passes something small to reach the bound.
    pub fn new(identity: AgentIdentity, window: usize) -> Self {
        Self {
            identity,
            window,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// The engine admitted `session_id`.
    ///
    /// A session with nothing published yet is a session whose snapshot is empty, not a session
    /// the host has never heard of — so the two have to be told apart here, and the log is what
    /// tells them apart.
    ///
    /// **It also ends an adoption.** The host calls it once it holds the session
    /// (`agent_open_session`, and `agent_load_session` when the load answers), and from that
    /// moment the session's frames are its turns again and are read as such.
    pub fn opened(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.entry(session_id.to_string()).or_default().adopting = false;
    }

    /// The host is reopening `session_id`: what arrives now is that session's history.
    ///
    /// `session/load` hands the conversation back as ordinary `session/update` notifications, and
    /// this host publishes them as ordinary events — stamped with the load's own run, because a
    /// window can only place turn content that names a turn. Which leaves one thing the frames
    /// cannot say for themselves: **a load is not a turn.** Recorded as one, a restored
    /// conversation arrives at a mounting window as a run that is still going — `state: running`,
    /// `runId: load-N` — for a generation that ended before the window existed. The window then
    /// draws a spinner over a finished conversation and refuses to send, and neither is a reading
    /// the host can defend: nothing has been asked of that session yet.
    ///
    /// So the load path says so, before it asks: while this is set, the frames are recorded, kept
    /// and delivered exactly as before, and only the two questions this log answers about a
    /// *turn* — which run the session is on, and how the last one ended — are left alone. The
    /// session reports [`SessionState::Ready`] with no run bound, which is what
    /// [`Self::opened`]'s own words mean: the engine admitted it and nothing has been asked of it.
    ///
    /// The window still gets its attribution: a replayed frame carries the load's run id, and a
    /// window rebuilding from the snapshot binds it in `replay` mode, where binding is the record
    /// speaking rather than new traffic asking for permission.
    ///
    /// A turn cannot begin in this window: a prompt needs a session handle, the handle is minted
    /// from the load's own answer, and this is cleared by the [`Self::opened`] call beside that
    /// answer. The flag is not a lock; it is the load saying which of its two readers a frame has.
    ///
    /// **It answers whether *this* call is the one that announced the adoption**, and the caller is
    /// expected to use it: a second `agent_load_session` for the same session is refused by the
    /// runtime (`SessionError::LoadInFlight`) while the first is still in flight, and a refusal that
    /// cleared the flag on its way out would end an adoption another window still depends on — the
    /// replayed frames of the *live* load would become turn bookkeeping mid-replay, which is the
    /// failure this flag exists to prevent. [`Self::abandoned`] is therefore only called by the
    /// caller that was told `true` here.
    pub fn adopting(&self, session_id: &str) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        let log = sessions.entry(session_id.to_string()).or_default();
        let announced = !log.adopting;
        log.adopting = true;
        announced
    }

    /// The load [`Self::adopting`] announced did not answer, so nothing is being adopted.
    ///
    /// **Why this is a method and not an `opened` on the failure path.** `opened` states that the
    /// engine admitted the session, which is exactly what a refusal denies; calling it here would
    /// make the log claim something that did not happen, in the one module whose whole subject is
    /// which of two readers a frame has. What both calls have in common is only the flag.
    ///
    /// The entry is kept rather than removed, and that is deliberate: `AlreadyOpen` means the session
    /// is genuinely open and this is *its* log, with its frames and its turn in it. A second,
    /// identical-looking log is what a failed transport leaves behind — a session this build cannot
    /// make rows for — and removing that one would need a way to tell the two apart here, which is
    /// exactly the distinction the caller has and this module does not. A stale entry costs a
    /// `Ready` answer for a session id no window holds a handle for; a removed one would cost the
    /// open session its transcript.
    pub fn abandoned(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.entry(session_id.to_string()).or_default().adopting = false;
    }

    /// A generation was started on `session_id`.
    ///
    /// Called by the command that issued the prompt, because that is the moment the host knows —
    /// the runtime's own answer is the run id, and no frame carries "a run began".
    ///
    /// **It also ends any adoption.** A turn cannot begin inside one — the handle a prompt needs is
    /// minted from the load's own answer — so a flag still set when a run starts is a load that never
    /// answered, and leaving it set would withhold every ending of this run from the reader that
    /// decides what a window draws. `snapshot.rs`'s own note on `adopting` says the flag is not a
    /// lock; this is where that is enforced rather than assumed.
    pub fn started(&self, session_id: &str, run_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        let log = sessions.entry(session_id.to_string()).or_default();
        log.run_id = Some(run_id.to_string());
        log.ended = None;
        log.adopting = false;
    }

    /// Keeps one published envelope, in the order the runtime published it.
    ///
    /// The identity check is an invariant rather than a filter: these envelopes come off this
    /// runtime's own channel, so a frame stamped with another incarnation is a bug in the host,
    /// not a state this module has to have an opinion about in production. It is asserted, not
    /// silently dropped — §11.1 forbids discarding data quietly, even data that cannot arrive.
    pub fn record(&self, envelope: &AgentEventEnvelope) {
        debug_assert_eq!(
            envelope.runtime_epoch, self.identity.runtime_epoch,
            "an envelope from another incarnation reached this runtime's own snapshot"
        );
        let mut sessions = self.sessions.lock().unwrap();
        let log = sessions.entry(envelope.session_id.clone()).or_default();
        log.sequence = log.sequence.max(envelope.sequence);
        // The frame itself is kept whole either way — its run and its sequence are what a window
        // rebuilds the transcript from. What an adoption withholds is the *turn* bookkeeping, and
        // all of it: see [`SessionSnapshots::adopting`].
        if !log.adopting {
            if let Some(run_id) = &envelope.run_id {
                log.run_id = Some(run_id.clone());
            }
            match envelope.kind {
                // The run's ending is the one frame that changes what the view draws, and it is the
                // engine's own stop reason that says which ending it was: `cancelled` is the user's
                // stop (or the engine refusing mid-turn), the four other reasons the contract names
                // are ordinary ends, and anything else is an ending this build cannot name.
                AgentEventKind::RunFinished => {
                    let stop_reason = envelope.payload.get("stopReason").and_then(Value::as_str);
                    log.ended = Some(ending_of(stop_reason));
                }
                AgentEventKind::RunFailed => log.ended = Some(Ending::Failed),
                _ => {}
            }
        }
        if log.events.len() == self.window {
            log.events.pop_front();
        }
        log.events.push_back(envelope.clone());
    }

    /// What a window that is mounting now is given, or `None` for a session this host never
    /// opened — §6.1: a session id the host did not receive is not one it answers about.
    ///
    /// `pending` is the request ids the permission table still holds open. It is passed in rather
    /// than looked up because the table is the authority on which prompts are answerable, and two
    /// reads of "what is pending" could disagree; the prompt list this returns and the state it
    /// reports are therefore derived from one answer.
    pub fn snapshot(&self, session_id: &str, pending: &[String]) -> Option<SessionSnapshot> {
        let sessions = self.sessions.lock().unwrap();
        let log = sessions.get(session_id)?;
        let mut events = Vec::new();
        let mut permissions = Vec::new();
        for envelope in &log.events {
            if envelope.kind == AgentEventKind::PermissionRequest {
                // Only the ones still waiting. An answered prompt is not part of the state a
                // remounting window rebuilds: it already has its answer, and re-publishing the
                // question would put a button in front of the user for a decision already taken.
                let request_id = envelope.payload.get("requestId").and_then(Value::as_str);
                if request_id.is_some_and(|id| pending.iter().any(|held| held == id)) {
                    permissions.push(envelope.clone());
                }
                continue;
            }
            events.push(envelope.clone());
        }
        let state = if permissions.is_empty() {
            log.state()
        } else {
            SessionState::WaitingPermission
        };
        Some(SessionSnapshot {
            identity: SnapshotIdentity::of(&self.identity, session_id),
            state,
            run_id: log.run_id.clone(),
            sequence: log.sequence,
            events,
            permissions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> AgentIdentity {
        AgentIdentity {
            agent_id: "opencode".to_string(),
            profile_id: "default".to_string(),
            runtime_epoch: "epoch-1".to_string(),
            vault_id: "vault-1".to_string(),
        }
    }

    /// One published envelope, as the runtime stamps them.
    fn envelope(sequence: u64, kind: AgentEventKind, payload: Value) -> AgentEventEnvelope {
        AgentEventEnvelope {
            agent_id: "opencode".to_string(),
            profile_id: "default".to_string(),
            runtime_epoch: "epoch-1".to_string(),
            vault_id: "vault-1".to_string(),
            session_id: "ses-1".to_string(),
            run_id: Some("run-0".to_string()),
            sequence,
            kind,
            payload,
        }
    }

    fn text(sequence: u64) -> AgentEventEnvelope {
        envelope(
            sequence,
            AgentEventKind::TextDelta,
            serde_json::json!({ "text": "x" }),
        )
    }

    fn ended(sequence: u64, stop_reason: &str) -> AgentEventEnvelope {
        envelope(
            sequence,
            AgentEventKind::RunFinished,
            serde_json::json!({ "stopReason": stop_reason, "usage": Value::Null }),
        )
    }

    fn prompt(sequence: u64, request_id: &str) -> AgentEventEnvelope {
        envelope(
            sequence,
            AgentEventKind::PermissionRequest,
            serde_json::json!({ "requestId": request_id, "toolCallId": "call-1" }),
        )
    }

    #[test]
    fn a_session_the_host_never_opened_has_no_snapshot() {
        let snapshots = SessionSnapshots::new(identity(), 8);
        assert!(snapshots.snapshot("ses-1", &[]).is_none());
        snapshots.opened("ses-1");
        let empty = snapshots.snapshot("ses-1", &[]).expect("an opened session");
        assert_eq!(empty.state, SessionState::Ready);
        // Nothing has been published: a caller's snapshot is continued from sequence 0, and the
        // first frame of the session is therefore delivered rather than filtered as a replay.
        assert_eq!(empty.sequence, 0);
        assert!(empty.events.is_empty());
    }

    #[test]
    fn the_window_keeps_the_newest_frames_and_its_own_position() {
        let snapshots = SessionSnapshots::new(identity(), 2);
        snapshots.opened("ses-1");
        for sequence in 0..4 {
            snapshots.record(&text(sequence));
        }
        let snapshot = snapshots.snapshot("ses-1", &[]).expect("opened");
        // The bound drops the oldest, and `sequence` stays the highest published: a caller whose
        // own position is older than the window is refused by the adapter (`buffer-conflict`)
        // rather than handed a stream with a hole in it.
        let kept: Vec<u64> = snapshot.events.iter().map(|event| event.sequence).collect();
        assert_eq!(kept, [2, 3]);
        assert_eq!(snapshot.sequence, 3);
    }

    #[test]
    fn the_state_follows_the_turns_the_host_ran() {
        let snapshots = SessionSnapshots::new(identity(), 8);
        snapshots.opened("ses-1");
        snapshots.started("ses-1", "run-0");
        assert_eq!(
            snapshots.snapshot("ses-1", &[]).unwrap().state,
            SessionState::Running
        );
        assert_eq!(
            snapshots.snapshot("ses-1", &[]).unwrap().run_id.as_deref(),
            Some("run-0")
        );

        // The contract's spelling, because that is what `runs.rs` publishes: the SDK's `end_turn`
        // is normalised at the boundary and nothing downstream ever sees it. A fixture that fed
        // this reader the engine's spelling would be the wrong frame for the reading under test —
        // `ending_of` knows the five names that cross the wire, and an unnormalised spelling is a
        // reason this host does not know like any other.
        snapshots.record(&ended(0, "end-turn"));
        let done = snapshots.snapshot("ses-1", &[]).unwrap();
        assert_eq!(done.state, SessionState::Completed);
        // The run id survives the ending: a window that mounts between two turns is told which
        // turn it is looking at, and that it is over.
        assert_eq!(done.run_id.as_deref(), Some("run-0"));

        snapshots.started("ses-1", "run-1");
        snapshots.record(&ended(1, "cancelled"));
        assert_eq!(
            snapshots.snapshot("ses-1", &[]).unwrap().state,
            SessionState::Cancelled
        );

        snapshots.started("ses-1", "run-2");
        snapshots.record(&envelope(
            2,
            AgentEventKind::RunFailed,
            serde_json::json!({ "code": "process-exited", "message": "gone" }),
        ));
        assert_eq!(
            snapshots.snapshot("ses-1", &[]).unwrap().state,
            SessionState::Failed
        );
    }

    /// The ending this snapshot recorded for `ses-1`, as this module holds it.
    ///
    /// Reached through the private map on purpose: the arm is the thing under test, and reading it
    /// back through `state()` would only show the axis the fix deliberately leaves unchanged.
    fn recorded_ending(snapshots: &SessionSnapshots) -> Option<Ending> {
        snapshots
            .sessions
            .lock()
            .unwrap()
            .get("ses-1")
            .and_then(|log| log.ended)
    }

    #[test]
    fn an_unknown_ending_says_the_turn_ended_and_keeps_the_engines_own_word() {
        let snapshots = SessionSnapshots::new(identity(), 8);
        snapshots.opened("ses-1");
        snapshots.started("ses-1", "run-0");
        snapshots.record(&ended(0, "budget-exceeded"));

        // The recorded ending is the unknown one — and the state is the arm that says the turn is
        // over, because that is the axis a `run-finished` frame settles. The two are not the same
        // claim: this is the state the contract answers for the case (`endStateFor` in
        // `agent-event-apply.ts`, and the pet's reading of a snapshot's `completed`), and a state
        // of this host's own naming is the one answer the window cannot read at all.
        assert_eq!(recorded_ending(&snapshots), Some(Ending::Unrecognised));
        let snapshot = snapshots.snapshot("ses-1", &[]).expect("opened");
        assert_eq!(snapshot.state, SessionState::Completed);
        assert_eq!(
            snapshot.run_id.as_deref(),
            Some("run-0"),
            "the turn it is looking at"
        );

        // The why survives where a person can see it: the frame is kept as it was published, so a
        // window replaying this tail reads the engine's own word out of it and shows it. The
        // snapshot does not restate the word anywhere else — it is not a second source of truth,
        // and a copy here would be a field no consumer reads.
        let ending = snapshot.events.last().expect("the ending is in the tail");
        assert_eq!(ending.kind, AgentEventKind::RunFinished);
        assert_eq!(ending.payload["stopReason"], "budget-exceeded");
    }

    #[test]
    fn a_prompt_is_a_separate_list_and_only_while_it_is_open() {
        let snapshots = SessionSnapshots::new(identity(), 8);
        snapshots.opened("ses-1");
        snapshots.record(&text(0));
        snapshots.record(&prompt(1, "perm-1"));

        let open = snapshots
            .snapshot("ses-1", &["perm-1".to_string()])
            .unwrap();
        assert_eq!(open.state, SessionState::WaitingPermission);
        assert_eq!(open.permissions.len(), 1);
        assert_eq!(open.permissions[0].payload["requestId"], "perm-1");
        // The question is not in the event tail as well: a subscriber would be delivered the same
        // prompt twice, once from the snapshot and once from the frame.
        assert_eq!(open.events.len(), 1);
        assert_eq!(open.events[0].kind, AgentEventKind::TextDelta);

        // Answered (or revoked): the prompt is not part of the state a remounting window rebuilds,
        // and the session is back to what the turn is doing — the request's own envelope carried
        // the run it was raised under, so the turn is what is left.
        let answered = snapshots.snapshot("ses-1", &[]).unwrap();
        assert!(answered.permissions.is_empty());
        assert_eq!(answered.state, SessionState::Running);
    }

    /// A turn that begins while an adoption is still open is a turn like any other.
    ///
    /// The flag is announced by `agent_load_session` before it asks the engine, and cleared by
    /// [`SessionSnapshots::opened`] only when the load *answers*. A load the engine refuses
    /// (`AlreadyOpen`) or one that dies in transport is therefore a flag left set — and the run that
    /// follows it is the failure this module was written against: `started` binds the run while
    /// `record` withholds every ending, so `state` answers `Running` for a conversation that is over,
    /// and a window remounting on it draws a spinner and refuses to send.
    ///
    /// A turn cannot legitimately begin inside an adoption — the handle a prompt needs is minted from
    /// the load's own answer — so clearing the flag here costs the honest case nothing and is what
    /// makes the two states unrepresentable rather than merely unreachable.
    #[test]
    fn a_turn_that_begins_inside_an_adoption_is_not_stuck_running() {
        let snapshots = SessionSnapshots::new(identity(), 8);
        // The announcement, and then no answer: `opened` is never reached, which is the whole point.
        snapshots.adopting("ses-1");
        snapshots.started("ses-1", "run-0");
        snapshots.record(&ended(0, "end-turn"));

        assert_eq!(
            recorded_ending(&snapshots),
            Some(Ending::Completed),
            "the ending was withheld from a turn that had already begun"
        );
        assert_eq!(
            snapshots.snapshot("ses-1", &[]).expect("opened").state,
            SessionState::Completed,
            "a finished conversation still reads as a run in flight"
        );
    }

    /// And an adoption that never answered is over, so the frames that follow are the session's own.
    ///
    /// The refusal path's own half: `agent_load_session` announces the adoption and then may return
    /// before `opened`, so it has to say so itself. The flag is the only thing that clears it — there
    /// is no timeout and no second reader — and a log left adopting is a session whose endings this
    /// host will not read for the rest of the process's life.
    ///
    /// What is asserted is therefore the *reader* and not the flag: after a refusal, a frame that
    /// states an ending states one. A no-op `abandoned` leaves the ending withheld, which is the
    /// difference between a conversation a window can draw and one it spins on for ever.
    #[test]
    fn an_adoption_that_never_answered_is_over() {
        let snapshots = SessionSnapshots::new(identity(), 8);
        snapshots.adopting("ses-1");
        snapshots.abandoned("ses-1");
        snapshots.record(&ended(0, "end-turn"));

        assert_eq!(
            recorded_ending(&snapshots),
            Some(Ending::Completed),
            "an ending was withheld from a session nothing is adopting"
        );
        assert_eq!(
            snapshots.snapshot("ses-1", &[]).expect("opened").state,
            SessionState::Completed
        );
    }

    /// A second load that is refused does not end the first one's adoption.
    ///
    /// Two windows may ask for the same session, and the runtime refuses the second with
    /// `LoadInFlight` while the first is still in flight. `adopting` answers whether the call is the
    /// one that announced the adoption, and the command clears the flag only then: without that, the
    /// second window's refusal would hand the *first* load's replayed frames to the turn bookkeeping
    /// mid-replay — the failure this flag was written against, reached from the other side.
    #[test]
    fn a_second_load_that_fails_does_not_end_the_first_ones_adoption() {
        let snapshots = SessionSnapshots::new(identity(), 8);
        assert!(
            snapshots.adopting("ses-1"),
            "the first load is the one that announces the adoption"
        );
        assert!(
            !snapshots.adopting("ses-1"),
            "a second load does not own the announcement, so it must not clear it on its way out"
        );

        snapshots.record(&ended(0, "end-turn"));
        assert_eq!(
            recorded_ending(&snapshots),
            None,
            "an adoption another caller still depends on was ended by a refusal that was not its own"
        );

        // And the load that *did* announce it still ends the adoption, in both directions: a success
        // through `opened`, a failure through `abandoned`. This is the pair `agent_load_session`
        // chooses between.
        snapshots.abandoned("ses-1");
        snapshots.record(&ended(1, "end-turn"));
        assert_eq!(recorded_ending(&snapshots), Some(Ending::Completed));
    }
}
