//! Several runs at once, and the four rules §6.3 puts on how one ends.
//!
//! §6.3 asks for three things that are each a way of *not* collapsing tasks: every task stays on
//! the list, a terminal state is not revived by a later work frame, and a later turn is a new run
//! rather than a reopening. The last rule is the one that costs something to keep — a
//! conversation's second turn looks exactly like its first from here, and the only thing making it
//! a second task is that the host minted a second run id.

use crate::desktop_pet::task_projection::Disposition;
use crate::support::{
    chatter, finished, first_instance, key, other_instance, permission, projection, state_of,
    task_count,
};

use std::sync::atomic::Ordering;

/// The 多任务 clause, at its plainest: three runs, two sessions, two engines, three rows.
#[test]
fn three_runs_of_two_sessions_across_two_engines_are_three_tasks() {
    let mut projection = projection();
    let ours = first_instance();
    let theirs = other_instance();
    projection.install(&ours);
    projection.install(&theirs);
    projection.started(&ours, "ses_1", "run-1");
    projection.started(&ours, "ses_2", "run-2");
    projection.started(&theirs, "ses_2", "run-3");

    assert_eq!(task_count(&projection), 3);
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "working");
    assert_eq!(state_of(&projection, &key(&ours, "ses_2", "run-2")), "working");
    assert_eq!(state_of(&projection, &key(&theirs, "ses_2", "run-3")), "working");
}

/// §6.3 「同一任务后续轮次须有新 runId」: the second turn of one conversation is a second task, and
/// the first keeps the ending it had.
#[test]
fn a_second_turn_of_one_session_is_a_second_task() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&finished(&ours, "ses_1", "run-1", 1, "end-turn"));

    projection.started(&ours, "ses_1", "run-2");

    assert_eq!(task_count(&projection), 2);
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "turn-finished");
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-2")), "working");
}

/// §6.3's 「终态不能被旧工作事件复活」. The frame here is not a replay — it carries a sequence this
/// host has never seen — so the only thing refusing it is the settled state itself.
#[test]
fn a_settled_run_is_not_revived_by_a_later_work_frame() {
    let (mut projection, clock) = crate::support::projection_with_clock();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&finished(&ours, "ses_1", "run-1", 1, "end-turn"));
    let ended_at = projection
        .task(&key(&ours, "ses_1", "run-1"))
        .map(|task| task.updated_at);

    clock.store(5_000, Ordering::SeqCst);
    let ingest = projection.apply(&permission(&ours, "ses_1", "run-1", 2, "req-1"));

    assert_eq!(ingest.disposition, Disposition::Settled);
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "turn-finished");
    assert_eq!(
        projection
            .task(&key(&ours, "ses_1", "run-1"))
            .map(|task| task.updated_at),
        ended_at,
        "a refused frame does not restamp the task"
    );
    assert_eq!(
        projection
            .task(&key(&ours, "ses_1", "run-1"))
            .and_then(|task| task.permission_request_id.clone()),
        None
    );
}

/// §11's 「取消后迟到完成」: the cancel is what the user did, and the turn's own completion frame
/// arrives after it. Reading the late frame as the ending would turn the user's own stop into a
/// success they never got.
#[test]
fn a_late_completion_after_a_cancellation_does_not_undo_it() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&finished(&ours, "ses_1", "run-1", 1, "cancelled"));

    let late = projection.apply(&finished(&ours, "ses_1", "run-1", 2, "end-turn"));

    assert_eq!(late.disposition, Disposition::Settled);
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "cancelled");
}

/// §6.3's 「runId 复用拒绝」, which is the settled rule seen from the other side: a run id that
/// comes back is not a new run, so it is refused rather than reopened. The host's counter never
/// reuses one — this is the frame that says what would happen if it did, or if a queue replayed a
/// persisted envelope after a restart.
#[test]
fn a_reused_run_id_is_refused_rather_than_revived() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&finished(&ours, "ses_1", "run-1", 1, "refusal"));

    let reused = projection.started(&ours, "ses_1", "run-1");

    assert_eq!(reused.disposition, Disposition::Settled);
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "refused");
    assert_eq!(task_count(&projection), 1);
}

/// §6.2's ceiling rows, and the prohibition that goes with them: a run that reached a limit gets
/// attention and no celebration, so it is `stopped` and never `turn-finished`.
#[test]
fn a_run_that_hit_a_ceiling_is_stopped_and_not_finished() {
    for reason in ["max-tokens", "max-turn-requests"] {
        let mut projection = projection();
        let ours = first_instance();
        projection.install(&ours);
        projection.started(&ours, "ses_1", "run-1");

        projection.apply(&finished(&ours, "ses_1", "run-1", 1, reason));

        assert_eq!(
            state_of(&projection, &key(&ours, "ses_1", "run-1")),
            "stopped",
            "{reason} is a limit reached, not a turn achieved"
        );
    }
}

