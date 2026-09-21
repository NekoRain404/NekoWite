//! The `notification` domain's switches as the same applied write reaches them: §6.3's ledger is
//! loaded once at startup, so the write path is the only place a switch can take effect while the
//! app runs.

use serde_json::json;

use nekowite_lib::commands::desktop_pet::apply_notification_switch;
use nekowite_lib::desktop_pet::notification_policy::SilenceReason;
use nekowite_lib::desktop_pet::settings::PetSettingsDomain;
use nekowite_lib::desktop_pet::task_projection::{PetTaskKey, PetTaskState};
use nekowite_lib::desktop_pet::{NotificationOutcome, PetTaskFeed, TaskFact};

use crate::support::record;

/// One ending, as §6.3's ledger observes it: a fresh run each time, so nothing here is a replay.
fn finished(feed: &PetTaskFeed, run: &str, sequence: u64) -> NotificationOutcome {
    let mut policy = feed.notifications().expect("the ledger's lock is fresh");
    policy.observe(TaskFact {
        key: PetTaskKey {
            agent_id: "opencode".to_string(),
            profile_id: "default".to_string(),
            runtime_epoch: "epoch-1".to_string(),
            vault_id: "vault-a".to_string(),
            session_id: "ses-1".to_string(),
            run_id: run.to_string(),
        },
        state: PetTaskState::TurnFinished,
        permission_request_id: None,
        sequence,
        at_ms: 1_000,
        label: None,
    })
}

/// The other reader of a saved setting: an applied `notification` write reaches §6.3's ledger, which
/// is the only thing that decides whether a notice is attempted.
///
/// The ledger is loaded once, at startup, and that is deliberate — a file read on the driver's task
/// for every frame is what it avoids — so the write path is the only place a switch can take effect
/// while the app runs. Without the hook this asserts nothing: the second call below would still
/// gather a burst, and the switch the page had just saved would be read at the next start.
#[test]
fn an_applied_notification_write_reaches_the_ledger_that_reads_it() {
    let feed = PetTaskFeed::new();

    // The shipped defaults: a finished turn is announced, and the burst gathers before it goes out.
    assert!(
        matches!(
            finished(&feed, "run-1", 1),
            NotificationOutcome::Coalescing { .. }
        ),
        "a finished turn is announced by default"
    );

    let saved = record(
        PetSettingsDomain::Notification,
        &[("onTurnFinished", json!(false))],
    );
    assert!(
        apply_notification_switch(&feed, &saved),
        "the record is the notification domain's"
    );

    assert_eq!(
        // A second run of the same session, and the next sequence: §6.3's stream is per session, so
        // a fact the ledger has already seen would be a replay rather than the switch under test.
        match finished(&feed, "run-2", 2) {
            NotificationOutcome::Silent(reason) => reason,
            other => panic!("{other:?} was produced for a switch the user turned off"),
        },
        SilenceReason::ChannelOff {
            channel: nekowite_lib::desktop_pet::NotificationChannel::TurnFinished
        }
    );
}

/// Do-not-disturb reaches the same ledger, and it *drops* the burst rather than holding it: §6.3
/// requires leaving do-not-disturb not to re-pop what it suppressed, so a switch flipped on mid-
/// burst has to end the burst. The rows stay unread, which is what the user finds afterwards.
#[test]
fn turning_do_not_disturb_on_ends_a_burst_that_was_already_gathering() {
    let feed = PetTaskFeed::new();
    assert!(matches!(
        finished(&feed, "run-1", 1),
        NotificationOutcome::Coalescing { .. }
    ));
    let due = feed
        .notifications()
        .expect("the ledger's lock is fresh")
        .pending_due()
        .expect("a burst is gathering");
    assert!(
        feed.flush_notices(due - 1)
            .expect("the ledger's lock is fresh")
            .is_none(),
        "the burst's window is still open, so nothing has gone out yet"
    );

    apply_notification_switch(
        &feed,
        &record(
            PetSettingsDomain::Notification,
            &[("doNotDisturb", json!(true))],
        ),
    );

    let policy = feed.notifications().expect("the ledger's lock is fresh");
    assert_eq!(
        policy.pending_due(),
        None,
        "the burst was dropped, not postponed"
    );
    assert_eq!(
        policy.unread().len(),
        1,
        "the row the switch silenced is still unread"
    );
}

/// A write to another domain is not the notification switches, for the reason the feature switch
/// refuses one: a settings save must not be a change to a subsystem it says nothing about.
#[test]
fn a_write_to_another_domain_touches_no_notification_switch() {
    let feed = PetTaskFeed::new();
    for domain in [
        PetSettingsDomain::General,
        PetSettingsDomain::Character,
        PetSettingsDomain::View,
        PetSettingsDomain::Message,
        PetSettingsDomain::Care,
        PetSettingsDomain::Project,
    ] {
        assert!(
            !apply_notification_switch(&feed, &record(domain, &[])),
            "{domain:?} is not the notification domain"
        );
    }
}
