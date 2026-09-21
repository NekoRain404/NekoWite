//! An applied `general` write is the switch: §5.1's 启用 as it happens on the desktop — the window
//! the settings name is opened, the two switches as the state rather than a master above them, and
//! the answers the boundary gives when the record is not one this build wrote or the compositor will
//! not open a window.

use serde_json::json;

use nekowite_lib::commands::desktop_pet::{
    apply_feature_switch, PetFeatureState, UNSELECTED_CHARACTER,
};
use nekowite_lib::desktop_pet::feature_switch::restore;
use nekowite_lib::desktop_pet::settings::{PetSettingsDomain, PET_SETTINGS_SCHEMA_VERSION};
use nekowite_lib::desktop_pet::window_host::{PetWindowHost, BALL_LABEL};
use nekowite_lib::desktop_pet::{DESKTOP_PET_BALL_PAGE, DESKTOP_PET_PAGE};

use crate::support::{self, record, write_record, RefusingSurfaces};

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

/// **The two switches are the state, and nothing above them decides.** With 显示角色窗口 off and 显示悬浮球
/// on, the ball comes up — and it comes up *while the record's own `enabled` says otherwise*, which is
/// the arm this case exists for: `enabled` is derived from these two (`values::derive_master`), so a
/// record carrying a contradictory one has already been read as the switches say by the time a
/// window is asked for. This is the reported defect written as a test: the ball's switch used to be
/// drawn disabled while the master was off, and the master was what the host read.
#[test]
fn the_switches_are_the_state_and_a_contradictory_master_is_not_an_input() {
    let (mut host, surfaces) = support::host();
    let state = apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[
                ("enabled", json!(false)),
                ("characterWindow", json!(false)),
                ("ball", json!(true)),
            ],
        ),
        "cat",
    );
    assert_eq!(
        state,
        Some(PetFeatureState {
            enabled: true,
            visible: true
        }),
        "one window is up, so the pet is on"
    );
    assert!(
        host.instances().is_empty(),
        "no character window was opened"
    );
    assert_eq!(
        surfaces.ball_open(),
        Some((BALL_LABEL.to_string(), DESKTOP_PET_BALL_PAGE.to_string())),
        "the ball is the window this record asks for"
    );
    assert_eq!(host.ball().map(|label| label.as_str()), Some(BALL_LABEL));
}

/// The same record as the *store* reads it: `enabled` is not a value a record can disagree with its
/// own switches about, because the read recomputes it. What a page shows and what a window does come
/// from one record, so a page that drew the master beside the two rows would be drawing a value it
/// cannot be told wrongly — which is why it draws no such control (`PetGeneralSettings.vue`).
#[test]
fn a_stored_record_reads_back_with_the_master_its_switches_mean() {
    let (store, _data) = support::store("master-derived");
    write_record(
        &store,
        PET_SETTINGS_SCHEMA_VERSION,
        json!({
            "enabled": true,
            "motion": "system",
            "ball": false,
            "characterWindow": false,
            "ballSize": 56,
        }),
    );

    let record = store
        .read(PetSettingsDomain::General)
        .record()
        .cloned()
        .expect("a general record this build can read");
    assert_eq!(record.value("enabled"), Some(&json!(false)));
    assert_eq!(record.value("ball"), Some(&json!(false)));
    assert_eq!(record.value("characterWindow"), Some(&json!(false)));

    let (mut host, surfaces) = support::host();
    restore(&mut host, &store);
    assert!(
        surfaces.opened().is_empty(),
        "no window, because both switches are off"
    );
}

/// **And the same record with one switch back on.** The master follows the pair rather than the
/// other way round: a record whose file says `enabled: true` and whose ball is on opens the ball,
/// which is the direction the derivation exists to make unarguable.
#[test]
fn the_master_follows_a_single_switch_that_is_still_on() {
    let (store, _data) = support::store("master-derived-one");
    write_record(
        &store,
        PET_SETTINGS_SCHEMA_VERSION,
        json!({
            "enabled": false,
            "motion": "system",
            "ball": true,
            "characterWindow": false,
            "ballSize": 56,
        }),
    );

    let record = store
        .read(PetSettingsDomain::General)
        .record()
        .cloned()
        .expect("a general record this build can read");
    assert_eq!(record.value("enabled"), Some(&json!(true)));

    let (mut host, surfaces) = support::host();
    restore(&mut host, &store);
    assert!(surfaces.character_opens().is_empty());
    assert_eq!(
        surfaces.ball_open(),
        Some((BALL_LABEL.to_string(), DESKTOP_PET_BALL_PAGE.to_string()))
    );
}

/// The pet going away: both switches off is §4's rollback — the switches, which delete nothing.
/// There is no arm of the state that could carry a cancelled run or a dropped character, and with the
/// master gone this is the *only* way a record says "no pet window at all".
#[test]
fn turning_both_switches_off_closes_every_window() {
    let (mut host, surfaces) = support::host();
    host.open("cat").expect("a window");
    host.open("dog").expect("another window");

    let state = apply_feature_switch(
        &mut host,
        &record(
            PetSettingsDomain::General,
            &[("characterWindow", json!(false)), ("ball", json!(false))],
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

    // And a `general` record that carries neither of the two window switches is not a switch either:
    // a record this build did not write must not be able to open a window by being empty — the guard
    // the old master-switch read provided, kept where the decision now lives.
    let mut empty = record(PetSettingsDomain::General, &[]);
    empty.values.remove("ball");
    empty.values.remove("characterWindow");
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
