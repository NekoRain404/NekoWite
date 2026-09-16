//! The record rules: the four arms a read answers with, and the four a write answers with — with
//! the revision and the schema version deciding, rather than a merge.

use serde_json::{json, Map, Value};

use nekowite_lib::desktop_pet::settings::values::defaults;
use nekowite_lib::desktop_pet::settings::{
    decide_write, notification_preferences, read_domain, DefaultsReason, PetSettingsDomain,
    PetSettingsLoad, PetSettingsRecord, PetSettingsUpdate, PetSettingsWrite, ReadOnlyReason,
    RefusalReason, PET_SETTINGS_INITIAL_REVISION, PET_SETTINGS_SCHEMA_VERSION,
};

/// A stored record, as a file would hold it.
fn stored(domain: &str, version: i64, revision: i64, values: Value) -> Value {
    json!({
        "domain": domain,
        "schemaVersion": version,
        "revision": revision,
        "values": values,
    })
}

/// The record a read of `stored` produced, as this build keeps it.
fn record(
    domain: PetSettingsDomain,
    version: i64,
    revision: i64,
    values: Value,
) -> PetSettingsRecord {
    PetSettingsRecord {
        domain,
        schema_version: version,
        revision,
        values: values.as_object().cloned().unwrap_or_else(Map::new),
    }
}

/// One domain's defaults with `changes` applied — the whole-domain submission a settings page
/// sends.
fn submitted(domain: PetSettingsDomain, changes: &[(&str, Value)]) -> Value {
    let mut values = defaults(domain);
    for (field, value) in changes {
        values.insert((*field).to_string(), value.clone());
    }
    Value::Object(values)
}

/// The arms as they cross the wire, because that is the shape the settings page reads: the tag,
/// the kebab-case member names and the camelCase fields are D1's contract, and an enum that
/// serializes differently is a page that renders nothing — or, worse, reads the wrong value out of
/// a record it did receive.
#[test]
fn every_arm_serializes_the_way_the_contract_spells_it() {
    let read = |stored: Option<Value>, domain| {
        serde_json::to_value(read_domain(domain, stored.as_ref())).expect("a load serializes")
    };

    let current = read(
        Some(stored("general", 2, 3, json!({ "enabled": true, "motion": "system" }))),
        PetSettingsDomain::General,
    );
    assert_eq!(current["status"], "current");
    assert_eq!(current["record"]["domain"], "general");
    assert_eq!(current["record"]["schemaVersion"], 2);
    assert_eq!(current["record"]["revision"], 3);
    assert_eq!(current["record"]["values"]["motion"], "system");

    assert_eq!(
        read(
            Some(stored("general", 3, 1, json!({}))),
            PetSettingsDomain::General
        ),
        json!({ "status": "read-only", "reason": "schema-newer", "foundVersion": 3 })
    );
    assert_eq!(
        read(None, PetSettingsDomain::Care),
        json!({
            "status": "defaults",
            "reason": "absent",
            "record": {
                "domain": "care",
                "schemaVersion": PET_SETTINGS_SCHEMA_VERSION,
                "revision": PET_SETTINGS_INITIAL_REVISION,
                "values": { "enabled": true, "restReminders": true },
            },
        })
    );

    let migrated = read(
        Some(stored("character", 1, 2, json!({ "size": 9000 }))),
        PetSettingsDomain::Character,
    );
    assert_eq!(migrated["status"], "migrated");
    assert_eq!(migrated["fromVersion"], 1);
    assert_eq!(migrated["repaired"], json!(["character.size"]));
    assert_eq!(migrated["record"]["schemaVersion"], PET_SETTINGS_SCHEMA_VERSION);

    let outcome = |update: PetSettingsUpdate| serde_json::to_value(update).expect("an outcome");
    let stored_record = record(
        PetSettingsDomain::General,
        2,
        1,
        submitted(PetSettingsDomain::General, &[]),
    );
    let write = |revision: f64, values: Value| PetSettingsWrite {
        domain: PetSettingsDomain::General,
        revision,
        values,
    };

    let applied = outcome(decide_write(
        &stored_record,
        &write(1.0, submitted(PetSettingsDomain::General, &[])),
    ));
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["record"]["revision"], 2);

    let conflict = outcome(decide_write(
        &stored_record,
        &write(4.0, submitted(PetSettingsDomain::General, &[])),
    ));
    assert_eq!(conflict["status"], "conflict");
    assert_eq!(conflict["current"]["revision"], 1);

    let refused = outcome(decide_write(
        &stored_record,
        &write(1.0, json!({ "enabled": "yes" })),
    ));
    assert_eq!(refused["status"], "refused");
    assert_eq!(refused["reason"], "invalid-value");
    // Schema order, field by field: `enabled` is declared before `motion`.
    assert_eq!(refused["message"], "general.enabled:wrong-type, general.motion:missing");

    let newer = outcome(decide_write(
        &record(PetSettingsDomain::General, 9, 1, submitted(PetSettingsDomain::General, &[])),
        &write(1.0, submitted(PetSettingsDomain::General, &[])),
    ));
    assert_eq!(
        newer,
        json!({
            "status": "refused",
            "reason": "schema-newer",
            "message": "general is at schema 9; this build writes 2",
        })
    );
}

