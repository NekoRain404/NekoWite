//! What a poisoned session slot does to the four ways it is read.
//!
//! The defect these pin (finding F7 in `docs/audits/2026-09-21-code-review.md`) was an asymmetry
//! rather than a wrong answer: five readers refused loudly when the mutex had been poisoned by a
//! panic, and the two writers — `install` and `clear` — failed soft. `install` dropping the session
//! meant `agent_start` could answer a handle and an epoch for a session nothing had installed;
//! `clear` answering `None` meant `stop_running_engine` skipped `permissions.revoke_all()` and the
//! pet retire, because "there was no session" and "this slot cannot be read" arrived as the same
//! value.
//!
//! **How the slot is poisoned here.** A panic while the lock is held is the only way to poison a
//! `std::sync::Mutex`, so the fixture does exactly that on a thread it can catch: it takes the
//! guard, panics with it held, and the `catch_unwind` absorbs the panic while the mutex keeps the
//! mark. That is the same shape the real failure would have, rather than a hand-set flag a
//! production code path could never produce.

use std::panic::{catch_unwind, AssertUnwindSafe};

use super::AgentIpcState;

/// A state whose slot has been poisoned by a panic while it was held.
fn poisoned() -> AgentIpcState {
    let state = AgentIpcState::default();
    let panicked = catch_unwind(AssertUnwindSafe(|| {
        let _held = state.session.lock().expect("the slot is not poisoned yet");
        panic!("a panic while the session slot is held poisons it");
    }));
    assert!(panicked.is_err(), "the fixture must actually panic");
    assert!(
        state.session.is_poisoned(),
        "the fixture must leave the slot poisoned"
    );
    state
}

#[test]
fn a_writer_that_cannot_take_the_slot_refuses_instead_of_failing_soft() {
    let state = poisoned();
    // Matched rather than `expect_err`: `Session` has no `Debug`, deliberately — it carries a live
    // engine, and a printable one would be a printable handle to it.
    let failure = match state.clear() {
        Err(failure) => failure,
        Ok(_) => panic!("a poisoned slot cannot be cleared, and clearing must not answer `None`"),
    };
    assert_eq!(
        failure.message, "the agent session state was poisoned by a panic",
        "the writer must refuse with the same sentence the readers use"
    );

    // The same slot, on the empty-but-unpoisoned state, is `Ok(None)` rather than an error: the
    // two facts must not be collapsed, which is the whole of the fix.
    let fresh = AgentIpcState::default();
    assert!(
        matches!(fresh.clear(), Ok(None)),
        "an empty slot clears to nothing"
    );
}

#[test]
fn every_reader_that_can_refuse_refuses_with_one_sentence() {
    let state = poisoned();
    let reader = match state.session() {
        Err(failure) => failure,
        Ok(_) => panic!("a poisoned slot has no session to answer"),
    };
    assert_eq!(
        reader.message, "the agent session state was poisoned by a panic",
        "the guard and the session read must not word the same condition differently"
    );
}

#[test]
fn the_reader_that_answers_a_state_still_answers_none() {
    // `session_or_none` is the readout's arm rather than a call's: "no engine is running" is one of
    // its own answers, so a poison is `None` there by design — and that is why it is not the path a
    // caller that must proceed uses.
    assert!(poisoned().session_or_none().is_none());
}
