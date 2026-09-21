//! The other moment the same value is known is a launch, which is the second half of this file:
//! [`restore`] reads a store instead of a write, and everything it can do to a host is here beside
//! the write path's cases so the two cannot drift.

use std::path::Path;

use serde_json::{json, Value};

use nekowite_lib::desktop_pet::feature_switch::restore;
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsStore, PetSettingsUpdate, PetSettingsWrite,
    PET_SETTINGS_INITIAL_REVISION, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::window_host::{PetWindowHost, BALL_LABEL};
use nekowite_lib::desktop_pet::{DESKTOP_PET_BALL_PAGE, UNSELECTED_CHARACTER};

use crate::support::{self, RefusingSurfaces};

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

/// **A user who turned the pet off stays off.** The whole reason the defaults are applied from the
/// *record* rather than from the schema: an install whose record says both windows are off must not
/// be resurrected by a launch, which is the one thing a switch that turns a feature off may never do.
///
/// "Off" is the two switches and not `enabled`, and this case is where that shows: a stored record
/// carrying `enabled: false` beside two switches that are on is read back as `enabled: true`, because
/// the master is a restatement of them (`a_stored_record_reads_back_with_the_master_its_switches_mean`).
/// A window is taken away by the switch that governs it, never by a summary of the case.
#[test]
fn a_stored_pair_of_switches_off_stays_off_at_startup() {
    let (store, data) = support::store("startup-off");
    stored(
        &data,
        PetSettingsDomain::General,
        &[("characterWindow", json!(false)), ("ball", json!(false))],
    );
    let (mut host, surfaces) = support::host();

    restore(&mut host, &store);

    assert!(surfaces.opened().is_empty(), "nothing at all was opened");
    assert!(host.instances().is_empty());
    assert!(host.ball().is_none());
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

/// And the other half of the pair, at the one moment no window exists yet: a stored 只开悬浮球 opens
/// the ball and no character window at all.
///
/// This is the arm `restore` exists for — nothing has asked the host for a window, so a switch the
/// launch path does not read is a choice that only takes effect once the user opens the settings
/// page and saves something.
#[test]
fn a_stored_character_window_off_opens_the_ball_and_not_the_character() {
    let (store, data) = support::store("startup-ball-only");
    stored(
        &data,
        PetSettingsDomain::General,
        &[("characterWindow", json!(false))],
    );
    let (mut host, surfaces) = support::host();

    restore(&mut host, &store);

    assert!(surfaces.character_opens().is_empty());
    assert!(host.instances().is_empty());
    assert_eq!(
        surfaces.ball_open(),
        Some((BALL_LABEL.to_string(), DESKTOP_PET_BALL_PAGE.to_string()))
    );
    assert_eq!(host.ball().map(|label| label.as_str()), Some(BALL_LABEL));
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