/// The first arm: nothing has been written, and the caller gets this build's defaults at the
/// revision both sides call the start.
#[test]
fn a_domain_nobody_wrote_reads_as_absent_defaults() {
    for domain in PetSettingsDomain::ALL {
        let load = read_domain(domain, None);
        let PetSettingsLoad::Defaults { reason, record } = &load else {
            panic!("{domain:?} read as {load:?}")
        };
        assert_eq!(*reason, DefaultsReason::Absent);
        assert_eq!(record.schema_version, PET_SETTINGS_SCHEMA_VERSION);
        assert_eq!(record.revision, PET_SETTINGS_INITIAL_REVISION);
        assert_eq!(record.values, defaults(domain));
    }
}

/// A document that is there and is not a record is *reported*, not read as an empty one: reporting
/// it as "no settings yet" is how a corrupt file gets quietly replaced by defaults.
#[test]
fn a_document_that_is_not_a_record_reads_as_unreadable() {
    for unreadable in [
        json!("general"),
        json!([1, 2]),
        json!({}),
        json!({ "schemaVersion": "2", "revision": 0, "values": {} }),
        json!({ "schemaVersion": -1, "revision": 0, "values": {} }),
        json!({ "schemaVersion": 2, "revision": -1, "values": {} }),
        json!({ "schemaVersion": 2, "revision": 1.5, "values": {} }),
        json!({ "schemaVersion": 2, "revision": 0 }),
        json!({ "schemaVersion": 2, "revision": 0, "values": "nope" }),
        json!({ "schemaVersion": 2, "revision": 0, "values": [] }),
    ] {
        let load = read_domain(PetSettingsDomain::General, Some(&unreadable));
        assert!(
            matches!(
                load,
                PetSettingsLoad::Defaults {
                    reason: DefaultsReason::Unreadable,
                    ..
                }
            ),
            "{unreadable} read as {load:?}"
        );
    }
}

/// §10.2, in the direction that matters most: a record a newer build wrote is reported with the
/// version it carries and is *not* read as this version with defaults for the unknown fields —
/// which is exactly what a caller would then write back.
#[test]
fn a_record_from_a_newer_build_is_read_only_and_carries_the_version_it_found() {
    let load = read_domain(
        PetSettingsDomain::General,
        Some(&stored("general", 3, 4, json!({ "enabled": false }))),
    );
    assert_eq!(
        load,
        PetSettingsLoad::ReadOnly {
            reason: ReadOnlyReason::SchemaNewer,
            found_version: 3,
        }
    );
    assert!(
        load.record().is_none(),
        "the read-only arm carries no record to write back"
    );
}

