//! The store: where a record is, that a replacement is whole, that a mode is not loosened, and that
//! the loser of a write race finds out.

use std::fs;

use serde_json::{json, Value};

use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    DefaultsReason, PetSettingsDomain, PetSettingsLoad, PetSettingsRecord, PetSettingsStore,
    PetSettingsUpdate, PetSettingsWrite, RefusalReason, PET_SETTINGS_SCHEMA_VERSION,
};

use crate::support;

/// One domain's defaults with `changes` applied: the whole-domain submission a settings page sends.
fn submitted(domain: PetSettingsDomain, changes: &[(&str, Value)]) -> Value {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    Value::Object(values)
}

/// A write at one revision, as a page that read exactly that revision would send it.
fn write(
    domain: PetSettingsDomain,
    revision: f64,
    changes: &[(&str, Value)],
) -> PetSettingsWrite {
    PetSettingsWrite {
        domain,
        revision,
        values: submitted(domain, changes),
    }
}

fn applied(outcome: PetSettingsUpdate) -> PetSettingsRecord {
    match outcome {
        PetSettingsUpdate::Applied { record } => record,
        other => panic!("the write was not applied: {other:?}"),
    }
}

fn on_disk(store: &PetSettingsStore, domain: PetSettingsDomain) -> Value {
    let text = fs::read_to_string(store.path_of(domain))
        .unwrap_or_else(|error| panic!("{}: {error}", store.path_of(domain).display()));
    serde_json::from_str(&text).expect("the store writes JSON")
}

/// A store that has never been written says so — and says it with a *path*, not with a file it
/// created: the four read arms are answers, not side effects.
#[test]
fn a_fresh_store_reads_as_absent_and_creates_nothing() {
    let (store, data) = support::store("fresh");
    assert_eq!(
        store.root(),
        data.join("desktop-pet").join("settings"),
        "the records live beside the character library, inside the pet's own directory"
    );
    for domain in PetSettingsDomain::ALL {
        let load = store.read(domain);
        assert!(
            matches!(
                load,
                PetSettingsLoad::Defaults {
                    reason: DefaultsReason::Absent,
                    ..
                }
            ),
            "{domain:?} read as {load:?}"
        );
        assert!(!store.path_of(domain).exists());
    }
    // And a relative data directory is refused: it would resolve against this process's working
    // directory, which is nobody's choice.
    assert!(PetSettingsStore::new("relative/dir").is_err());
    assert!(PetSettingsStore::new(data).is_ok());
}

/// The file *is* the record: what a write answers with and what a user would find on disk are the
/// same JSON, field for field — which is what makes a record written by this build readable by the
/// TypeScript half without a translation step.
#[test]
fn a_write_reaches_the_disk_and_the_file_is_the_record() {
    let (store, _data) = support::store("round-trip");
    let record = applied(store.apply(&write(
        PetSettingsDomain::General,
        0.0,
        &[("enabled", json!(false))],
    )));
    assert_eq!(record.revision, 1, "the first write moves the counter off zero");

    let stored = on_disk(&store, PetSettingsDomain::General);
    assert_eq!(stored["domain"], "general");
    assert_eq!(stored["schemaVersion"], PET_SETTINGS_SCHEMA_VERSION);
    assert_eq!(stored["revision"], 1);
    assert_eq!(stored["values"]["enabled"], false);
    assert_eq!(
        stored,
        serde_json::to_value(&record).expect("a record serializes"),
        "the file is the record"
    );

    // And the next read is this build's own `current` arm, with the values it wrote.
    let PetSettingsLoad::Current { record: read } = store.read(PetSettingsDomain::General) else {
        panic!("a record this build wrote did not read as current")
    };
    assert_eq!(read, record);
}

