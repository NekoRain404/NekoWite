//! §5.2's 气泡与消息 as a pet window receives it: the bubble's background alpha, on the appearance
//! read.
//!
//! `message.opacity` is a stored value, and the surface that draws it is the bubble inside the
//! character window — which may not read a settings domain at all
//! (`capabilities/desktop-pet.json` holds no `desktop_pet_read_settings`). So the alpha reaches a
//! window the way the drawing facts and the motion policy do: as a field of the appearance read
//! ([`stored_bubble_opacity`] + `character_view::appearance`), which is what these cases drive.
//!
//! **This is the defect, restated as tests.** The value used to live in the `view` domain as a
//! *window* opacity, drawn as a control on 常规与交互 and read by nothing at all: upstream's
//! `ap_opacity` is the bubble's own `--bubble-bg` alpha (`windows/src/main.ts:88-100`), no crate in
//! this build exposes a window-opacity call, and the field now sits where upstream drew it. Three
//! claims follow, and the third is the one a wrong implementation breaks silently:
//!
//! - **What the store holds is what a window is handed.** A write of `opacity: 0.7` through the
//!   store's own revision-checked path is visible in the next read, and a store nothing has written
//!   answers the schema's own default — upstream's 92 — rather than nothing.
//! - **The alpha is on every arm.** A window with no character still draws the bubble above its
//!   notice, so `unset` carries it too.
//! - **A record this build may not read is not guessed at.** A `message` file from a newer build is
//!   §10.2's read-only arm, and the answer there is this build's default: a transparency the user
//!   never chose is a change to what they see, not a fallback.

use std::fs;

use serde_json::{json, Value};

use nekowite_lib::desktop_pet::character_view::{appearance, stored_bubble_opacity, stored_motion};
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsLoad, PetSettingsStore, PetSettingsUpdate, PetSettingsWrite,
    PET_SETTINGS_INITIAL_REVISION, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::window_host::stored_ball_size;
use nekowite_lib::desktop_pet::{BubbleOpacity, PetAppearance};

use crate::support;

/// One domain's values as a write submits them: the schema's defaults with the changes applied.
fn submitted(domain: PetSettingsDomain, changes: &[(&str, Value)]) -> Value {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    Value::Object(values)
}

/// The appearance a window is handed, read the way `desktop_pet_appearance` reads it: the
/// character record from the store, the policy from `general` beside it, and the alpha from
/// `message`.
fn window_read(store: &PetSettingsStore) -> PetAppearance {
    let record = store
        .read(PetSettingsDomain::Character)
        .record()
        .expect("a character record is always answerable, defaults included")
        .clone();
    appearance(
        &record,
        stored_motion(store),
        stored_bubble_opacity(store),
        stored_ball_size(store),
        None,
    )
}

/// The alpha out of an appearance, whichever arm it is.
fn alpha_of(read: &PetAppearance) -> f64 {
    match read {
        PetAppearance::Unset { bubble_opacity, .. }
        | PetAppearance::Missing { bubble_opacity, .. }
        | PetAppearance::Ready { bubble_opacity, .. } => *bubble_opacity,
    }
}

#[test]
fn the_alpha_a_window_is_handed_is_the_one_the_store_holds() {
    let (store, _data) = support::store("bubble-follows");

    // Nothing has been written: the schema's own default, and the cross-check on the assumption
    // below is the schema's own table rather than a literal — the value upstream's slider opens on,
    // and the one a declared default that moved would fail here instead of leaving every window on
    // the old one.
    assert_eq!(
        defaults(PetSettingsDomain::Message)
            .get("opacity")
            .and_then(Value::as_f64),
        Some(0.92),
        "`message.opacity` is declared with 0.92 as its default"
    );
    assert_eq!(stored_bubble_opacity(&store), BubbleOpacity::DEFAULT);
    assert_eq!(alpha_of(&window_read(&store)), 0.92);

    let outcome = store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Message,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: submitted(PetSettingsDomain::Message, &[("opacity", json!(0.7))]),
    });
    assert!(
        matches!(outcome, PetSettingsUpdate::Applied { .. }),
        "the write is the one the settings page makes: {outcome:?}"
    );

    // The next read a window performs carries it — this is the fix: before it, the value was
    // stored, drawn as a control and read by nothing that draws.
    assert_eq!(stored_bubble_opacity(&store).value(), 0.7);
    assert_eq!(alpha_of(&window_read(&store)), 0.7);

    // And back, so the alpha is read rather than latched.
    store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Message,
        revision: PET_SETTINGS_INITIAL_REVISION as f64 + 1.0,
        values: submitted(PetSettingsDomain::Message, &[("opacity", json!(1.0))]),
    });
    assert_eq!(alpha_of(&window_read(&store)), 1.0);
}

#[test]
fn an_alpha_outside_the_rule_is_repaired_by_the_store_and_not_drawn() {
    let (store, _data) = support::store("bubble-out-of-rule");

    // Past the floor: a value that would leave a bubble whose text cannot be read. The write is
    // refused whole (§5.3), so what a window is handed afterwards is still the value it had.
    let refused = store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::Message,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: submitted(PetSettingsDomain::Message, &[("opacity", json!(0.05))]),
    });
    assert!(
        matches!(refused, PetSettingsUpdate::Refused { .. }),
        "a value outside the rule never reaches the file: {refused:?}"
    );
    assert_eq!(alpha_of(&window_read(&store)), 0.92);

    // And a file somebody edited by hand takes the rule's fallback on the way out, reported as a
    // repair rather than read as-is.
    let mut planted = submitted(PetSettingsDomain::Message, &[]);
    planted["opacity"] = json!("gone");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::Message),
        json!({
            "domain": "message",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION,
            "revision": 3,
            "values": planted,
        })
        .to_string(),
    )
    .expect("a hand-edited record");

    assert_eq!(alpha_of(&window_read(&store)), 0.92);
}

#[test]
fn the_alpha_rides_the_appearance_a_fresh_install_draws() {
    // No character has been chosen and this store holds no library: `appearance` answers `unset`,
    // which is the state a new user is in — and the bubble is drawn above that notice, which is
    // why the alpha may not be a field of the `ready` arm alone.
    let (store, _data) = support::store("bubble-unset");
    assert!(matches!(window_read(&store), PetAppearance::Unset { .. }));
    assert_eq!(alpha_of(&window_read(&store)), 0.92);
}

#[test]
fn a_message_record_from_a_newer_build_leaves_the_alpha_where_this_build_built_it() {
    let (store, _data) = support::store("bubble-newer");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::Message),
        json!({
            "domain": "message",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION + 1,
            "revision": 9,
            "values": { "opacity": 0.3 },
        })
        .to_string(),
    )
    .expect("a record from the future");
    let before =
        fs::read_to_string(store.path_of(PetSettingsDomain::Message)).expect("the planted file");

    assert!(matches!(
        store.read(PetSettingsDomain::Message),
        PetSettingsLoad::ReadOnly { .. }
    ));
    // §10.2: the record states a choice this build may not act on, so it is not read — and the
    // window is not handed a transparency that came from a file this build does not understand.
    // The default is the honest answer, and the file is left exactly as it was found.
    assert_eq!(alpha_of(&window_read(&store)), 0.92);
    assert_eq!(
        fs::read_to_string(store.path_of(PetSettingsDomain::Message)).expect("still there"),
        before
    );
}
