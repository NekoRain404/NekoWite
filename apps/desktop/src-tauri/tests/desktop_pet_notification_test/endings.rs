//! 完成 / 等待 / 失败: what the notice says about a run that ended, for every way a run can end.
//!
//! §6.2's table is the specification and `pet-contracts/events.ts` already maps the protocol's five
//! stop reasons onto the pet's states. The cases here start from that mapping — read out of the
//! contract rather than restated — and assert what the *ledger* does with each state and what the
//! notice says, because the failures this guards against are not crashes: they are sentences that
//! are untrue about the user's own run.

use crate::desktop_pet::history::{PetTaskState, PET_TASK_STATES};
use crate::desktop_pet::notification_delivery::PetNotice;
use crate::desktop_pet::notification_policy::{
    channel_for, NotificationChannel, NotificationOutcome, SilenceReason,
};
use crate::support::{
    self, contract, delivered, flush, gathering, key, key_for, policy, silent, state_named,
    RecordingChannel, Stream,
};

/// Every stop reason the protocol has, and the state D1 maps it to — read from `events.ts`.
fn stop_reason_table() -> Vec<(String, String)> {
    let events = contract("pet-contracts/events.ts");
    let table = support::quoted_pairs(support::slice_between(
        &events,
        "PET_STATE_BY_STOP_REASON",
        "\n}",
    ));
    assert_eq!(
        table.len(),
        5,
        "the protocol has five stop reasons; the contract table lost one"
    );
    table
}

/// Drive one state through a fresh ledger, and return the notice it produced, if any.
fn notice_for(state: PetTaskState, at_ms: i64) -> Option<PetNotice> {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let outcome = policy.observe(stream.at(&key("run-1"), state, at_ms));
    match outcome {
        NotificationOutcome::Silent(_) => None,
        NotificationOutcome::Coalescing { due_at_ms, .. } => Some(flush(&mut policy, due_at_ms)),
        NotificationOutcome::Delivered(notice) => Some(notice),
        NotificationOutcome::DeliveryFailed { .. } => {
            panic!("the recording channel does not fail")
        }
    }
}

/// Words a notice may not use about a run that did not succeed.
///
/// §6.2 forbids exactly these claims: a ceiling is 「到达限制」 rather than a crash, a refusal is
/// 「无法继续」 rather than an error, and a lost runtime leaves the outcome unknown. The list is
/// deliberately blunt — it is meant to be hard to satisfy by rewording.
const UNTRUE_ABOUT_NOT_SUCCESS: [&str; 8] = [
    "success",
    "succeed",
    "complete",
    "done",
    "failed",
    "error",
    "crash",
    "finished",
];

#[test]
fn the_five_stop_reasons_do_not_collapse_into_success_and_failure() {
    // The table is the contract's; the expectations are this ledger's. A limit and a refusal keep
    // their own states and their own sentences, and a cancellation says nothing at all — that is
    // what "the last three are not errors" has to mean in code.
    for (reason, name) in stop_reason_table() {
        let state = state_named(&name);
        let notice = notice_for(state, 1_000);

        match name.as_str() {
            "turn-finished" => {
                let notice = notice.expect("a finished turn is announced");
                assert_eq!(notice.state, PetTaskState::TurnFinished, "{reason}");
            }
            "stopped" => {
                let notice = notice.expect("a limit is announced");
                assert_eq!(notice.state, PetTaskState::Stopped, "{reason}");
                assert_ne!(
                    notice.state,
                    PetTaskState::Failed,
                    "{reason} is a ceiling, not a failure"
                );
            }
            "refused" => {
                let notice = notice.expect("a refusal is announced");
                assert_eq!(notice.state, PetTaskState::Refused, "{reason}");
                assert_ne!(
                    notice.state,
                    PetTaskState::Failed,
                    "{reason} is the engine declining, not a failure"
                );
            }
            "cancelled" => {
                assert!(
                    notice.is_none(),
                    "{reason} is quiet: the user is the one who stopped it"
                );
            }
            other => panic!("{reason} maps to {other}, which this build does not know"),
        }
    }
}