/// §5.3's rule as a fact about the bytes: the loser of a race is refused, and the file still holds
/// the winner's write. A merge would be the value the other window changed, silently undone.
#[test]
fn a_second_writer_at_the_revision_it_read_is_refused_and_nothing_is_written() {
    let (store, _data) = support::store("conflict");
    applied(store.apply(&write(
        PetSettingsDomain::General,
        0.0,
        &[("enabled", json!(false))],
    )));
    let before = fs::read_to_string(store.path_of(PetSettingsDomain::General)).expect("the file");

    let lost = store.apply(&write(
        PetSettingsDomain::General,
        0.0,
        &[("enabled", json!(true)), ("motion", json!("reduced"))],
    ));
    let PetSettingsUpdate::Conflict { current } = lost else {
        panic!("a write at a revision that had moved was not a conflict: {lost:?}")
    };
    assert_eq!(current.revision, 1);
    assert_eq!(
        fs::read_to_string(store.path_of(PetSettingsDomain::General)).expect("the file"),
        before,
        "a refused write must not touch the file"
    );
    let stored = on_disk(&store, PetSettingsDomain::General);
    assert_eq!(stored["values"]["enabled"], false);
    assert_eq!(stored["values"]["motion"], "system");
}

/// One file per domain, so one domain written by a newer build cannot make the other six
/// unreadable — and a write to it is refused without touching it.
#[test]
fn a_domain_from_a_newer_build_does_not_block_another_domain() {
    let (store, _data) = support::store("newer-domain");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(
        store.path_of(PetSettingsDomain::General),
        json!({
            "domain": "general",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION + 1,
            "revision": 9,
            "values": { "enabled": true, "motion": "system" },
        })
        .to_string(),
    )
    .expect("a record from the future");
    let before =
        fs::read_to_string(store.path_of(PetSettingsDomain::General)).expect("the planted file");

    assert!(matches!(
        store.read(PetSettingsDomain::General),
        PetSettingsLoad::ReadOnly { found_version, .. }
            if found_version == PET_SETTINGS_SCHEMA_VERSION + 1
    ));
    assert_eq!(
        store.apply(&write(PetSettingsDomain::General, 9.0, &[])),
        PetSettingsUpdate::Refused {
            reason: RefusalReason::SchemaNewer,
            message: format!(
                "general is at schema {}; this build writes {PET_SETTINGS_SCHEMA_VERSION}",
                PET_SETTINGS_SCHEMA_VERSION + 1
            ),
        }
    );
    assert_eq!(
        fs::read_to_string(store.path_of(PetSettingsDomain::General)).expect("the planted file"),
        before,
        "a store from a newer build is left exactly as it was"
    );

    // The other domains are their own files and their own schemas.
    assert!(matches!(
        store.read(PetSettingsDomain::Character),
        PetSettingsLoad::Defaults {
            reason: DefaultsReason::Absent,
            ..
        }
    ));
    applied(store.apply(&write(PetSettingsDomain::Character, 0.0, &[])));
    assert!(store.path_of(PetSettingsDomain::Character).is_file());
}

/// A file that cannot be read as a record is reported as one this build has nothing to write
/// against — the arm a caller is meant to back the file up from. It is *not* reported as absent:
/// merging the two is how a corrupt file gets quietly replaced by defaults.
#[test]
fn an_unreadable_file_is_reported_rather_than_treated_as_no_file() {
    let (store, _data) = support::store("unreadable");
    fs::create_dir_all(store.root()).expect("the records directory");
    fs::write(store.path_of(PetSettingsDomain::Care), "{ not json").expect("a corrupt file");

    assert!(matches!(
        store.read(PetSettingsDomain::Care),
        PetSettingsLoad::Defaults {
            reason: DefaultsReason::Unreadable,
            ..
        }
    ));
    assert!(matches!(
        store.read(PetSettingsDomain::Project),
        PetSettingsLoad::Defaults {
            reason: DefaultsReason::Absent,
            ..
        }
    ));

    // A write against an unreadable record is applied at the revision the *read* reported — zero —
    // and replaces the file. That is the TypeScript half's policy and not a second decision here:
    // the read hands the caller a defaults record at revision 0, the caller's form is built from
    // it, and the store honours the revision it was given. Recorded as a test because it is a
    // consequence worth being able to see.
    let record = applied(store.apply(&write(PetSettingsDomain::Care, 0.0, &[])));
    assert_eq!(record.revision, 1);
    assert_eq!(
        on_disk(&store, PetSettingsDomain::Care)["values"]["enabled"],
        true
    );
}

