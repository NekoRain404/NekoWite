//! The enable path: §5.1's 启用 is a settings *value*, so an applied `general` write is what opens
//! and closes the pet's windows — and this is the only caller `desktop_pet_open` has.
//!
//! The other moment the same value is known is a launch, which is the second half of this file:
//! [`restore`] reads a store instead of a write, and everything it can do to a host is here beside
//! the write path's cases so the two cannot drift.

use std::path::Path;

use serde_json::{json, Value};

use nekowite_lib::commands::desktop_pet::{
    apply_feature_switch, apply_notification_switch, PetFeatureState, UNSELECTED_CHARACTER,
};
use nekowite_lib::desktop_pet::feature_switch::restore;
use nekowite_lib::desktop_pet::notification_policy::SilenceReason;
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsRecord, PetSettingsStore, PetSettingsUpdate, PetSettingsWrite,
    PET_SETTINGS_INITIAL_REVISION, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::task_projection::{PetTaskKey, PetTaskState};
use nekowite_lib::desktop_pet::window_host::{
    PetSurfaces, PetWindowHost, PetWindowLabel, Placement, WindowStyle, WorkArea, BALL_LABEL,
};
use nekowite_lib::desktop_pet::{NotificationOutcome, PetTaskFeed, TaskFact};
use nekowite_lib::desktop_pet::{DESKTOP_PET_BALL_PAGE, DESKTOP_PET_PAGE};

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
    assert_eq!(surfaces.character_opens().len(), 1);
    assert_eq!(surfaces.character_opens()[0].1, DESKTOP_PET_PAGE);
    // The ball comes up with the window the switch opens: it is the pet's second surface, and the
    // reference's is on by default (`lib.rs:334-339`) — this is the product path that reaches it.
    assert_eq!(
        surfaces.ball_open(),
        Some((BALL_LABEL.to_string(), DESKTOP_PET_BALL_PAGE.to_string()))
    );
    assert_eq!(host.instances()[0].character_id, "cat");

    // Enabling again — a second save of the same value, or the character page writing while the
    // switch is already on — returns the window that exists rather than opening a second one.
    apply_feature_switch(
        &mut host,
        &record(PetSettingsDomain::General, &[("enabled", json!(true))]),
        "cat",
    );
    assert_eq!(surfaces.character_opens().len(), 1);
    assert_eq!(surfaces.opened().len(), 2, "a second ball as well");
}

/// The ball's own switch, as the same write applies it: the character window still comes up, and
/// the ball's does not.
///
/// This is the case a user asked for by name — 「想要角色但不要悬浮球」 — and before `general.ball`
/// existed there was no way to say it: the ball came up with every enable, because the switch that
/// opened it was the master one.
#[test]
fn a_general_write_with_the_ball_off_opens_the_character_and_not_the_ball() {
    let (mut host, surfaces) = support::host();
    let state = apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[("enabled", json!(true)), ("ball", json!(false))],
        ),
        "cat",
    );
    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: true,
            visible: true
        }),
        "the pet is on: only one of its windows was declined"
    );
    assert_eq!(surfaces.character_opens().len(), 1);
    assert_eq!(surfaces.ball_open(), None, "the ball was switched off");
    assert_eq!(host.ball(), None);
    assert!(!host.ball_enabled());
}

/// And the other direction: a ball turned back on comes up with the same write, because the pet is
/// already on and the write is what the host follows.
#[test]
fn turning_the_ball_back_on_brings_it_up_with_the_same_write() {
    let (mut host, surfaces) = support::host();
    apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[("enabled", json!(true)), ("ball", json!(false))],
        ),
        "cat",
    );
    assert_eq!(surfaces.ball_open(), None);

    apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[("enabled", json!(true)), ("ball", json!(true))],
        ),
        "cat",
    );
    assert_eq!(
        surfaces.ball_open(),
        Some((BALL_LABEL.to_string(), DESKTOP_PET_BALL_PAGE.to_string()))
    );
    assert_eq!(surfaces.character_opens().len(), 1, "no second character");
}

/// A ball turned off *while it is open* closes it, and closing it is not a disable: the character
/// window stays, and the switch that takes the pet down is a different field.
#[test]
fn turning_the_ball_off_closes_it_and_leaves_the_character_window_alone() {
    let (mut host, surfaces) = support::host();
    host.open("cat").expect("a window");
    assert!(host.ball().is_some(), "the ball came up with the pet");

    apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[("enabled", json!(true)), ("ball", json!(false))],
        ),
        "cat",
    );

    assert_eq!(host.ball(), None);
    assert!(surfaces.state().closed.contains(&BALL_LABEL.to_string()));
    assert!(
        !surfaces.live().is_empty(),
        "the character window is not the ball's switch to close"
    );
    assert_eq!(host.instances().len(), 1);
}

/// A ball switched on while the pet is off opens nothing: the master switch governs both surfaces,
/// and a ball that appeared over a switched-off pet would be a window the user's own switch did not
/// close.
#[test]
fn turning_the_ball_on_while_the_pet_is_off_opens_nothing() {
    let (mut host, surfaces) = support::host();
    let state = apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[("enabled", json!(false)), ("ball", json!(true))],
        ),
        "cat",
    );
    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: false,
            visible: false
        })
    );
    assert!(surfaces.opened().is_empty());
    assert!(host.ball_enabled(), "the preference is still the user's");
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
    // Both characters and the ball: the ball is a pet surface, and the switch that turns the pet
    // off is the switch that takes it down. It is not in the *report's* `closed` list, which names
    // the character each window was showing (`window_host.rs`'s `disable`), so the fake's own log
    // is where its close is counted.
    assert_eq!(surfaces.state().closed.len(), 3);
    assert!(surfaces.state().closed.contains(&BALL_LABEL.to_string()));
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
    assert_eq!(surfaces.character_opens().len(), 1);
    assert_eq!(host.instances().len(), 1);
    assert_eq!(host.instances()[0].character_id, UNSELECTED_CHARACTER);
    assert!(
        state.is_some(),
        "the state to publish is the one this ended in"
    );
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
        _size: (f64, f64),
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

