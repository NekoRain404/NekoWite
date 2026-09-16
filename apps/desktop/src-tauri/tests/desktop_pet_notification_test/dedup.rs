//! 去重, in both directions, because they are opposite failures.
//!
//! A ledger that deduplicates too eagerly drops the notice the user was waiting for; one that
//! deduplicates too weakly tells them four times that a run finished. So no case here asserts only
//! "one notice": each pair asserts the *positive* half too — that the second fact either produced its
//! own notice or was silenced for a reason that names what it was a repeat *of*.

use crate::desktop_pet::history::PetTaskState;
use crate::desktop_pet::notification_policy::{SilenceReason, COALESCE_WINDOW_MS};
use crate::support::{
    delivered, flush, gathering, key, key_for, policy, silent, RecordingChannel, Stream,
};

#[test]
fn the_same_ending_twice_is_announced_once() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let first = delivered(&policy.observe(stream.at(&task, PetTaskState::Stopped, 1_000)));
    assert_eq!(first.state, PetTaskState::Stopped);

    let second = policy.observe(stream.at(&task, PetTaskState::Stopped, 1_200));
    assert_eq!(
        silent(&second),
        SilenceReason::Duplicate,
        "the second report of the same ending is a repeat, not a new fact"
    );
    assert_eq!(channel.count(), 1);
}

#[test]
fn a_new_run_of_the_same_session_is_a_new_ending() {
    // §6.3: 「同一任务后续轮次须有新 runId」. The key includes the run, so the next turn of a session
    // is not deduplicated against the last one — which is the 漏提示 side of the same rule.
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();

    let _ = policy.observe(stream.at(&key("run-1"), PetTaskState::Stopped, 1_000));
    let second = delivered(&policy.observe(stream.at(&key("run-2"), PetTaskState::Stopped, 2_000)));

    assert_eq!(second.state, PetTaskState::Stopped);
    assert_eq!(channel.count(), 2);
    let notices = channel.notices();
    assert_ne!(
        notices[0].target, notices[1].target,
        "the two notices are about two different runs"
    );
}

#[test]
fn two_agents_sharing_a_session_id_are_two_tasks() {
    // Upstream keys its store on `` `${agent}:${session}` `` and then looks sessions up by
    // `endsWith(':${session}')` (`windows/src/state.ts:54,85-89`), so this pair is one entry there
    // and one of the two runs is silently mis-attributed. §6.1 forbids exactly that key.
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let first = key_for("opencode", "shared-session", "run-1");
    let second = key_for("claude", "shared-session", "run-1");

    let _ = policy.observe(stream.at(&first, PetTaskState::Failed, 1_000));
    let _ = policy.observe(stream.at(&second, PetTaskState::Failed, 1_100));

    assert_eq!(channel.count(), 2, "two agents are two tasks, whatever they named things");
    assert_eq!(policy.unread().len(), 2);
}

#[test]
fn the_same_run_in_another_vault_is_another_task() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let here = key("run-1");
    let mut elsewhere = key("run-1");
    elsewhere.vault_id = "vault-2".to_string();

    let _ = policy.observe(stream.at(&here, PetTaskState::Failed, 1_000));
    let _ = policy.observe(stream.at(&elsewhere, PetTaskState::Failed, 1_100));

    assert_eq!(
        channel.count(),
        2,
        "an event from the vault the user just left is about a different task"
    );
}

#[test]
fn a_frame_at_or_below_the_mark_is_a_replay() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.numbered(&task, PetTaskState::TurnFinished, 5, 1_000));
    let replayed = policy.observe(stream.numbered(&task, PetTaskState::Stopped, 3, 1_100));

    assert_eq!(silent(&replayed), SilenceReason::Replay);
    assert_eq!(
        policy.history().get(&task).map(|row| row.state),
        Some(PetTaskState::TurnFinished),
        "a frame the pet has already seen does not rewrite what it knows"
    );
}

#[test]
fn a_gap_is_reported_rather_than_stitched_over() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.numbered(&task, PetTaskState::TurnFinished, 1, 1_000));
    let news = policy.observe(stream.numbered(&task, PetTaskState::Stopped, 5, 2_000));

    // §6.3: the host sequence 「发现缺口」. A frame ahead of the mark is news and is delivered — the pet
    // cannot invent the frames it missed — but the hole is named rather than stitched over.
    assert_eq!(delivered(&news).state, PetTaskState::Stopped);
    let gaps = policy.gaps();
    assert_eq!(gaps.len(), 1);
    assert_eq!(gaps[0].missed, 3);
    assert_eq!(gaps[0].session, task.session());
}