/// A replacement is atomic and does not loosen a mode — the discipline `config_edit.rs` states,
/// followed through the crate's own primitive rather than a second implementation of it.
#[test]
fn a_replacement_keeps_the_mode_the_file_had() {
    use std::os::unix::fs::PermissionsExt;

    let (store, _data) = support::store("mode");
    applied(store.apply(&write(PetSettingsDomain::General, 0.0, &[])));
    let path = store.path_of(PetSettingsDomain::General);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("a private mode");

    applied(store.apply(&write(
        PetSettingsDomain::General,
        1.0,
        &[("enabled", json!(false))],
    )));
    let mode = fs::metadata(&path).expect("the file").permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "the file kept the mode it was given");

    // And the staging file the write went through is not left behind beside it.
    let entries: Vec<String> = fs::read_dir(store.root())
        .expect("the records directory")
        .map(|entry| entry.expect("an entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["general.json".to_string()]);
}

/// A file the user made read-only is not replaced: the save fails and says so, with the file
/// exactly as it was. That is §5.3's 「保存失败展示错误并保持可重试状态，不伪装成功」 reachable for
/// real rather than only in a fake.
#[test]
fn a_file_the_user_made_read_only_is_not_replaced() {
    use std::os::unix::fs::PermissionsExt;

    let (store, _data) = support::store("read-only");
    applied(store.apply(&write(PetSettingsDomain::General, 0.0, &[])));
    let path = store.path_of(PetSettingsDomain::General);
    let before = fs::read_to_string(&path).expect("the file");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).expect("a read-only file");

    let failed = store.apply(&write(
        PetSettingsDomain::General,
        1.0,
        &[("enabled", json!(false))],
    ));
    assert_eq!(
        serde_json::to_value(&failed).expect("an outcome serializes")["status"],
        "failed",
        "the arm a page reads as `failed`"
    );
    let PetSettingsUpdate::Failed { message } = failed else {
        panic!("a read-only destination was replaced: {failed:?}")
    };
    assert!(
        message.starts_with("EREADONLY: ") && message.contains("read-only"),
        "the refusal the save surfaces is the write path's own: {message}"
    );
    assert_eq!(fs::read_to_string(&path).expect("the file"), before);

    // The read still works, so the page can show the settings it cannot currently save.
    assert!(matches!(
        store.read(PetSettingsDomain::General),
        PetSettingsLoad::Current { .. }
    ));
}

/// The enable path's one question of the store: which character the settings name.
#[test]
fn the_character_domain_names_the_character_the_settings_hold() {
    let (store, _data) = support::store("chosen");
    assert_eq!(store.chosen_character(), None, "nothing is chosen yet");

    applied(store.apply(&write(
        PetSettingsDomain::Character,
        0.0,
        &[("characterId", json!("cat"))],
    )));
    assert_eq!(store.chosen_character(), Some("cat".to_string()));

    // Cleared again — upstream's `pet-deselect` link, which is a real value in this schema.
    applied(store.apply(&write(
        PetSettingsDomain::Character,
        1.0,
        &[("characterId", Value::Null)],
    )));
    assert_eq!(store.chosen_character(), None);

    // A domain from a newer build answers `None` rather than a character nobody chose.
    fs::write(
        store.path_of(PetSettingsDomain::Character),
        json!({
            "domain": "character",
            "schemaVersion": PET_SETTINGS_SCHEMA_VERSION + 1,
            "revision": 1,
            "values": {},
        })
        .to_string(),
    )
    .expect("a record from the future");
    assert_eq!(store.chosen_character(), None);
}
