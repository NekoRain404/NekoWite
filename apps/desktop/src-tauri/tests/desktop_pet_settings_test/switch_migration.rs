//! The records this build did not write: one whose pair is only half readable, refused at the
//! boundary, and the records of a schema from before the two switches existed, migrated to the
//! meaning they had when they were written.

use serde_json::json;

use nekowite_lib::commands::desktop_pet::{apply_feature_switch, UNSELECTED_CHARACTER};
use nekowite_lib::desktop_pet::feature_switch::restore;
use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    PetSettingsDomain, PetSettingsRecord, PET_SETTINGS_SCHEMA_VERSION,
};
use nekowite_lib::desktop_pet::window_host::BALL_LABEL;
use nekowite_lib::desktop_pet::DESKTOP_PET_BALL_PAGE;

use crate::support::{self, write_record};

/// A record that carries one of the two switches and not the other is not one this build wrote, and
/// the host does nothing rather than guessing at the missing half.
///
/// **No store produces one.** `values::read_values` fills every field the schema declares on the read
/// path and on the write path both, and `settings::migrate` is where a record from a build that had
/// *fewer* fields is given the meaning it had there — `a_record_from_before_the_switch_existed_opens_the_windows_it_always_did`
/// below is that arm, end to end. So what this case pins is the refusal at the boundary: a record
/// whose two halves are not both readable is not a switch, and answering `true` for it would open a
/// window for a file nobody can point at.
#[test]
fn a_record_this_build_did_not_write_touches_no_window() {
    let (mut host, surfaces) = support::host();
    let mut values = defaults(PetSettingsDomain::General);
    values.remove("characterWindow");
    let record = PetSettingsRecord {
        domain: PetSettingsDomain::General,
        schema_version: PET_SETTINGS_SCHEMA_VERSION,
        revision: 1,
        values,
    };

    assert_eq!(apply_feature_switch(&mut host, &record, "cat"), None);

    assert!(surfaces.opened().is_empty());
    assert!(host.instances().is_empty());
    assert!(host.ball().is_none());
}

/// A record written before the field existed — the arm the whole shape has to be safe for. Nothing
/// in the stored file says anything about a character window, and what that record meant when it
/// was written is what it has to keep meaning: `enabled` on was a pet, both windows of it.
#[test]
fn a_record_from_before_the_switch_existed_opens_the_windows_it_always_did() {
    let (store, data) = support::store("startup-before-characterWindow");
    write_record(
        &store,
        PET_SETTINGS_SCHEMA_VERSION - 1,
        json!({ "enabled": true, "motion": "system", "ball": true }),
    );
    let (mut host, surfaces) = support::host();

    restore(&mut host, &store);

    assert_eq!(surfaces.character_opens().len(), 1);
    assert_eq!(host.instances()[0].character_id, UNSELECTED_CHARACTER);
    assert_eq!(
        surfaces.ball_open(),
        Some((BALL_LABEL.to_string(), DESKTOP_PET_BALL_PAGE.to_string()))
    );
}

/// **And the record that must not gain a window.** This is every user who has ever turned the pet
/// off: `enabled: false` with both window switches left at their default `true`, written by a build
/// whose `enabled` *was* the master switch. Read as the derived value it would be `true` — the two
/// switches say so — and the next launch would put a pet on their desktop: a window they never asked
/// for, appearing because of an upgrade.
///
/// So the migration is what this case pins, and it is asserted on the record itself as well as on the
/// windows: the master's *off* is written into the two switches it used to stand above, and the
/// derived value is then `false` for the right reason. Both switches are set to `true` in the stored
/// file on purpose — that is the hardest shape for the migration, and it is what the old build wrote
/// for a user who turned the pet off without ever opening the ball's own row.
#[test]
fn a_record_that_said_the_pet_was_off_migrates_to_both_switches_off() {
    let (store, _data) = support::store("startup-master-off");
    write_record(
        &store,
        PET_SETTINGS_SCHEMA_VERSION - 1,
        json!({ "enabled": false, "motion": "system", "ball": true, "characterWindow": true }),
    );

    let record = store
        .read(PetSettingsDomain::General)
        .record()
        .cloned()
        .expect("a record this build can read, migrated");
    assert_eq!(record.schema_version, PET_SETTINGS_SCHEMA_VERSION);
    assert_eq!(record.value("enabled"), Some(&json!(false)));
    assert_eq!(record.value("characterWindow"), Some(&json!(false)));
    assert_eq!(record.value("ball"), Some(&json!(false)));

    let (mut host, surfaces) = support::host();
    restore(&mut host, &store);

    assert!(
        surfaces.opened().is_empty(),
        "the pet was switched off and stayed off"
    );
    assert!(host.instances().is_empty());
    assert!(host.ball().is_none(), "and no ball appeared either");
}

/// The other half of the same migration: a master left *on* says nothing about the two switches, so
/// what the record's own switches say stands — and a record from a build that had no
/// `characterWindow` field at all keeps the window it always had, because `enabled` on meant a pet
/// and a pet was a character window.
#[test]
fn a_record_that_said_the_pet_was_on_keeps_the_switches_it_carries() {
    let (store, _data) = support::store("startup-master-on");
    write_record(
        &store,
        PET_SETTINGS_SCHEMA_VERSION - 1,
        json!({ "enabled": true, "motion": "system", "ball": false, "characterWindow": true }),
    );
    let (mut host, surfaces) = support::host();

    restore(&mut host, &store);

    assert_eq!(surfaces.character_opens().len(), 1, "the character window");
    assert_eq!(
        surfaces.ball_open(),
        None,
        "and not the ball, which it said no to"
    );
    assert!(host.ball_enabled() == false);
}
