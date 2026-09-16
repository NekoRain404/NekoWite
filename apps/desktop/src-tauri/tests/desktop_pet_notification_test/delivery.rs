//! 投递失败 must be visible rather than silent.
//!
//! Upstream calls `sendNotification` inside `try { … } catch {}`
//! (`references/desktop-pet/windows/src/main.ts:441`) and checks its permission once, at startup,
//! with a second swallowed `catch` (`:404-407`). A user whose session has no notification daemon, or
//! who revoked the permission afterwards, is simply never told — and nothing anywhere says so.
//!
//! The rule this file holds is the codebase's standing one: an operation that cannot complete says
//! so. A notice that failed is a distinct outcome, the row it was about stays unread, the ledger
//! writes down that the attempt failed, and nothing quietly tries again (§6.3's at-most-once).

use crate::desktop_pet::history::{DeliveryState, TaskHistory};
use crate::desktop_pet::notification_delivery::{DeliveryFailure, NoChannel, NotificationDelivery, PetNotice};
use crate::desktop_pet::notification_policy::{NotificationPolicy, NotificationPreferences};
use crate::desktop_pet::task_projection::PetTaskState;
use crate::support::{delivered, gathering, key, policy, refused, RecordingChannel, Stream};

fn refusal(kind: &str) -> DeliveryFailure {
    match kind {
        "no-channel" => DeliveryFailure::NoChannel {
            detail: "no daemon".to_string(),
        },
        "refused" => DeliveryFailure::Refused {
            detail: "the desktop said no".to_string(),
        },
        _ => DeliveryFailure::Channel {
            detail: "the daemon answered with an error".to_string(),
        },
    }
}

#[test]
fn a_channel_that_cannot_deliver_says_so() {
    let channel = RecordingChannel::new();
    channel.refuse_with(refusal("channel"));
    let mut policy = policy(&channel);
    let stream = Stream::new();

    let outcome = policy.observe(stream.at(&key("run-1"), PetTaskState::Failed, 1_000));
    let (notice, failure) = refused(&outcome);

    assert_eq!(notice.state, PetTaskState::Failed);
    assert_eq!(failure.kind(), "channel");
    // The outcome is the *only* place the truth can hide: a delivery that failed is not a delivery,
    // so there is no arm for it to be reported as one.
    assert!(!matches!(outcome, crate::desktop_pet::notification_policy::NotificationOutcome::Delivered(_)));
}

#[test]
fn a_failed_delivery_leaves_the_row_unread_and_marked_failed() {
    let channel = RecordingChannel::new();
    channel.refuse_with(refusal("no-channel"));
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.at(&task, PetTaskState::Failed, 1_000));

    let row = policy.history().get(&task).expect("the row was written first");
    assert_eq!(row.delivery, DeliveryState::Failed, "§6.3: 投递失败不伪装成功");
    assert!(row.unread, "what the user still has is the row");
    assert_eq!(policy.unread().len(), 1);
}

#[test]
fn a_failed_delivery_is_not_tried_again() {
    let channel = RecordingChannel::new();
    channel.refuse_with(refusal("channel"));
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.at(&task, PetTaskState::Failed, 1_000));
    assert_eq!(channel.attempts(), 1);

    // §6.3 chooses at-most-once on purpose: 「系统通知投递和持久化无法保证原子恰好一次…采用先记录再投递的
    // 至多一次尝试，崩溃空窗可能漏外部提示，但未读列表可恢复」. A retry loop would be a second policy
    // about a channel the ledger cannot see, so the tick does not ask again.
    assert!(policy.flush_due(60_000).is_none());
    let _ = policy.observe(stream.at(&task, PetTaskState::Failed, 2_000));
    assert_eq!(channel.attempts(), 1, "no retry, and no second attempt for a repeat");

    let row = policy.history().get(&task).expect("recorded");
    assert_eq!(row.delivery, DeliveryState::Failed);
}

#[test]
fn a_delivered_notice_is_recorded_as_delivered() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.at(&task, PetTaskState::Failed, 1_000));

    let row = policy.history().get(&task).expect("recorded");
    assert_eq!(row.delivery, DeliveryState::Delivered);
    assert!(
        row.unread,
        "whether the toast appeared is not whether the user has looked"
    );
}

