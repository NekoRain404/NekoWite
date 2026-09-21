//! The AI registry's own contract: an id is claimed once, a cancel signals the owner's token, and a
//! release or a cancel of an id nobody holds is not an error.

use super::AiState;
use tokio_util::sync::CancellationToken;

#[test]
fn a_second_claim_on_a_live_id_is_refused_and_leaves_the_first_alone() {
    let state = AiState::default();
    let first = CancellationToken::new();
    assert!(state.claim("req-1", first.clone()).unwrap());

    let second = CancellationToken::new();
    assert!(
        !state.claim("req-1", second.clone()).unwrap(),
        "a live id must not be handed out twice"
    );

    // The refused claim must not have replaced the first token, or
    // `ai_cancel` would signal a request nobody is running while the real
    // one streams on uncancellable.
    assert!(state.cancel("req-1").unwrap());
    assert!(
        first.is_cancelled(),
        "the owner's token is the one cancelled"
    );
    assert!(!second.is_cancelled());
    assert!(!state.inflight.lock().unwrap().contains("req-1"));
}

#[test]
fn releasing_an_id_frees_it_for_reuse() {
    let state = AiState::default();
    assert!(state.claim("req-2", CancellationToken::new()).unwrap());
    state.release("req-2");
    assert!(!state.inflight.lock().unwrap().contains("req-2"));
    assert!(state.claim("req-2", CancellationToken::new()).unwrap());
}

#[test]
fn cancelling_or_releasing_an_unknown_id_is_not_an_error() {
    let state = AiState::default();
    assert!(!state.cancel("never-started").unwrap());
    state.release("never-started");
}
