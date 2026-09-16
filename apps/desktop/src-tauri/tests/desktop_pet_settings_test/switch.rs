//! The enable path: §5.1's 启用 is a settings *value*, so an applied `general` write is what opens
//! and closes the pet's windows — and this is the only caller `desktop_pet_open` has.

use serde_json::{json, Value};

use nekowite_lib::commands::desktop_pet::{
    apply_feature_switch, apply_notification_switch, PetFeatureState, UNSELECTED_CHARACTER,
};
use nekowite_lib::desktop_pet::notification_policy::SilenceReason;
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsRecord, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::task_projection::{PetTaskKey, PetTaskState};
use nekowite_lib::desktop_pet::{NotificationOutcome, PetTaskFeed, TaskFact};
use nekowite_lib::desktop_pet::window_host::{
    PetSurfaces, PetWindowHost, PetWindowLabel, Placement, WindowStyle, WorkArea,
};
use nekowite_lib::desktop_pet::DESKTOP_PET_PAGE;

use crate::support;

/// One stored record, as a write that was just applied would have produced it.
fn record(domain: PetSettingsDomain, changes: &[(&str, Value)]) -> PetSettingsRecord {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    PetSettingsRecord {
        domain,
        schema_version: PET_SETTINGS_SCHEMA_VERSION,
        revision: 1,
        values,
    }
}

/// The switch going on: the window the settings name is opened, on the pet's own page, and the
/// state a window listens for says so.
#[test]
fn an_applied_general_write_opens_the_character_window() {
    let (mut host, surfaces) = support::host();
    let state = apply_feature_switch(
        &mut host,
        &record(PetSettingsDomain::General, &[("enabled", json!(true))]),
        "cat",
    );
    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: true,
            visible: true
        })
    );
    assert_eq!(surfaces.opened().len(), 1);
    assert_eq!(surfaces.opened()[0].1, DESKTOP_PET_PAGE);
    assert_eq!(host.instances()[0].character_id, "cat");

    // Enabling again — a second save of the same value, or the character page writing while the
    // switch is already on — returns the window that exists rather than opening a second one.
    apply_feature_switch(
        &mut host,
        &record(PetSettingsDomain::General, &[("enabled", json!(true))]),
        "cat",
    );
    assert_eq!(surfaces.opened().len(), 1);
}

/// The switch going off: every window closes, which is §4's rollback — the switch, which deletes
/// nothing. There is no arm of the state that could carry a cancelled run or a dropped character.
#[test]
fn turning_the_switch_off_closes_every_window() {
    let (mut host, surfaces) = support::host();
    host.open("cat").expect("a window");
    host.open("dog").expect("another window");

    let state = apply_feature_switch(
        &mut host,
        &record(PetSettingsDomain::General, &[("enabled", json!(false))]),
        "cat",
    );
    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: false,
            visible: false
        })
    );
    assert!(surfaces.live().is_empty(), "every window is gone");
    assert_eq!(surfaces.state().closed.len(), 2);
    assert!(host.instances().is_empty());
}

/// A write to any other domain is not the switch, and touching a window because an unrelated
/// setting was saved is how a settings save becomes a lifecycle event.
#[test]
fn a_write_to_another_domain_touches_no_window() {
    let (mut host, surfaces) = support::host();
    let character = record(
        PetSettingsDomain::Character,
        &[("characterId", json!("cat")), ("size", json!(200))],
    );
    assert_eq!(apply_feature_switch(&mut host, &character, "cat"), None);
    assert!(surfaces.opened().is_empty());

    // And a `general` record that carries no switch at all is not a switch either: a record this
    // build did not write must not be able to open a window by being empty.
    let mut empty = record(PetSettingsDomain::General, &[]);
    empty.values.remove("enabled");
    assert_eq!(apply_feature_switch(&mut host, &empty, "cat"), None);
    assert!(surfaces.opened().is_empty());
}

/// The identity the window is opened under while no character is chosen: the pet's window exists
/// anyway, because a master switch whose only effect is a saved file is the inert control the
/// ledger forbids — and `DesktopPetRoot.vue` renders this state as "No character is selected.".
#[test]
fn the_unselected_identity_opens_the_pet_window() {
    assert!(!UNSELECTED_CHARACTER.is_empty());
    let (mut host, surfaces) = support::host();
    let state = apply_feature_switch(
        &mut host,
        &record(PetSettingsDomain::General, &[("enabled", json!(true))]),
        UNSELECTED_CHARACTER,
    );
    assert_eq!(surfaces.opened().len(), 1);
    assert_eq!(host.instances().len(), 1);
    assert_eq!(host.instances()[0].character_id, UNSELECTED_CHARACTER);
    assert!(state.is_some(), "the state to publish is the one this ended in");
}

/// A window system that refuses everything, so the enable path's handling of a real failure has a
/// way to be reached without inventing one.
struct RefusingSurfaces;

impl PetSurfaces for RefusingSurfaces {
    fn open(
        &mut self,
        _label: &PetWindowLabel,
        _page: &str,
        _at: Placement,
        _style: WindowStyle,
        _visible: bool,
    ) -> Result<(), String> {
        Err("no compositor here".to_string())
    }

    fn close(&mut self, _label: &PetWindowLabel) -> Result<(), String> {
        Err("no compositor here".to_string())
    }

    fn set_visible(&mut self, _label: &PetWindowLabel, _visible: bool) -> Result<(), String> {
        Err("no compositor here".to_string())
    }

    fn set_click_through(&mut self, _label: &PetWindowLabel, _ignore: bool) -> Result<(), String> {
        Err("no compositor here".to_string())
    }

    fn work_area(&self) -> Option<WorkArea> {
        None
    }
}

/// A window the compositor would not open is *logged* and the save still stands: the setting was
/// written, and telling the user their preference did not take would be a lie about the part that
/// worked. What the state says afterwards is what actually happened — no window.
#[test]
fn a_window_that_cannot_be_opened_does_not_change_the_setting() {
    let mut host = PetWindowHost::new(Box::new(RefusingSurfaces));
    let state = apply_feature_switch(
        &mut host,
        &record(PetSettingsDomain::General, &[("enabled", json!(true))]),
        "cat",
    );
    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: false,
            visible: false
        }),
        "the answer is the state the host ended up in, not the one that was asked for"
    );
    assert!(host.instances().is_empty());
}

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
        matches!(finished(&feed, "run-1", 1), NotificationOutcome::Coalescing { .. }),
        "a finished turn is announced by default"
    );

    let saved = record(
        PetSettingsDomain::Notification,
        &[("onTurnFinished", json!(false))],
    );
    assert!(apply_notification_switch(&feed, &saved), "the record is the notification domain's");

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
    assert!(matches!(finished(&feed, "run-1", 1), NotificationOutcome::Coalescing { .. }));
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
        &record(PetSettingsDomain::Notification, &[("doNotDisturb", json!(true))]),
    );

    let policy = feed.notifications().expect("the ledger's lock is fresh");
    assert_eq!(policy.pending_due(), None, "the burst was dropped, not postponed");
    assert_eq!(policy.unread().len(), 1, "the row the switch silenced is still unread");
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
