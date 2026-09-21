//! One session's window, where its turn stands, and what the view draws — the state machine
//! `snapshot.rs` is named for.
//!
//! **Why it is a file of its own.** It was the top of `snapshot.rs`, which passed the 600-line budget
//! `docs/dev.md:286` puts on a business file. The split is by *reason to change*, which is the
//! criterion that section states rather than the line count: this module moves when the *state
//! machine* moves — a state the contract adds, a stop reason this build learns to name, a turn
//! boundary — while `snapshot.rs` moves when the *registry* does: which sessions the host answers
//! about, the window it replays, the identity each answer carries. The two are the halves the
//! registry's own methods already read as: everything below is what one log answers, and the parent is
//! what the map of them answers.
//!
//! **Two axes, kept apart.** "The turn ended" is settled by a frame's own kind and is what
//! [`SessionState`] reports; "how it ended" is [`Ending`] and is the only place an ending the engine
//! named and an ending nobody named can be told apart. A reader that folded them would make the second
//! axis carry the first's confidence, which is the defect the [`Ending::Unrecognised`] arm exists for.
//!
//! [`SessionState`] is defined here rather than in the parent because the table that answers it is
//! here: a state added to the contract is a state this file has to decide about, and a definition one
//! file away from its only producer is how the two drift. Every `snapshot::SessionState` in the crate
//! still resolves — the parent re-exports it at that path.

use std::collections::VecDeque;

use serde::Serialize;

use crate::agent_runtime::events::AgentEventEnvelope;

/// What the view draws, as §6.2's state machine.
///
/// `idle` and `starting`, which the contract's union also carries, name the states *before* a session
/// exists. A snapshot is always about a session that does, so this host never answers them — and a
/// state it cannot reach is not one it should be able to invent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    /// The engine admitted the session; nothing has been asked of it yet.
    Ready,
    /// A generation is in flight.
    Running,
    /// A generation is in flight *and* the engine is waiting on the user to allow something. Derived
    /// from the permission table, not from the frames, so it cannot disagree with the prompt list the
    /// same snapshot carries.
    WaitingPermission,
    Completed,
    Cancelled,
    Failed,
}

/// One session's window, and where its turn stands.
///
/// `pub(super)` on every field because the registry owns the map and reads them directly: its `record`
/// decides what a frame means to this log, and its `snapshot` reads a run id, a position and the window
/// itself out of it. Getters would be five more names for fields the parent already has the right to
/// read, in the one place that owns both.
pub(super) struct SessionLog {
    pub(super) events: VecDeque<AgentEventEnvelope>,
    /// The run in progress or the last one to end — the answer to "which turn am I looking at".
    pub(super) run_id: Option<String>,
    /// How the last run ended, or `None` while one is open (or none has run).
    pub(super) ended: Option<Ending>,
    /// The highest sequence this session's stream reached.
    pub(super) sequence: u64,
    /// The host is reopening this session, and the frames it is publishing are that session's
    /// **history** rather than a turn of it.
    ///
    /// See [`super::SessionSnapshots::adopting`]. It is a flag on the log rather than a fact read off
    /// the frames because the frames cannot say it: `session/load`'s replay arrives as ordinary
    /// `session/update` notifications, stamped with the load's own run so that a window has something
    /// to attribute them to, and a frame that names a run is indistinguishable from a turn's frame by
    /// its own shape.
    pub(super) adopting: bool,
}

impl Default for SessionLog {
    fn default() -> Self {
        Self {
            events: VecDeque::new(),
            run_id: None,
            ended: None,
            sequence: 0,
            adopting: false,
        }
    }
}

/// Why the last run ended, as far as this host can say — and deliberately not *whether* it did.
///
/// The two are different axes and the contract keeps them apart. "The turn ended" is settled by the
/// frame's own kind, and it is what [`SessionState::Completed`] reports; "how it ended" is what this
/// type holds, and it is the only place an ending the engine named and an ending nobody named can be
/// told apart. A reader that folds them makes the second axis carry the first axis's confidence —
/// which is what `_ => Completed` did, and what `run-finished` did not say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Ending {
    /// An ending the engine named among the reasons this build knows, `cancelled` excepted below. A
    /// ceiling (`max-tokens`, `max-turn-requests`) and a refusal are here, not in arms of their own:
    /// the contract decided they "ended the way the turn was always going to end"
    /// (`agent-event-apply.ts`'s `endStateFor`, and the reducer's cases pin it), and this type has no
    /// consumer that could act on the difference — the reason itself travels in the frame.
    Completed,
    Cancelled,
    Failed,
    /// An ending whose reason this build cannot state: the engine's own word for something this
    /// version has no arm for, or a frame that states no usable reason at all.
    ///
    /// Its own arm rather than the `Completed` above, because "the turn ended" is all that was said:
    /// `runs.rs` publishes an unfamiliar reason as the engine's own word (the pinned schema's
    /// `StopReason` is `#[non_exhaustive]`, so this is a normal frame), the pet projection reads the
    /// same frame as `Unknown` rather than `turn-finished` (`task_projection::outcomes`), and the
    /// window's own reader reports `unrecognised`. All three agree that the ending is *known to have
    /// happened* and *not known to be* anything more; this arm saying `Completed` would be the one
    /// reader inventing an ending out of three.
    Unrecognised,
}

