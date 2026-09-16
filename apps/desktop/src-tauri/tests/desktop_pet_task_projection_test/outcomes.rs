//! §6.2's table, and the rows that are prohibitions rather than mappings.
//!
//! Four of the rows say what the pet may *not* show: a ceiling is not a success, a refusal is not
//! a success, a cancellation is neither a success nor a failure, and a snapshot that says a turn
//! ended without saying how is not an ending at all. Each is a case where the comfortable reading
//! and the true one differ, so each is tested by producing the comfortable reading's input and
//! asserting the other answer.

use nekowite_lib::agent_runtime::events::AgentEventKind;
use nekowite_lib::agent_runtime::snapshot::SessionState;

use crate::desktop_pet::task_projection::{Disposition, PetTaskState};
use crate::support::{
    envelope, finished, first_instance, key, permission, projection, snapshot, state_of, task_count,
};

/// §6.2's stop-reason rows, one case each, spelled the way the contract spells them.
#[test]
fn every_stop_reason_the_contract_names_has_a_row() {
    let rows = [
        ("end-turn", "turn-finished"),
        ("max-tokens", "stopped"),
        ("max-turn-requests", "stopped"),
        ("refusal", "refused"),
        ("cancelled", "cancelled"),
    ];
    for (reason, expected) in rows {
        let mut projection = projection();
        let ours = first_instance();
        projection.install(&ours);
        projection.started(&ours, "ses_1", "run-1");

        projection.apply(&finished(&ours, "ses_1", "run-1", 1, reason));

        assert_eq!(
            state_of(&projection, &key(&ours, "ses_1", "run-1")),
            expected,
            "{reason}"
        );
    }
}

/// §6.2's failure rows, including the two that are not `failed`: a cancellation the user asked
/// for, and a runtime that is gone — which has no panel left to hold the detail.
#[test]
fn a_cancellation_is_not_a_failure_and_a_lost_runtime_is_not_one_either() {
    let rows = [
        ("cancelled", "cancelled"),
        ("process-exited", "interrupted"),
        ("runtime-unavailable", "interrupted"),
        ("permission-denied", "failed"),
        ("timeout", "failed"),
        ("invalid-response", "failed"),
    ];
    for (code, expected) in rows {
        let mut projection = projection();
        let ours = first_instance();
        projection.install(&ours);
        projection.started(&ours, "ses_1", "run-1");

        projection.apply(&envelope(
            &ours,
            "ses_1",
            Some("run-1"),
            1,
            AgentEventKind::RunFailed,
            serde_json::json!({ "code": code, "message": "the engine said so" }),
        ));

        assert_eq!(
            state_of(&projection, &key(&ours, "ses_1", "run-1")),
            expected,
            "{code}"
        );
    }
}

/// A stop reason this host does not know is `unknown`, never `turn-finished`. §6.2 forbids
/// asserting a normal ending for a turn whose ending is not known, and `unknown` is deliberately
/// not a terminal state so that a later frame which *does* know can still replace it.
#[test]
fn an_unrecognised_stop_reason_is_unknown_and_can_still_be_replaced() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&finished(
        &ours,
        "ses_1",
        "run-1",
        1,
        "some-later-protocols-reason",
    ));

    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "unknown"
    );
    assert!(!PetTaskState::Unknown.is_settled());

    let informed = projection.apply(&finished(&ours, "ses_1", "run-1", 2, "refusal"));
    assert_eq!(informed.disposition, Disposition::Applied);
    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "refused"
    );
}

/// There is one spelling, and the engine's is not it.
///
/// `agent_runtime::runs` normalizes the engine's `snake_case` `StopReason` into the contract's
/// `kebab-case` before publishing the frame, so the reader has exactly one spelling to know. The
/// case below is what keeps that from becoming an assumption: what the reader does with the other
/// spelling is read it as an ending it does not know — never as a completed turn.
#[test]
fn the_engines_own_spelling_is_not_a_second_way_to_say_the_same_ending() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");

    // A frame from a runtime that did not normalize — an older build, or a producer that is not
    // this runtime at all. An unknown ending is a wrong fact only if it is read as a known one.
    projection.apply(&finished(&ours, "ses_1", "run-1", 1, "end_turn"));

    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "unknown"
    );
}

/// §6.2's 待授权 row: the state is visible on its own, and the id travels with it so a click goes
/// to the host's permission UI. Nothing else about the request is in the projection, so there is
/// nothing here a window could authorise with.
#[test]
fn a_permission_request_states_the_request_to_route_to() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");

    projection.apply(&permission(&ours, "ses_1", "run-1", 1, "req-1"));

    let task = projection
        .task(&key(&ours, "ses_1", "run-1"))
        .expect("the run is still there");
    assert_eq!(task.state, PetTaskState::WaitingInput);
    assert_eq!(task.permission_request_id.as_deref(), Some("req-1"));
}