#[test]
fn a_channel_that_starts_failing_is_reported_from_then_on() {
    let channel = RecordingChannel::new();
    let mut policy = policy(&channel);
    let stream = Stream::new();

    let _ = policy.observe(stream.at(&key("run-1"), PetTaskState::Failed, 1_000));
    assert_eq!(channel.attempts(), 1);

    channel.refuse_with(refusal("refused"));
    let outcome = policy.observe(stream.at(&key("run-2"), PetTaskState::Failed, 2_000));
    let (_, failure) = refused(&outcome);
    assert_eq!(failure.kind(), "refused");
}

#[test]
fn the_build_with_no_channel_fails_visibly_rather_than_pretending() {
    // The channel the app actually runs with today (the ledger holds the notification plugin back
    // until it has been measured), and the point is that a build without one behaves like a channel
    // that failed rather than like a notification that was shown.
    let mut channel = NoChannel::new();
    let notice = PetNotice {
        state: PetTaskState::TurnFinished,
        count: 1,
        target: Some(key("run-1")),
        permission_request_id: None,
        label: None,
        sound: true,
    };

    let failure = channel
        .deliver(&notice)
        .expect_err("a build with no channel cannot deliver");
    assert_eq!(failure.kind(), "no-channel");
    assert!(
        failure_detail(&failure).contains("unread"),
        "§7.2: an unavailable capability states what happens instead — {failure:?}"
    );
}

#[test]
fn a_policy_with_no_channel_still_owes_the_user_the_row() {
    let mut policy = NotificationPolicy::new(
        Box::new(NoChannel::new()),
        NotificationPreferences::default(),
        TaskHistory::new(),
    );
    let stream = Stream::new();
    let task = key("run-1");

    let outcome = policy.observe(stream.at(&task, PetTaskState::Failed, 1_000));
    let (_, failure) = refused(&outcome);

    assert_eq!(failure.kind(), "no-channel");
    assert_eq!(policy.unread().len(), 1);
    assert_eq!(
        policy.history().get(&task).map(|row| row.delivery),
        Some(DeliveryState::Failed)
    );
}

#[test]
fn a_burst_that_cannot_be_shown_keeps_every_row_it_stood_for() {
    let channel = RecordingChannel::new();
    channel.refuse_with(refusal("channel"));
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let first = key("run-1");
    let second = key("run-2");

    let _ = policy.observe(stream.at(&first, PetTaskState::TurnFinished, 1_000));
    let (_, due_at_ms) = gathering(&policy.observe(stream.at(&second, PetTaskState::TurnFinished, 1_100)));
    let outcome = policy.flush_due(due_at_ms).expect("the burst was due");
    let (notice, _) = refused(&outcome);

    assert_eq!(notice.count, 2);
    assert_eq!(channel.attempts(), 1, "one notice, one attempt, however many it stood for");
    assert_eq!(policy.unread().len(), 2);
    for row in policy.unread() {
        assert_eq!(row.delivery, DeliveryState::Failed);
    }
}

#[test]
fn a_notice_that_fails_still_keeps_the_request_it_routes_to() {
    let channel = RecordingChannel::new();
    channel.refuse_with(refusal("no-channel"));
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let task = key("run-1");

    let _ = policy.observe(stream.asking(&task, "req-1", 1_000));

    // §6.2: the pet does not authorise, and the id is the only thing a click has to go on. A failed
    // notice must not take the routing with it.
    assert_eq!(
        policy.unread()[0].permission_request_id.as_deref(),
        Some("req-1")
    );
}

#[test]
fn the_three_ways_a_channel_can_fail_are_told_apart() {
    for kind in ["no-channel", "refused", "channel"] {
        assert_eq!(refusal(kind).kind(), kind);
    }

    let channel = RecordingChannel::new();
    channel.refuse_with(refusal("refused"));
    let mut policy = policy(&channel);
    let stream = Stream::new();
    let _ = policy.observe(stream.at(&key("run-1"), PetTaskState::Failed, 1_000));

    // And a channel that recovers is believed again, with no state carried over from the failure.
    channel.accept();
    let notice = delivered(&policy.observe(stream.at(&key("run-2"), PetTaskState::Failed, 2_000)));
    assert_eq!(notice.state, PetTaskState::Failed);
    assert_eq!(channel.count(), 1, "the channel is believed again once it answers");
}

fn failure_detail(failure: &DeliveryFailure) -> &str {
    match failure {
        DeliveryFailure::NoChannel { detail }
        | DeliveryFailure::Refused { detail }
        | DeliveryFailure::Channel { detail } => detail,
    }
}
