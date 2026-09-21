//! What a window reads, and when a fact is news.
//!
//! The projection is written before the emit and the emit is best-effort, so the read is the truth
//! and the push is the optimisation. These cases hold both halves: the list a window finds after the
//! facts a real host applies, and the frames that must *not* produce a push — a replayed sequence, a
//! foreign instance's frame, a work frame for a run that already ended, and an answer to a request
//! the task no longer holds.

use crate::support::{envelope, identity, running, SESSION};
use nekowite_lib::agent_runtime::events::AgentEventKind;
use nekowite_lib::desktop_pet::task_projection::PetTaskState;
use serde_json::json;

#[test]
fn a_window_reads_the_task_its_host_started() {
    let tasks = running().read().expect("the lock is fresh");

    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].key.run_id, "run-0");
    assert_eq!(tasks[0].key.session_id, SESSION);
    assert_eq!(tasks[0].state, PetTaskState::Working);
}

#[test]
fn a_push_happens_when_a_fact_changed_the_list() {
    let feed = running();

    let pushed = feed
        .apply(&envelope(
            &identity("epoch-1"),
            Some("run-0"),
            1,
            AgentEventKind::RunFinished,
            json!({ "stopReason": "end-turn" }),
        ))
        .expect("the lock is fresh");

    // The whole list, not a delta: a window that missed one frame is stale for a frame rather
    // than wrong for ever, and the first delivery needs no replay machinery.
    let tasks = pushed.expect("a run ending is a change");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].state, PetTaskState::TurnFinished);
}

#[test]
fn a_replayed_frame_is_not_pushed_twice() {
    let feed = running();
    let frame = envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::PermissionRequest,
        json!({ "requestId": "req-1" }),
    );

    assert!(
        feed.apply(&frame).expect("the lock is fresh").is_some(),
        "the first frame is news"
    );
    assert!(
        feed.apply(&frame).expect("the lock is fresh").is_none(),
        "the same sequence again is not: §6.3's 「重放去重」, one layer below the ledger"
    );
    // And the task is still the one the first frame left, with the request it was waiting on.
    let tasks = feed.read().expect("the lock is fresh");
    assert_eq!(tasks[0].state, PetTaskState::WaitingInput);
    assert_eq!(tasks[0].permission_request_id.as_deref(), Some("req-1"));
}

#[test]
fn a_frame_from_an_instance_this_host_never_started_is_not_pushed() {
    let feed = running();

    let pushed = feed
        .apply(&envelope(
            &identity("epoch-9"),
            Some("run-0"),
            1,
            AgentEventKind::RunFinished,
            json!({ "stopReason": "end-turn" }),
        ))
        .expect("the lock is fresh");

    assert!(
        pushed.is_none(),
        "a foreign instance's frame changes nothing"
    );
    assert_eq!(
        feed.read().expect("the lock is fresh")[0].state,
        PetTaskState::Working,
        "and the run it named is still running here"
    );
}

#[test]
fn an_ending_is_not_revived_and_is_not_pushed_as_one() {
    let feed = running();
    let finished = envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::RunFinished,
        json!({ "stopReason": "end-turn" }),
    );
    assert!(feed.apply(&finished).expect("the lock is fresh").is_some());

    // A later *work* frame for the same run, with a sequence the host has not seen: only the
    // settled check can refuse it, and if that check were gone this would push a `working` task
    // over a run that had ended — the reminder lost, not duplicated.
    let pushed = feed
        .apply(&envelope(
            &identity("epoch-1"),
            Some("run-0"),
            2,
            AgentEventKind::PermissionRequest,
            json!({ "requestId": "req-2" }),
        ))
        .expect("the lock is fresh");
    assert!(pushed.is_none());
    assert_eq!(
        feed.read().expect("the lock is fresh")[0].state,
        PetTaskState::TurnFinished
    );
}

#[test]
fn an_answer_releases_the_wait_and_is_pushed() {
    let feed = running();
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::PermissionRequest,
        json!({ "requestId": "req-1" }),
    ))
    .expect("the lock is fresh");

    let pushed = feed
        .answered(&identity("epoch-1"), SESSION, "req-1")
        .expect("the lock is fresh");

    let tasks = pushed.expect("the run stopped waiting on it");
    assert_eq!(tasks[0].state, PetTaskState::Working);
    assert_eq!(tasks[0].permission_request_id, None);

    // A second answer to the same request changes nothing: the task no longer holds it, and
    // §6.2's 「过期请求按钮不能继续操作」 is the same rule one layer up.
    assert!(feed
        .answered(&identity("epoch-1"), SESSION, "req-1")
        .expect("the lock is fresh")
        .is_none());
}

#[test]
fn an_answer_to_another_sessions_request_does_not_touch_this_task() {
    let feed = running();
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::PermissionRequest,
        json!({ "requestId": "req-1" }),
    ))
    .expect("the lock is fresh");

    let pushed = feed
        .answered(&identity("epoch-1"), "ses-other", "req-1")
        .expect("the lock is fresh");

    assert!(pushed.is_none());
    assert_eq!(
        feed.read().expect("the lock is fresh")[0].state,
        PetTaskState::WaitingInput
    );
}

#[test]
fn stopping_the_instance_restates_what_it_was_running_and_pushes_it() {
    let feed = running();

    let pushed = feed
        .retire(&identity("epoch-1"))
        .expect("the lock is fresh");

    let tasks = pushed.expect("a run in flight is restated");
    assert_eq!(tasks[0].state, PetTaskState::Interrupted);
}

#[test]
fn a_new_instance_restates_the_previous_ones_run() {
    let feed = running();

    // A restart is a new epoch for the same triple, which is proof the old incarnation is over
    // rather than a guess (`registry::LiveInstances::claim` refuses a second live one).
    let pushed = feed
        .install(&identity("epoch-2"))
        .expect("the lock is fresh");

    let tasks = pushed.expect("the previous run cannot still be running");
    assert_eq!(tasks[0].state, PetTaskState::Interrupted);
    assert_eq!(
        feed.read().expect("the lock is fresh")[0].key.runtime_epoch,
        "epoch-1",
        "the task keeps the epoch it ran under: it is the retired instance's record, and the new \
         one's frames will file under their own"
    );
}

#[test]
fn the_record_survives_a_push_that_nobody_heard() {
    // The ordering rule, made an assertion: the frame is applied to the projection before it is
    // ever published, so a window that was hidden, closed, or not yet mounted finds the task on
    // its next read. Nothing here can observe the emit (there is no app in this target), which is
    // exactly the case being asserted — a lost push must not be a lost task.
    let feed = running();
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::RunFinished,
        json!({ "stopReason": "refusal" }),
    ))
    .expect("the lock is fresh");

    let read = feed.read().expect("the lock is fresh");
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].state, PetTaskState::Refused);
}
