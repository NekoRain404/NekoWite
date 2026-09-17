//! §5.2's 「跟随系统/应用设置」: the 动效 setting as the pet's windows actually receive it.
//!
//! `general.motion` is a stored value, and the *only* reader that can act on it is a pet window —
//! which may not read a settings domain at all (`capabilities/desktop-pet.json` holds no
//! `desktop_pet_read_settings`). So the policy reaches a window the way the drawing facts do: as a
//! field of the appearance read ([`stored_motion`] + `character_view::appearance`), which is what
//! these cases drive.
//!
//! Three claims, and the third is the one a wrong implementation breaks silently:
//!
//! - **What the store holds is what a window is handed.** A write of `motion: "reduced"` through
//!   the store's own revision-checked path is visible in the next read, and a store nothing has
//!   written answers the schema's own default rather than nothing.
//! - **The policy is on every arm.** A fresh install draws no character and still draws the ball,
//!   so `unset` carries it too; an appearance that only carried it when a character was chosen
//!   would leave the new user's orb — the one surface here that moves — following nothing.
//! - **A record this build may not read is not guessed at.** A `general` file from a newer build
//!   is §10.2's read-only arm, and the answer there is this build's default: answering `reduced`
//!   would invent a restriction the user never asked for, and the window still follows the
//!   system's own preference through its own engine either way.

use std::fs;

use serde_json::{json, Value};

use nekowite_lib::desktop_pet::character_view::{appearance, stored_bubble_opacity, stored_motion};
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsLoad, PetSettingsStore, PetSettingsUpdate, PetSettingsWrite,
    PET_SETTINGS_INITIAL_REVISION, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::{Motion, PetAppearance};

use crate::support;

/// One domain's values as a write submits them: the schema's defaults with the changes applied.
///
/// A `Value::Object` because that is what the wire carries (`PetSettingsWrite::values`), which is
/// the shape the settings page's own write has.
fn submitted(domain: PetSettingsDomain, changes: &[(&str, Value)]) -> Value {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    Value::Object(values)
}

/// The appearance a window is handed, read the way `desktop_pet_appearance` reads it: the
/// character record from the store, and the policy from the `general` record beside it.
fn window_read(store: &PetSettingsStore) -> PetAppearance {
    let record = store
        .read(PetSettingsDomain::Character)
        .record()
        .expect("a character record is always answerable, defaults included")
        .clone();
    let read = appearance(
        &record,
        stored_motion(store),
        stored_bubble_opacity(store),
        None,
    );
    read
}

/// The policy out of an appearance, whichever arm it is.
fn motion_of(read: &PetAppearance) -> Motion {
    match read {
        PetAppearance::Unset { motion, .. }
        | PetAppearance::Missing { motion, .. }
        | PetAppearance::Ready { motion, .. } => *motion,
    }
}

#[test]
fn the_policy_a_window_is_handed_is_the_one_the_store_holds() {
    let (store, _data) = support::store("motion-follows");

    // Nothing has been written: the schema's own default, and the cross-check on the assumption
    // below is the schema's own table rather than a literal — a declared default that moved would
    // fail here instead of leaving every window on the old one.
    assert_eq!(
        defaults(PetSettingsDomain::General)
            .get("motion")
            .and_then(Value::as_str),
        Some("system"),
        "`general.motion` is declared with `system` as its default"
    );
    assert_eq!(stored_motion(&store), Motion::System);
    assert_eq!(motion_of(&window_read(&store)), Motion::System);

    let outcome = store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::General,
        revision: PET_SETTINGS_INITIAL_REVISION as f64,
        values: submitted(PetSettingsDomain::General, &[("motion", json!("reduced"))]),
    });
    assert!(
        matches!(outcome, PetSettingsUpdate::Applied { .. }),
        "the write is the one the settings page makes: {outcome:?}"
    );

    // The next read a window performs carries it — this is the fix: before it, the setting was
    // stored, drawn on 常规与交互 and read by nothing that moves.
    assert_eq!(stored_motion(&store), Motion::Reduced);
    assert_eq!(motion_of(&window_read(&store)), Motion::Reduced);
    // And back, so the policy is read rather than latched: a user who returns to 「跟随系统」 gets
    // the system's own answer again.
    store.apply(&PetSettingsWrite {
        domain: PetSettingsDomain::General,
        revision: PET_SETTINGS_INITIAL_REVISION as f64 + 1.0,
        values: submitted(PetSettingsDomain::General, &[("motion", json!("system"))]),
    });
    assert_eq!(stored_motion(&store), Motion::System);
}

#[test]
fn the_policy_rides_the_appearance_a_fresh_install_draws() {
    // No character has been chosen and this store holds no library at all: `appearance` answers
    // `unset`, which is the state a new user is in — and the ball still draws there (upstream's
    // plain orb), which is why the policy may not be a field of the `ready` arm alone.
    let (store, _data) = support::store("motion-unset");
    assert!(matches!(window_read(&store), PetAppearance::Unset { .. }));
}

#[test]
fn a_general_record_from_a_newer_build_leaves_the_policy_where_this_build_built_it() {
    let (store, _data) = support::store("motion-newer");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::General),
        json!({
            "domain": "general",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION + 1,
            "revision": 9,
            "values": { "enabled": true, "motion": "reduced" },
        })
        .to_string(),
    )
    .expect("a record from the future");
    let before =
        fs::read_to_string(store.path_of(PetSettingsDomain::General)).expect("the planted file");

    assert!(matches!(
        store.read(PetSettingsDomain::General),
        PetSettingsLoad::ReadOnly { .. }
    ));
    // §10.2: the record states a choice this build may not act on, so it is not read — and the
    // window is not told a policy that came from a file this build does not understand. The
    // default is the honest answer, and the file is left exactly as it was found.
    assert_eq!(stored_motion(&store), Motion::System);
    assert_eq!(
        fs::read_to_string(store.path_of(PetSettingsDomain::General)).expect("still there"),
        before
    );
}
