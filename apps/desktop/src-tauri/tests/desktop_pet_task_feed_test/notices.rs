//! §6.3's ledger, reached the way the app reaches it.
//!
//! `notification_delivery.rs` takes its channel through a port (§10.2), and the cases below use that
//! to substitute the one thing this machine cannot provide while leaving everything else real: the
//! frame is a runtime frame, the projection is the one the app holds, the ledger is the one
//! `PetTaskFeed::new` builds, and only the channel is a double. What they assert is the wiring —
//! that a completion reaches a channel at all, that the switches decide, and that the row the user
//! keeps is written before the channel is asked.

use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::support::{
    due, ending, envelope, feed_running, feed_with, identity, Recording, SESSION,
};
use nekowite_lib::agent_runtime::events::AgentEventKind;
use nekowite_lib::desktop_pet::task_projection::PetTaskState;
use nekowite_lib::desktop_pet::{
    DeliveryState, NotificationOutcome, NotificationPreferences, PET_TASKS_CHANNEL,
};

#[test]
fn a_completion_reaches_the_channel_and_the_row_says_so() {
    let channel = Recording::new();
    let feed = feed_running(&channel);
    ending(&feed, "run-0", 1);

    // §6.3 merges a burst of completions into one notice, so what goes out is what the window's
    // close produces — and the wake is the host's to make, so the test flushes at the ledger's own
    // due time rather than sleeping for it.
    let due = due(&feed);
    let outcome = feed
        .flush_notices(due)
        .expect("the lock is fresh")
        .expect("the burst was due");

    assert!(matches!(outcome, NotificationOutcome::Delivered(_)));
    let notices = channel.notices();
    assert_eq!(notices.len(), 1, "one completion is one notice");
    assert_eq!(notices[0].state, PetTaskState::TurnFinished);
    assert_eq!(
        notices[0]
            .target
            .as_ref()
            .map(|key| (key.session_id.as_str(), key.run_id.as_str())),
        Some((SESSION, "run-0")),
        "the notice names the run a click has to return to"
    );

    // And the user's own record of it, which is what survives a notice that nobody saw.
    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].delivery, DeliveryState::Delivered);
    assert!(
        rows[0].unread,
        "a notice the user has not looked at is still owed"
    );
}

#[test]
fn a_delivery_that_failed_keeps_the_row_unread_and_says_so() {
    // §6.3's 先记录再投递, as an assertion rather than a comment. The row is written before the
    // channel is asked, so a channel that cannot show the notice loses the toast and never the fact
    // — and the failure is recorded rather than reported as a success. Written the other way round
    // (deliver, then record) this case fails on the first row assertion, which is the failure the
    // ordering exists to prevent: a task marked delivered but never shown is lost.
    let channel = Recording::refusing();
    let feed = feed_running(&channel);
    ending(&feed, "run-0", 1);

    let outcome = feed
        .flush_notices(due(&feed))
        .expect("the lock is fresh")
        .expect("the burst was due");

    let NotificationOutcome::DeliveryFailed { failure, .. } = &outcome else {
        panic!("a refusing channel cannot have delivered: {outcome:?}");
    };
    assert_eq!(failure.kind(), "no-channel");
    assert!(channel.notices().is_empty(), "nothing was shown");

    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1, "the row is what the user still has");
    assert_eq!(rows[0].delivery, DeliveryState::Failed);
    assert_eq!(rows[0].state, PetTaskState::TurnFinished);
    assert!(rows[0].unread, "a failed delivery is not a seen one");
}

#[test]
fn nothing_leaves_before_the_burst_window_closes() {
    let channel = Recording::new();
    let feed = feed_running(&channel);
    ending(&feed, "run-0", 1);
    let due = due(&feed);

    assert!(
        feed.flush_notices(due - 1)
            .expect("the lock is fresh")
            .is_none(),
        "the burst is still gathering"
    );
    assert!(channel.notices().is_empty());

    assert!(feed
        .flush_notices(due)
        .expect("the lock is fresh")
        .is_some());
    assert_eq!(channel.notices().len(), 1);
}