/// How one `run-finished` frame's stop reason reads to this module.
///
/// One spelling, and it is the contract's: `runs.rs` renders every reason — the schema's and an
/// unfamiliar one — through the same `_` → `-` replacement before publishing, so a reason under some
/// other spelling is a reason this host does not know rather than a second way of writing one it does.
/// The pet projection reads the same value the same way and with the same total match
/// (`task_projection::outcomes::state_from_stop_reason`), which is what keeps the two readers of one
/// frame from answering differently about it.
///
/// The four known reasons an ordinary turn can end with are named one by one rather than caught by a
/// fallback: a reason the protocol adds later is then `Unrecognised` — the honest reading — by
/// construction, instead of being read as a completion by a `_` arm that was written when the
/// vocabulary was the five it could see. What catches the rest is a single arm that says "this build
/// cannot name it", so the fallback is the honest reading rather than the confident one. `None` — a
/// frame that states no usable reason at all — is the same fact as a word this build does not know: no
/// ending can be named. `runs.rs` always renders a string, so that input is not one the runtime's own
/// frames produce; it is here so the match is total over what the reader can be handed.
pub(super) fn ending_of(stop_reason: Option<&str>) -> Ending {
    match stop_reason {
        Some("cancelled") => Ending::Cancelled,
        Some("end-turn" | "max-tokens" | "max-turn-requests" | "refusal") => Ending::Completed,
        Some(_) | None => Ending::Unrecognised,
    }
}

impl SessionLog {
    /// What the view draws for this session right now.
    pub(super) fn state(&self) -> SessionState {
        match (self.run_id.is_some(), self.ended) {
            (_, Some(Ending::Cancelled)) => SessionState::Cancelled,
            (_, Some(Ending::Failed)) => SessionState::Failed,
            // Two endings, one state, and only on *this* axis: a frame with `run-finished` as its kind
            // has said the turn is over, and how it ended is not what this state reports —
            // `outcome_of_snapshot` reads it that way ("a snapshot says a turn ended and cannot say
            // how"), and the window's own reader maps its `unrecognised` arm here as well
            // (`agent-event-apply.ts`'s `endStateFor`, with the reason kept in `lastResult`).
            //
            // A state of this host's own naming is the one answer that is not available: the window's
            // `readHostState` refuses a state outside the contract's eight, and the refusal costs the
            // whole snapshot rather than one field. So the uncertainty is carried where it can be —
            // `Ending` — and the word the engine sent is left in the `run-finished` frame this log
            // keeps, which is what a window replays and shows.
            (_, Some(Ending::Completed | Ending::Unrecognised)) => SessionState::Completed,
            (true, None) => SessionState::Running,
            (false, None) => SessionState::Ready,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The stop-reason table, arm by arm.
    ///
    /// It lives beside the table rather than in the registry's tests one file up, and that is where
    /// the budget put it as much as where the subject is: this is a pure function of one string, and a
    /// case that reaches it through `SessionSnapshots` is a case about the map rather than about the
    /// reading. The two cases that *are* about the map — which turn a session is on, and what a
    /// mounting window is handed — stayed there.
    #[test]
    fn an_ending_this_build_cannot_name_is_an_arm_of_its_own() {
        // The word a live engine sent (P0 §6.3's `budget_exceeded`, respelled at the boundary by
        // `runs.rs`), which the pinned schema's `#[non_exhaustive]` `StopReason` does not enumerate:
        // a normal frame, not a corrupt one. It is *not* `Completed` — that arm means the engine named
        // one of the reasons this build knows, and this frame named none of them. The pet projection
        // reads the same value as `Unknown` and the window's reader as `unrecognised`; an arm here
        // that said `Completed` would be the one reader out of three inventing an ending.
        assert_eq!(ending_of(Some("budget-exceeded")), Ending::Unrecognised);
        // A frame that states no usable reason at all says the same thing about *why*: nothing.
        assert_eq!(ending_of(None), Ending::Unrecognised);
        // And the other spelling of a reason this build knows is a reason it does not know: one
        // spelling crosses this boundary (`runs.rs::wire_stop_reason`), so an engine's `snake_case`
        // here is not a second way of writing `end-turn`.
        assert_eq!(ending_of(Some("end_turn")), Ending::Unrecognised);

        // Every reason the contract names keeps the arm it had, named one by one so that a sixth
        // reason the protocol adds lands in `Unrecognised` rather than being read as a completion.
        for reason in ["end-turn", "max-tokens", "max-turn-requests", "refusal"] {
            assert_eq!(ending_of(Some(reason)), Ending::Completed, "{reason}");
        }
        assert_eq!(ending_of(Some("cancelled")), Ending::Cancelled);
    }

    /// The state table, over the two axes it is built from.
    #[test]
    fn the_state_is_a_function_of_the_run_and_how_it_ended() {
        let mut log = SessionLog::default();
        assert_eq!(
            log.state(),
            SessionState::Ready,
            "nothing has been asked of it"
        );

        log.run_id = Some("run-0".into());
        assert_eq!(log.state(), SessionState::Running);

        log.ended = Some(Ending::Completed);
        assert_eq!(log.state(), SessionState::Completed);
        log.ended = Some(Ending::Cancelled);
        assert_eq!(log.state(), SessionState::Cancelled);
        log.ended = Some(Ending::Failed);
        assert_eq!(log.state(), SessionState::Failed);
        // An ending this build cannot name is still an ending: the axis it moves is `Ending`, and the
        // state the contract has for "the turn is over" is the same one (`state()` argues it).
        log.ended = Some(Ending::Unrecognised);
        assert_eq!(log.state(), SessionState::Completed);
    }
}