/// An older record is read field by field, repaired where it has to be, and stamped with *this*
/// build's version — so a write-back is an upgrade rather than a migration replayed on every read.
#[test]
fn an_older_record_migrates_and_reports_what_it_repaired() {
    let load = read_domain(
        PetSettingsDomain::Character,
        Some(&stored(
            "character",
            1,
            4,
            json!({ "size": 9000, "idleMode": "sequential" }),
        )),
    );
    let PetSettingsLoad::Migrated {
        record,
        from_version,
        repaired,
    } = load
    else {
        panic!("a version-1 record did not migrate")
    };
    assert_eq!(from_version, 1);
    assert_eq!(record.schema_version, PET_SETTINGS_SCHEMA_VERSION);
    assert_eq!(record.revision, 4, "the counter is the store's, not this read's");
    assert_eq!(record.values["size"], json!(160));
    assert_eq!(record.values["idleMode"], json!("sequential"));
    assert_eq!(record.values["idleIntervalSeconds"], json!(5));
    assert_eq!(repaired, vec!["character.size".to_string()]);
}

/// A record at this build's version needs no migration and reports no repairs.
#[test]
fn a_current_record_carries_its_revision_and_its_values() {
    let load = read_domain(
        PetSettingsDomain::Notification,
        Some(&stored(
            "notification",
            PET_SETTINGS_SCHEMA_VERSION,
            7,
            json!({ "sound": false }),
        )),
    );
    let PetSettingsLoad::Current { record } = load else {
        panic!("a current record did not read as one")
    };
    assert_eq!(record.revision, 7);
    assert_eq!(record.values["sound"], json!(false));
    assert_eq!(record.values["doNotDisturb"], json!(false));
}

/// The write that may be applied: it carries the revision the caller read, so the store's counter
/// moves by one and the record it answers with is the whole domain.
#[test]
fn an_applied_write_moves_the_revision_and_stamps_this_build_s_version() {
    let stored = record(
        PetSettingsDomain::General,
        1,
        7,
        json!({ "enabled": true, "motion": "system" }),
    );
    let write = PetSettingsWrite {
        domain: PetSettingsDomain::General,
        revision: 7.0,
        values: submitted(PetSettingsDomain::General, &[("enabled", json!(false))]),
    };
    let PetSettingsUpdate::Applied { record: applied } = decide_write(&stored, &write) else {
        panic!("a write at the revision it read was not applied")
    };
    assert_eq!(applied.revision, 8);
    assert_eq!(applied.schema_version, PET_SETTINGS_SCHEMA_VERSION);
    assert_eq!(applied.values["enabled"], json!(false));
    assert_eq!(applied.values["motion"], json!("system"));
    assert_eq!(stored.revision, 7, "the record the caller read is unchanged");
}

/// §5.3's cross-window rule, in both wrong directions: a *stale* revision and one *ahead* of the
/// store are both refused, and the answer carries what is stored, as it is. There is no partial
/// accept, so a value the user changed on another page cannot be undone by a write that lost.
#[test]
fn a_write_at_another_revision_is_a_conflict_carrying_what_is_stored() {
    let stored = record(
        PetSettingsDomain::General,
        2,
        4,
        json!({ "enabled": true, "motion": "system" }),
    );
    for claimed in [3.0, 5.0] {
        let write = PetSettingsWrite {
            domain: PetSettingsDomain::General,
            revision: claimed,
            values: submitted(PetSettingsDomain::General, &[("motion", json!("reduced"))]),
        };
        let PetSettingsUpdate::Conflict { current } = decide_write(&stored, &write) else {
            panic!("a write at revision {claimed} was not a conflict")
        };
        assert_eq!(current, stored);
        let written = serde_json::to_string(&current).expect("a record serializes");
        assert!(
            !written.contains("reduced"),
            "the loser's value appears in what the winner keeps"
        );
    }
}

/// A store at a newer schema is refused *before* anything else — before the domain, before the
/// revision, and before the values — so a build that meets data from its future does not overwrite
/// it even with a write that looks current in every other way.
#[test]
fn a_newer_store_refuses_a_write_before_anything_else() {
    let stored = record(
        PetSettingsDomain::General,
        3,
        4,
        json!({ "enabled": true, "motion": "system" }),
    );
    let write = PetSettingsWrite {
        domain: PetSettingsDomain::Character,
        revision: 0.0,
        values: json!({}),
    };
    assert_eq!(
        decide_write(&stored, &write),
        PetSettingsUpdate::Refused {
            reason: RefusalReason::SchemaNewer,
            message: "general is at schema 3; this build writes 2".to_string(),
        }
    );
}