#[test]
fn a_second_permission_request_is_a_second_question() {
    // §6.3: 「等待授权按任务键 + requestId 去重」 — the same run asking twice is two questions, and the
    // user has to see the second one.
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let first = delivered(&policy.observe(stream.asking(&task, "req-1", 1_000)));
    let second = delivered(&policy.observe(stream.asking(&task, "req-2", 5_000)));

    assert_eq!(first.permission_request_id.as_deref(), Some("req-1"));
    assert_eq!(second.permission_request_id.as_deref(), Some("req-2"));
    assert_eq!(channel.count(), 2);
}

#[test]
fn the_same_permission_request_repeated_is_one_question() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.asking(&task, "req-1", 1_000));
    // The second frame carries no request id at all — §6.2 allows a host that cannot say. It is
    // still the same question, so it is not a second notice, and the id the user has to answer with
    // has to survive it rather than being overwritten by the weaker report.
    let again = policy.observe(stream.numbered(&task, PetTaskState::WaitingInput, 9, 1_100));

    assert_eq!(
        silent(&again),
        SilenceReason::Duplicate,
        "a repeated report of the same request is not a second question"
    );
    assert_eq!(channel.count(), 1);
    assert_eq!(
        policy
            .history()
            .get(&task)
            .expect("recorded")
            .permission_request_id
            .as_deref(),
        Some("req-1"),
        "the routing id outlives a frame that could not carry it"
    );
}

#[test]
fn three_completions_in_one_window_are_one_notice_with_one_sound() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let first = key_for("opencode", "session-a", "run-1");
    let second = key_for("opencode", "session-b", "run-1");
    let third = key_for("opencode", "session-c", "run-1");

    let (count, due_at_ms) = gathering(&policy.observe(stream.at(&first, PetTaskState::TurnFinished, 1_000)));
    assert_eq!(count, 1);
    let (count, _) = gathering(&policy.observe(stream.at(&second, PetTaskState::TurnFinished, 1_500)));
    assert_eq!(count, 2);
    let (count, _) = gathering(&policy.observe(stream.at(&third, PetTaskState::TurnFinished, 2_500)));
    assert_eq!(count, 3);
    assert_eq!(channel.count(), 0, "nothing has gone out while the burst is open");

    let notice = flush(&mut policy, due_at_ms);
    assert_eq!(notice.count, 3);
    assert!(notice.body().contains('3'), "{}", notice.body());
    assert_eq!(channel.count(), 1, "§6.3: 同一批只播一次声音");
}

#[test]
fn completions_beyond_the_window_are_two_notices() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();

    let (_, first_due) = gathering(&policy.observe(stream.at(
        &key_for("opencode", "session-a", "run-1"),
        PetTaskState::TurnFinished,
        1_000,
    )));
    let first = flush(&mut policy, first_due);
    assert_eq!(first.count, 1);

    let (_, second_due) = gathering(&policy.observe(stream.at(
        &key_for("opencode", "session-b", "run-1"),
        PetTaskState::TurnFinished,
        1_000 + COALESCE_WINDOW_MS,
    )));
    let second = flush(&mut policy, second_due);

    assert_eq!(second.count, 1);
    assert_eq!(channel.count(), 2, "two separate moments are two notices");
}

#[test]
fn a_burst_that_has_not_closed_is_not_delivered_yet() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let (_, due_at_ms) = gathering(&policy.observe(stream.at(&task, PetTaskState::TurnFinished, 1_000)));
    assert!(policy.flush_due(due_at_ms - 1).is_none());
    assert_eq!(channel.count(), 0);
    assert!(policy.flush_due(due_at_ms).is_some());
    assert_eq!(channel.count(), 1);
}

#[test]
fn a_merged_notice_stands_for_no_single_task_but_every_row_is_kept() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let first = key_for("opencode", "session-a", "run-1");
    let second = key_for("opencode", "session-b", "run-1");

    let _ = policy.observe(stream.at(&first, PetTaskState::TurnFinished, 1_000));
    let (_, due_at_ms) = gathering(&policy.observe(stream.at(&second, PetTaskState::TurnFinished, 1_100)));
    let notice = flush(&mut policy, due_at_ms);

    // §7.2: a notice that stands for several tasks has no single one to open, so it offers no target
    // rather than one picked from the burst.
    assert_eq!(notice.target, None);
    assert_eq!(
        policy.unread().len(),
        2,
        "merging is about the toast; every task keeps its own row (§6.3)"
    );
    let rows: Vec<_> = policy.unread().iter().map(|row| row.key.clone()).collect();
    assert!(rows.contains(&first) && rows.contains(&second));
}

#[test]
fn a_run_that_moved_to_another_ending_is_told_again() {
    // Two different facts about one run are two facts, even when both are terminal: a run that
    // reported a lost runtime and was later found to have failed has changed what the user needs to
    // know, and silence here would be the 漏提示 half of the pair.
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.at(&task, PetTaskState::Interrupted, 1_000));
    let closed = delivered(&policy.observe(stream.at(&task, PetTaskState::Failed, 2_000)));

    assert_eq!(closed.state, PetTaskState::Failed);
    assert_eq!(channel.count(), 2);
}