#[test]
fn the_switch_the_settings_page_writes_decides_the_notice() {
    // §5.2: a switch the page writes and nothing reads is a control that does nothing. The ledger is
    // what reads it, and this is that read reaching the user's own settings.
    let channel = Recording::new();
    let feed = feed_with(
        &channel,
        NotificationPreferences {
            on_turn_finished: false,
            ..NotificationPreferences::default()
        },
    );
    feed.install(&identity("epoch-1"))
        .expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-0")
        .expect("the lock is fresh");
    ending(&feed, "run-0", 1);

    // Nothing is gathering to flush, and that is the switch working: the burst is dropped at the
    // channel check rather than held for a delivery that will never be asked for.
    assert_eq!(
        feed.notifications()
            .expect("the ledger's lock is fresh")
            .pending_due(),
        None
    );
    assert!(
        channel.notices().is_empty(),
        "the user asked not to be told"
    );

    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1, "silence is not a lost task (§6.3's 未读)");
    assert_eq!(rows[0].delivery, DeliveryState::NotAttempted);
}

#[test]
fn a_burst_asks_the_host_for_one_wake_at_the_ledgers_own_due_time() {
    // The wake is how the host comes back when a burst closes, and it is a callback rather than a
    // tick: the feed has no timer, and one wake per burst is what keeps a burst of ends from being a
    // timer per end. The due time is the ledger's, so the host never keeps a second copy of the
    // coalescing window.
    let channel = Recording::new();
    let feed = feed_with(&channel, NotificationPreferences::default());
    let asked = Arc::new(Mutex::new(Vec::<i64>::new()));
    let sink = Arc::clone(&asked);
    feed.set_notice_waker(move |due_at_ms| sink.lock().expect("the lock is fresh").push(due_at_ms));

    feed.install(&identity("epoch-1"))
        .expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-0")
        .expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-1")
        .expect("the lock is fresh");
    ending(&feed, "run-0", 1);
    let first = due(&feed);
    ending(&feed, "run-1", 2);

    assert_eq!(
        *asked.lock().expect("the lock is fresh"),
        vec![first],
        "two completions in one window are one notice, so the host is asked once"
    );

    // And the request is not sticky: a burst that is delivered, followed by another one, is asked
    // for again. The two due times can be equal — they are host milliseconds and this test runs in
    // less than one — which is the point: what is asked for is the ledger's number, whatever it is.
    feed.started(&identity("epoch-1"), SESSION, "run-2")
        .expect("the lock is fresh");
    feed.flush_notices(first).expect("the lock is fresh");
    ending(&feed, "run-2", 3);
    assert_eq!(
        *asked.lock().expect("the lock is fresh"),
        vec![first, due(&feed)]
    );
}

#[test]
fn a_run_the_runtime_left_behind_is_announced() {
    // `install`/`retire` restate what an incarnation was running as `interrupted`, and §6.2's last
    // row is a reminder rather than a silence: the work was cut off, and the user is told. The fact
    // comes off no stream — the host reports it — which is why the ledger is handed a zero sequence
    // rather than a number from a stream that has no frame for this.
    let channel = Recording::new();
    let feed = feed_running(&channel);

    feed.install(&identity("epoch-2"))
        .expect("the lock is fresh");

    let notices = channel.notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].state, PetTaskState::Interrupted);
    assert_eq!(
        notices[0].target.as_ref().map(|key| key.run_id.as_str()),
        Some("run-0")
    );

    let ledger = feed.notifications().expect("the ledger's lock is fresh");
    let rows = ledger.unread();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, PetTaskState::Interrupted);
    assert!(rows[0].unread);
}

#[test]
fn a_frame_the_window_already_has_is_not_a_fact_for_the_ledger() {
    // The dedup §6.3 asks for is the ledger's, but a *replayed* frame is a decision the projection
    // has already made — and the ledger must not be asked to take it again, because a second answer
    // to "is this news" is how one completion becomes two notices. Two frames here: the first is
    // news, the second is the same sequence again.
    let channel = Recording::new();
    let feed = feed_running(&channel);
    ending(&feed, "run-0", 1);
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some("run-0"),
        1,
        AgentEventKind::RunFinished,
        json!({ "stopReason": "end-turn" }),
    ))
    .expect("the lock is fresh");

    feed.flush_notices(due(&feed)).expect("the lock is fresh");

    assert_eq!(channel.notices().len(), 1, "one frame is one notice");
    assert_eq!(
        feed.notifications()
            .expect("the ledger's lock is fresh")
            .unread()
            .len(),
        1
    );
}

#[test]
fn the_channel_name_is_the_contracts_own() {
    // One spelling, two layers: the window listens on this string (`tauri-pet.ts`'s
    // `PET_TASKS_CHANNEL`) and the host publishes on it. A rename on one side alone is a list that
    // is complete and never updates, so the literal is pinned here rather than left to drift.
    assert_eq!(PET_TASKS_CHANNEL, "pet-task");
}