#[test]
fn end_turn_says_the_turn_finished_and_nothing_more() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let (count, due_at_ms) = gathering(&policy.observe(stream.at(&task, PetTaskState::TurnFinished, 1_000)));
    assert_eq!(count, 1);
    assert_eq!(
        channel.count(),
        0,
        "a completion gathers for the burst window rather than firing per run"
    );

    let notice = flush(&mut policy, due_at_ms);
    assert_eq!(notice.state, PetTaskState::TurnFinished);
    assert_eq!(notice.count, 1);
    assert_eq!(notice.target.as_ref(), Some(&task), "a click has somewhere to go");
    assert!(notice.body().contains("finished"), "{}", notice.body());
    // §6.2: 「可提醒「本轮已完成」，不能据此承诺用户全部目标和文件写入均成功」.
    for word in ["success", "complete", "done", "all"] {
        assert!(!notice.body().contains(word), "{}: {word}", notice.body());
    }
}

#[test]
fn max_tokens_is_a_limit_reached_not_a_failure() {
    let notice = notice_for(PetTaskState::Stopped, 1_000).expect("a limit is announced");
    assert!(notice.body().contains("limit"), "{}", notice.body());
    for word in UNTRUE_ABOUT_NOT_SUCCESS {
        assert!(!notice.body().contains(word), "{}: {word}", notice.body());
    }
}

#[test]
fn max_turn_requests_is_the_same_limit_kind() {
    // Named on its own because it is the stop reason most easily mistaken for a crash: the engine
    // ran out of agent requests, which is exactly what it was told to do.
    let notice = notice_for(PetTaskState::Stopped, 1_000).expect("a limit is announced");
    assert_eq!(notice.state, PetTaskState::Stopped);
    assert_ne!(notice.state, PetTaskState::Failed);
    assert_ne!(notice.state, PetTaskState::Interrupted);
    assert!(notice.body().contains("limit"), "{}", notice.body());
}

#[test]
fn a_refusal_is_the_engine_declining_not_an_error() {
    let notice = notice_for(PetTaskState::Refused, 1_000).expect("a refusal is announced");
    assert!(notice.body().contains("declined"), "{}", notice.body());
    for word in UNTRUE_ABOUT_NOT_SUCCESS {
        assert!(!notice.body().contains(word), "{}: {word}", notice.body());
    }
}

#[test]
fn a_failed_run_goes_out_on_the_failure_channel() {
    let notice = notice_for(PetTaskState::Failed, 1_000).expect("a failure is announced");
    assert_eq!(notice.state, PetTaskState::Failed);
    assert!(notice.body().contains("failed"), "{}", notice.body());
    // §6.2 keeps the detail in the main panel; the notice says where to look rather than guessing.
    assert!(
        notice.body().contains("Open the task"),
        "{}",
        notice.body()
    );
}

#[test]
fn a_lost_runtime_says_the_outcome_is_unknown() {
    for state in [PetTaskState::Interrupted, PetTaskState::Unknown] {
        let notice = notice_for(state, 1_000).expect("a lost runtime is announced");
        assert!(notice.body().contains("unknown"), "{}", notice.body());
        for word in UNTRUE_ABOUT_NOT_SUCCESS {
            assert!(!notice.body().contains(word), "{state:?}: {word}");
        }
    }
}

#[test]
fn a_permission_request_asks_and_carries_what_it_is_about() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let notice = delivered(&policy.observe(stream.asking(&task, "req-1", 1_000)));
    assert_eq!(notice.state, PetTaskState::WaitingInput);
    assert_eq!(notice.permission_request_id.as_deref(), Some("req-1"));
    assert_eq!(notice.target.as_ref(), Some(&task));
    // §6.2: the pet does not authorise; the notice routes to the host's own permission UI, and the
    // id is the only thing it carries to get there.
    assert!(notice.body().contains("waiting"), "{}", notice.body());
}

#[test]
fn working_is_never_announced_and_never_recorded() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();

    for at_ms in [1_000, 2_000, 3_000] {
        let outcome = policy.observe(stream.at(&key("run-1"), PetTaskState::Working, at_ms));
        assert_eq!(silent(&outcome), SilenceReason::NothingToSay);
    }
    assert_eq!(channel.count(), 0);
    // §6.2: 「无百分比猜测，不因暂时无文本停止工作」. A task in flight is not news, and recording it
    // would make the ledger's bound turn over with progress rather than with endings.
    assert!(policy.history().is_empty());
    assert!(policy.unread().is_empty());
}

#[test]
fn a_settled_run_is_not_revived_by_a_later_working_event() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.at(&task, PetTaskState::TurnFinished, 1_000));
    let revived = policy.observe(stream.at(&task, PetTaskState::Working, 2_000));

    assert_eq!(silent(&revived), SilenceReason::NoRevival);
    let record = policy.history().get(&task).expect("the ending was recorded");
    assert_eq!(
        record.state,
        PetTaskState::TurnFinished,
        "a live event must not overwrite a terminal state in the ledger either"
    );
}