/// §3.1.2, which is the reason this module has no expiry at all. Upstream removes a working
/// session that has been quiet for five minutes (`state.ts:36-38`, `:126-133`); silence is not a
/// fact about a task, so here the clock moving is the only thing that changes.
#[test]
fn silence_neither_completes_nor_removes_a_task() {
    let (mut projection, clock) = crate::support::projection_with_clock();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");

    clock.store(1_000 + 6 * 60 * 60 * 1_000, Ordering::SeqCst);
    let ingest = projection.apply(&chatter(&ours, "ses_1", "run-1", 1));

    assert_eq!(ingest.disposition, Disposition::NoChange);
    assert_eq!(task_count(&projection), 1, "six quiet hours are not an ending");
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "working");
}

/// The clock the wiring passes when a caller has no reason to control time — and the one thing
/// about it that can be wrong without anything failing here: its **unit**.
///
/// `updated_at` is compared against other epoch-millisecond timestamps on the other side of the
/// boundary (`pet-task-view.ts` subtracts it to decide whether a completion is still news), so a
/// clock answering seconds or nanoseconds would not break a test in this file — it would make the
/// character hold a completed pose for a thousand years, or for none.
#[test]
fn the_host_clock_is_in_epoch_milliseconds() {
    use crate::desktop_pet::task_projection::system_clock;

    let now = system_clock()();
    assert!(
        now > 1_600_000_000_000,
        "a clock in seconds reads {now}, which is 1970 in milliseconds"
    );
    assert!(now < 100_000_000_000_000, "and one in nanoseconds reads {now}");
}

/// §6.3's sequence rule, from the projection's side: applying a frame twice is not a policy choice
/// this layer is entitled to make, so a repeated sequence is reported rather than applied.
#[test]
fn a_replayed_sequence_is_not_applied_twice() {
    let (mut projection, clock) = crate::support::projection_with_clock();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    let frame = permission(&ours, "ses_1", "run-1", 1, "req-1");
    projection.apply(&frame);
    let first_stamp = projection
        .task(&key(&ours, "ses_1", "run-1"))
        .map(|task| task.updated_at);

    clock.store(7_000, Ordering::SeqCst);
    let again = projection.apply(&frame);

    assert_eq!(again.disposition, Disposition::Replayed);
    assert_eq!(
        projection
            .task(&key(&ours, "ses_1", "run-1"))
            .map(|task| task.updated_at),
        first_stamp,
        "and the task does not move in the list because a frame arrived twice"
    );
}

/// §6.3's 「发现缺口」: a hole in the stream is reported, not stitched over. A ledger that cannot
/// see the gap cannot decide to restore from a snapshot for it.
#[test]
fn a_gap_in_the_stream_is_reported_and_not_repaired() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&chatter(&ours, "ses_1", "run-1", 1));
    projection.apply(&chatter(&ours, "ses_1", "run-1", 2));

    let ingest = projection.apply(&finished(&ours, "ses_1", "run-1", 5, "end-turn"));

    assert_eq!(ingest.order.sequence, 5);
    assert_eq!(ingest.order.missing, vec![3, 4]);
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "turn-finished");
}

/// A frame that carried no sequence on this session's stream is not a gap: the first frame a
/// session publishes has nothing behind it to be missing.
#[test]
fn the_first_frame_of_a_session_reports_no_gap() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");

    let ingest = projection.apply(&finished(&ours, "ses_1", "run-1", 1, "end-turn"));

    assert!(ingest.order.missing.is_empty());
}

/// A refused frame does not consume its sequence number. The check order is the point: a frame
/// this host will not apply must not leave a mark on the stream either, or the next real frame
/// would be reported as a hole that never existed — and the ledger would restore a snapshot for
/// it.
#[test]
fn a_refused_frame_does_not_consume_its_sequence() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.apply(&chatter(&ours, "ses_1", "run-1", 1));
    projection.apply(&chatter(&ours, "ses_1", "run-1", 2));

    // Belongs to no turn, so it is refused before anything about it is remembered.
    let refused = projection.apply(&crate::support::envelope(
        &ours,
        "ses_1",
        None,
        3,
        nekowite_lib::agent_runtime::events::AgentEventKind::CommandsChanged,
        serde_json::json!({ "commands": [] }),
    ));
    assert_eq!(refused.disposition, Disposition::Foreign);

    let ingest = projection.apply(&chatter(&ours, "ses_1", "run-1", 3));

    assert_eq!(
        ingest.disposition,
        Disposition::NoChange,
        "a text chunk is not a replay: sequence 3 was still free"
    );
    assert!(
        ingest.order.missing.is_empty(),
        "no gap was left by the frame that was refused"
    );
}