/// The record's `domain` and the submission's are two halves of one fact: a mismatch means the
/// pair was assembled wrong, and the refusal says which two it saw.
#[test]
fn a_write_for_another_domain_is_refused_by_name() {
    let stored = record(
        PetSettingsDomain::Character,
        2,
        0,
        submitted(PetSettingsDomain::Character, &[]),
    );
    let write = PetSettingsWrite {
        domain: PetSettingsDomain::General,
        revision: 0.0,
        values: submitted(PetSettingsDomain::General, &[]),
    };
    assert_eq!(
        decide_write(&stored, &write),
        PetSettingsUpdate::Refused {
            reason: RefusalReason::InvalidValue,
            message: "a general write against a character record".to_string(),
        }
    );
}

/// A submission that is not a value this build can store is refused with the problem list, in the
/// diagnostic form both halves spell the same way — including a field the schema does not declare,
/// because dropping it would report "saved" for a submission this build did not fully understand.
#[test]
fn a_write_whose_values_are_unusable_is_refused_with_the_problem_list() {
    let stored = record(
        PetSettingsDomain::Character,
        2,
        2,
        submitted(PetSettingsDomain::Character, &[]),
    );
    let write = PetSettingsWrite {
        domain: PetSettingsDomain::Character,
        revision: 2.0,
        values: json!({ "size": 9000, "idleMode": "sideways" }),
    };
    let PetSettingsUpdate::Refused { reason, message } = decide_write(&stored, &write) else {
        panic!("an unusable submission was accepted")
    };
    assert_eq!(reason, RefusalReason::InvalidValue);
    assert!(message.contains("character.size:out-of-range"), "{message}");
    assert!(message.contains("character.idleMode:unknown-member"), "{message}");
    assert!(message.contains("character.characterId:missing"), "{message}");
}

/// The notification domain's one consumer, and the reason its record is not an inert file.
///
/// §5.2 forbids a control that does nothing, and the four page switches plus the three that shape how
/// a notice arrives are §6.3's ledger's own preferences. The mapping is the schema's deserialization
/// rather than seven field lookups, so a field renamed on either side cannot become a switch that
/// silently stopped deciding — and the two cases that follow are the two ways a record can fail to
/// be a source of switches, both of which keep what the caller already had rather than deciding a
/// notice from half a record.
#[test]
fn a_notification_record_reads_as_the_ledgers_switches() {
    let stored = record(
        PetSettingsDomain::Notification,
        2,
        1,
        json!({
            "onTurnFinished": false,
            "onStopped": true,
            "onFailed": false,
            "onWaitingInput": true,
            "sound": false,
            "doNotDisturb": true,
            "showTaskTitle": true,
        }),
    );

    let switches = notification_preferences(&stored).expect("the domain's own record maps");
    assert!(!switches.on_turn_finished);
    assert!(switches.on_stopped);
    assert!(!switches.on_failed);
    assert!(switches.on_waiting_input);
    assert!(!switches.sound);
    assert!(switches.do_not_disturb);
    assert!(switches.show_task_title);

    // A record of another domain is not a source of switches, whatever names its fields share.
    assert!(notification_preferences(&PetSettingsRecord::defaults(PetSettingsDomain::Care)).is_none());

    // A field the record does not carry takes its default — the same answer the settings page gives
    // for it (§10.2's migration rule), rather than failing the read and silencing every switch.
    let partial = record(PetSettingsDomain::Notification, 2, 1, json!({ "doNotDisturb": true }));
    let switches = notification_preferences(&partial).expect("the missing fields default");
    assert!(switches.do_not_disturb);
    assert!(switches.on_turn_finished, "the shipped default, not false");
    assert!(!switches.show_task_title, "§6.3's privacy default");

    // And a record whose values are not switches at all is refused rather than half-read.
    let broken = record(
        PetSettingsDomain::Notification,
        2,
        1,
        json!({ "onTurnFinished": "yes" }),
    );
    assert!(notification_preferences(&broken).is_none());
}
