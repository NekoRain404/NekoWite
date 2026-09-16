//! The enable path: §5.1's 启用 is a settings *value*, so an applied `general` write is what opens
//! and closes the pet's windows — and this is the only caller `desktop_pet_open` has.

use serde_json::{json, Value};

use nekowite_lib::commands::desktop_pet::{
    apply_feature_switch, PetFeatureState, UNSELECTED_CHARACTER,
};
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsRecord, PET_SETTINGS_SCHEMA_VERSION,
};
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