/// A run that moved on is not waiting for an answer any more, so any other fact about it releases
/// the prompt. A prompt left standing would be a button that no longer does anything (§11's
/// 「过期请求按钮不能继续操作」).
#[test]
fn another_fact_about_the_run_releases_the_prompt() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&permission(&ours, "ses_1", "run-1", 1, "req-1"));

    projection.apply(&finished(&ours, "ses_1", "run-1", 2, "end-turn"));

    let task = projection
        .task(&key(&ours, "ses_1", "run-1"))
        .expect("the run is still there");
    assert_eq!(task.state, PetTaskState::TurnFinished);
    assert_eq!(task.permission_request_id, None);
}

/// The host's own view: a run in flight is `working`, and nothing here turns a lull or a count
/// into a percentage — §6.2's first row.
#[test]
fn a_running_snapshot_is_working() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);

    let ingest = projection.observe(&snapshot(
        &ours,
        "ses_1",
        Some("run-1"),
        4,
        SessionState::Running,
        &[],
    ));

    assert_eq!(ingest.disposition, Disposition::Applied);
    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "working"
    );
}

/// A window that mounts while the engine is waiting gets the oldest unanswered request to route
/// to — the one the user has to deal with first.
#[test]
fn a_waiting_snapshot_carries_the_oldest_unanswered_request() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    let pending = [
        permission(&ours, "ses_1", "run-1", 1, "req-old"),
        permission(&ours, "ses_1", "run-1", 2, "req-new"),
    ];

    projection.observe(&snapshot(
        &ours,
        "ses_1",
        Some("run-1"),
        2,
        SessionState::WaitingPermission,
        &pending,
    ));

    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "waiting-input"
    );
    assert_eq!(
        projection
            .task(&key(&ours, "ses_1", "run-1"))
            .and_then(|task| task.permission_request_id.as_deref()),
        Some("req-old")
    );
}

/// **The row the ledger's §7.7 is about.** A snapshot says a turn ended and cannot say how: the
/// stop reason lives only in `run-finished`, and `SessionState::Completed` has already discarded
/// it. Reading this as `turn-finished` would claim a normal ending for a turn that may have hit a
/// ceiling, so it projects nothing at all — and the ending a window shows for it comes from the
/// host's own record, not from a re-derivation here.
#[test]
fn a_completed_snapshot_projects_nothing() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);

    let ingest = projection.observe(&snapshot(
        &ours,
        "ses_1",
        Some("run-1"),
        3,
        SessionState::Completed,
        &[],
    ));

    assert_eq!(ingest.disposition, Disposition::NoChange);
    assert_eq!(
        task_count(&projection),
        0,
        "no task is invented from a snapshot that says nothing"
    );
}

/// A session with no turn going is not a task at all — §6.2 has no row for `ready`, and inventing
/// one would put an idle engine on the pet's list of things it is doing.
#[test]
fn a_ready_snapshot_projects_nothing() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");

    let ingest = projection.observe(&snapshot(&ours, "ses_1", None, 1, SessionState::Ready, &[]));

    assert_eq!(ingest.disposition, Disposition::Foreign);
    assert_eq!(task_count(&projection), 1);
}

/// The endings a snapshot *can* state — the two the engine made unambiguous — are projected, and
/// they are the same states the events would have produced.
#[test]
fn the_endings_a_snapshot_can_state_are_projected() {
    let rows = [
        (SessionState::Cancelled, "cancelled"),
        (SessionState::Failed, "failed"),
    ];
    for (state, expected) in rows {
        let mut projection = projection();
        let ours = first_instance();
        projection.install(&ours);

        projection.observe(&snapshot(&ours, "ses_1", Some("run-1"), 2, state, &[]));

        assert_eq!(
            state_of(&projection, &key(&ours, "ses_1", "run-1")),
            expected
        );
    }
}

/// A permission's *release* is not an event either (§6.1), so the host reports it. The id has to
/// match: an answer to a request the prompt list has since replaced must not clear a wait on a
/// different one.
#[test]
fn an_answered_permission_releases_the_wait_and_only_its_own() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&permission(&ours, "ses_1", "run-1", 1, "req-1"));

    assert!(
        projection
            .answered(&ours, "ses_1", "run-1", "req-other")
            .is_none(),
        "another request's answer is not this request's"
    );
    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "waiting-input"
    );

    let released = projection
        .answered(&ours, "ses_1", "run-1", "req-1")
        .expect("the wait on req-1 was this host's");
    assert_eq!(released.disposition, Disposition::Applied);
    let task = projection
        .task(&key(&ours, "ses_1", "run-1"))
        .expect("the run is still there");
    assert_eq!(task.state, PetTaskState::Working);
    assert_eq!(task.permission_request_id, None);
}

/// A snapshot from an instance this host is not serving is refused like any other frame from one:
/// the identity in a snapshot is a claim by one incarnation, not a fact about the session.
#[test]
fn a_snapshot_from_another_instance_is_refused() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    let stranger = crate::support::identity(
        crate::support::AGENT,
        crate::support::VAULT,
        "epoch-elsewhere",
    );

    let ingest = projection.observe(&snapshot(
        &stranger,
        "ses_1",
        Some("run-1"),
        1,
        SessionState::Running,
        &[],
    ));

    assert_eq!(ingest.disposition, Disposition::Foreign);
    assert_eq!(task_count(&projection), 0);
}
