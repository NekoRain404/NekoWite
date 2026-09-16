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

use std::collections::{HashMap, VecDeque};
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

/// One session's window, and where its turn stands.
struct SessionLog {
    events: VecDeque<AgentEventEnvelope>,
    /// The run in progress or the last one to end — the answer to "which turn am I looking at".
    run_id: Option<String>,
    /// How the last run ended, or `None` while one is open (or none has run).
    ended: Option<Ending>,
    /// The highest sequence this session's stream reached.
    sequence: u64,
}

impl Default for SessionLog {
    fn default() -> Self {
        Self {
            events: VecDeque::new(),
            run_id: None,
            ended: None,
            sequence: 0,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ending {
    Completed,
    Cancelled,
    Failed,
}

/// What the view draws, as §6.2's state machine.
///
/// `idle` and `starting`, which the contract's union also carries, name the states *before* a
/// session exists. A snapshot is always about a session that does, so this host never answers
/// them — and a state it cannot reach is not one it should be able to invent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    /// The engine admitted the session; nothing has been asked of it yet.
    Ready,
    /// A generation is in flight.
    Running,
    /// A generation is in flight *and* the engine is waiting on the user to allow something.
    /// Derived from the permission table, not from the frames, so it cannot disagree with the
    /// prompt list the same snapshot carries.
    WaitingPermission,
    Completed,
    Cancelled,
    Failed,
}

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
    pub fn opened(&self, session_id: &str) {
        self.sessions
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default();
    }

    /// A generation was started on `session_id`.
    ///
    /// Called by the command that issued the prompt, because that is the moment the host knows —
    /// the runtime's own answer is the run id, and no frame carries "a run began".
    pub fn started(&self, session_id: &str, run_id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        let log = sessions.entry(session_id.to_string()).or_default();
        log.run_id = Some(run_id.to_string());
        log.ended = None;
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
        if let Some(run_id) = &envelope.run_id {
            log.run_id = Some(run_id.clone());
        }
        match envelope.kind {
            // The run's ending is the one frame that changes what the view draws, and it is the
            // engine's own stop reason that says which ending it was: `cancelled` is the user's
            // stop (or the engine refusing mid-turn), and everything else is a completed turn.
            AgentEventKind::RunFinished => {
                let stop_reason = envelope.payload.get("stopReason").and_then(Value::as_str);
                log.ended = Some(match stop_reason {
                    Some("cancelled") => Ending::Cancelled,
                    _ => Ending::Completed,
                });
            }
            AgentEventKind::RunFailed => log.ended = Some(Ending::Failed),
            _ => {}
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

impl SessionLog {
    fn state(&self) -> SessionState {
        match (self.run_id.is_some(), self.ended) {
            (_, Some(Ending::Cancelled)) => SessionState::Cancelled,
            (_, Some(Ending::Failed)) => SessionState::Failed,
            (_, Some(Ending::Completed)) => SessionState::Completed,
            (true, None) => SessionState::Running,
            (false, None) => SessionState::Ready,
        }
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
        envelope(sequence, AgentEventKind::TextDelta, serde_json::json!({ "text": "x" }))
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
        assert_eq!(snapshots.snapshot("ses-1", &[]).unwrap().state, SessionState::Running);
        assert_eq!(
            snapshots.snapshot("ses-1", &[]).unwrap().run_id.as_deref(),
            Some("run-0")
        );

        snapshots.record(&ended(0, "end_turn"));
        let done = snapshots.snapshot("ses-1", &[]).unwrap();
        assert_eq!(done.state, SessionState::Completed);
        // The run id survives the ending: a window that mounts between two turns is told which
        // turn it is looking at, and that it is over.
        assert_eq!(done.run_id.as_deref(), Some("run-0"));

        snapshots.started("ses-1", "run-1");
        snapshots.record(&ended(1, "cancelled"));
        assert_eq!(snapshots.snapshot("ses-1", &[]).unwrap().state, SessionState::Cancelled);

        snapshots.started("ses-1", "run-2");
        snapshots.record(&envelope(
            2,
            AgentEventKind::RunFailed,
            serde_json::json!({ "code": "process-exited", "message": "gone" }),
        ));
        assert_eq!(snapshots.snapshot("ses-1", &[]).unwrap().state, SessionState::Failed);
    }

    #[test]
    fn a_prompt_is_a_separate_list_and_only_while_it_is_open() {
        let snapshots = SessionSnapshots::new(identity(), 8);
        snapshots.opened("ses-1");
        snapshots.record(&text(0));
        snapshots.record(&prompt(1, "perm-1"));

        let open = snapshots.snapshot("ses-1", &["perm-1".to_string()]).unwrap();
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
}