#[test]
fn an_unknown_task_can_still_be_settled_by_a_later_ending() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    // `unknown` admits the host does not know, so a later event that *does* know replaces it — the
    // one direction §6.3's no-revival rule must not block.
    let lost = delivered(&policy.observe(stream.at(&task, PetTaskState::Unknown, 1_000)));
    assert_eq!(lost.state, PetTaskState::Unknown);

    let (_, due_at_ms) = gathering(&policy.observe(stream.at(&task, PetTaskState::TurnFinished, 2_000)));
    let settled = flush(&mut policy, due_at_ms);
    assert_eq!(settled.state, PetTaskState::TurnFinished);
    assert_eq!(channel.count(), 2, "both facts were told, because both happened");
    assert_eq!(
        policy.history().get(&task).map(|row| row.state),
        Some(PetTaskState::TurnFinished)
    );
}

#[test]
fn one_task_finishing_while_another_works_is_still_announced() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let working = key_for("opencode", "session-busy", "run-1");
    let finishing = key_for("opencode", "session-done", "run-1");

    assert_eq!(
        silent(&policy.observe(stream.at(&working, PetTaskState::Working, 1_000))),
        SilenceReason::NothingToSay
    );
    let (count, due_at_ms) = gathering(&policy.observe(stream.at(&finishing, PetTaskState::TurnFinished, 1_100)));
    assert_eq!(count, 1);

    // §6.3: 「另一个任务执行中，已完成任务仍进入未读，不被聚合情绪吞掉」. The ledger's version of that is
    // that a busy session neither silences another task's notice nor keeps it out of the unread
    // list, which is why the aggregate mood is D4's to compute and not this file's to guess.
    let notice = flush(&mut policy, due_at_ms);
    assert_eq!(notice.target.as_ref(), Some(&finishing));
    assert_eq!(policy.unread().len(), 1);
    assert_eq!(policy.unread()[0].key, finishing);
}

#[test]
fn no_notice_this_ledger_sends_claims_more_than_the_run_did() {
    // Every state a notice can carry, rendered: the sweep is what makes the individual wording
    // assertions above hard to satisfy by rewording one sentence.
    let mut checked = 0;
    for name in PET_TASK_STATES {
        let state = state_named(name);
        let Some(notice) = notice_for(state, 1_000) else {
            continue;
        };
        checked += 1;
        let body = notice.body();
        for word in UNTRUE_ABOUT_NOT_SUCCESS {
            // The two words that are the truth about their own state: a failure may say it failed,
            // and a finished turn may say it finished — and may not say anything past that.
            if (state == PetTaskState::Failed && word == "failed")
                || (state == PetTaskState::TurnFinished && word == "finished")
            {
                continue;
            }
            assert!(!body.contains(word), "{name}: {body} says {word}");
        }
    }
    assert!(
        checked >= 6,
        "the sweep has to cover the endings a notice can carry, and it covered {checked}"
    );
}

#[test]
fn a_notice_is_silent_by_default_and_never_names_a_path() {
    let notice = notice_for(PetTaskState::TurnFinished, 1_000).expect("announced");
    assert_eq!(
        notice.title(),
        "NekoWite",
        "§6.3: the default title names neither a note nor a path"
    );
    assert!(notice.label.is_none());
    assert!(notice.sound, "the default asks to be heard as well as seen");
    assert_eq!(
        channel_for(PetTaskState::TurnFinished),
        Some(NotificationChannel::TurnFinished)
    );
}

#[test]
fn the_refusal_and_the_limit_are_announced_on_different_channels() {
    // The channels are what a switch silences, and the two must not be interchangeable: a user who
    // turned off limit notices has said nothing about a refusal, and vice versa.
    let stopped = notice_for(PetTaskState::Stopped, 1_000).expect("announced");
    let refused = notice_for(PetTaskState::Refused, 1_000).expect("announced");

    let stopped_channel = channel_for(PetTaskState::Stopped);
    let refused_channel = channel_for(PetTaskState::Refused);
    assert_eq!(stopped_channel, Some(NotificationChannel::Stopped));
    assert_eq!(refused_channel, Some(NotificationChannel::Failed));
    assert_ne!(stopped.state, refused.state);
}