// ---------------------------------------------------------------------------
// The same switch, at the other moment it is known: a launch
// ---------------------------------------------------------------------------

/// A store with one domain already written, as the settings page would have left it.
///
/// Written through `PetSettingsStore::apply` rather than by hand: a fixture that spelled the JSON
/// itself could produce a record the app would never write, and the cases below are about what the
/// app does with its own file.
fn stored(data: &Path, domain: PetSettingsDomain, changes: &[(&str, Value)]) -> PetSettingsStore {
    let store = PetSettingsStore::new(data).expect("a temporary data directory is absolute");
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    let outcome = store.apply(&PetSettingsWrite {
        domain,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: Value::Object(values),
    });
    assert!(
        matches!(outcome, PetSettingsUpdate::Applied { .. }),
        "the fixture's own write did not apply: {outcome:?}"
    );
    store
}

/// **A fresh install shows its pet.** `general.enabled` defaults to true, and before this path
/// existed nothing applied it: the switch rendered checked — it is read from the same schema — and
/// no window existed, because the only caller of the enable path was a settings *write*. The first
/// save of any field on any page was what opened the pet, which for a new user is a save they have
/// no reason to make.
///
/// The red this replaces was measured on a real desktop (`bundled-pets.md` §1, `ball-window.md`
/// §7.4): empty data directory, switch on, nothing on screen.
#[test]
fn a_first_run_opens_the_pet_its_default_declares() {
    let (store, _data) = support::store("startup-fresh");
    let (mut host, surfaces) = support::host();

    restore(&mut host, &store);

    assert_eq!(
        surfaces.character_opens().len(),
        1,
        "a store with no record reads as this build's defaults, and the default is on"
    );
    assert_eq!(
        surfaces.ball_open(),
        Some((BALL_LABEL.to_string(), DESKTOP_PET_BALL_PAGE.to_string())),
        "and the ball is on by default too — that is the one field in this change that kept its old value"
    );
    assert_eq!(host.instances()[0].character_id, UNSELECTED_CHARACTER);
}

/// **A user who turned it off stays off.** The whole reason the default is applied from the *record*
/// rather than from the schema: an install that saved `enabled: false` must not be resurrected by a
/// launch, which is the one thing a switch that turns a feature off may never do.
#[test]
fn a_stored_off_switch_stays_off_at_startup() {
    let (store, data) = support::store("startup-off");
    stored(
        &data,
        PetSettingsDomain::General,
        &[("enabled", json!(false))],
    );
    let (mut host, surfaces) = support::host();

    restore(&mut host, &store);

    assert!(surfaces.opened().is_empty(), "nothing at all was opened");
    assert!(host.instances().is_empty());
}

/// The character's own record is what the window is opened for, and a first run has one: the
/// shipped character is seeded before any window exists (`desktop_pet::bundled`), so the window a
/// launch opens draws a pet rather than the "No character is selected." sentence.
#[test]
fn a_startup_window_is_opened_for_the_character_the_settings_name() {
    let (store, data) = support::store("startup-character");
    stored(
        &data,
        PetSettingsDomain::Character,
        &[("characterId", json!("neko"))],
    );
    let (mut host, _surfaces) = support::host();

    restore(&mut host, &store);

    assert_eq!(host.instances()[0].character_id, "neko");
}

/// The ball's switch is stored like the master one, so a launch follows it the same way — and the
/// character window still comes up, which is the point of the field.
#[test]
fn a_stored_ball_off_opens_the_character_and_not_the_ball() {
    let (store, data) = support::store("startup-ball-off");
    stored(&data, PetSettingsDomain::General, &[("ball", json!(false))]);
    let (mut host, surfaces) = support::host();

    restore(&mut host, &store);

    assert_eq!(surfaces.character_opens().len(), 1);
    assert_eq!(surfaces.ball_open(), None);
    assert!(!host.ball_enabled());
}

/// A record from a newer build is the one arm a launch does **not** act on.
///
/// It is the only case in which a stated choice is known to exist and cannot be read — a downgrade
/// is how a user meets it — so opening a window would be guessing that they wanted a pet, and the
/// cost of guessing wrong is a pet that came back for someone who had turned it off. The settings
/// page shows no controls for the same file, so the two halves agree in every arm.
#[test]
fn a_record_from_a_newer_build_opens_nothing() {
    let (store, _data) = support::store("startup-newer");
    let path = store.path_of(PetSettingsDomain::General);
    std::fs::create_dir_all(path.parent().expect("a settings directory")).expect("a directory");
    std::fs::write(
        &path,
        serde_json::to_string(&json!({
            "domain": "general",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION + 1,
            "revision": 3,
            "values": { "enabled": true, "motion": "system", "ball": true }
        }))
        .expect("a JSON document"),
    )
    .expect("a written record");

    let (mut host, surfaces) = support::host();
    restore(&mut host, &store);

    assert!(
        surfaces.opened().is_empty(),
        "a record this build may not read opens no window"
    );
}

/// A window system that refuses a window at startup costs the pet and nothing else: the app starts,
/// and the switch reads as off because that is what happened rather than what was asked for.
#[test]
fn a_startup_that_cannot_open_a_window_still_starts() {
    let (store, _data) = support::store("startup-refused");
    let mut host = PetWindowHost::new(Box::new(RefusingSurfaces));

    restore(&mut host, &store);

    assert!(host.instances().is_empty());
    assert_eq!(host.ball(), None);
}
