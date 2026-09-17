//! The pet's settings: what a stored record means, whether a write may be applied, and where the
//! records live (§5.3).
//!
//! The Rust half of `features/desktop-pet-settings/services/pet-settings-policy.ts`, and a mirror
//! of it rather than a second design. That file is a pure module — it reads no storage, reaches no
//! IPC and holds no state — so it decides one thing and this side decides it the same way; the
//! values half lives in [`values`] and this file is the record: the schema version, the revision,
//! and the four arms a read and a write each come back as. The TypeScript names are written beside
//! each function so a reader with both files open can see the pair.
//!
//! **The revision refuses rather than merges.** Two windows, and the loser must find out: a write
//! built on a revision that has moved is answered with `conflict` and the record that is there now,
//! and the caller reloads. It is never merged, because a merge is how a value the user changed on
//! another page gets undone. The rule is `platform/gateways/memory-pet/settings.ts`'s and
//! `agent_runtime/config_edit.rs`'s, and this is the third place it is written rather than a third
//! rule: the *token* differs because D1's contract fixes it as a per-domain counter, and the
//! behaviour a loser meets is the same one. A revision *ahead* of the store is refused the same way
//! — a window that could assert an unseen higher number would win every later conflict by
//! announcing a number nobody issued.
//!
//! **A schema from a newer build is read-only.** The version check precedes every other one: data
//! written by a newer build is reported and left alone, and it has to be decided *before* the
//! fields are examined. Reading a future record as "this version, with defaults for anything I did
//! not recognise" is the overwrite the rule exists to prevent, and it is exactly what a caller
//! would then write back.
//!
//! **The split.** Three files by responsibility and not by length (§13.1): [`values`] is what a
//! value may be, this file is what a *record* means, and [`store`] is where a record lives. The
//! TypeScript half draws the same line between `pet-settings-values.ts` and
//! `pet-settings-policy.ts`; the store is the half that has no TypeScript counterpart, because the
//! double it mirrors is `memory-pet/settings.ts` and a double keeps nothing on a disk.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::notification_policy::NotificationPreferences;

pub mod fields;
pub mod store;
pub mod values;

pub use fields::{Field, Kind, MemberRule};
pub use store::{PetSettingsStore, SETTINGS_DIR};
pub use values::{Problem, ProblemKind, Readout};

/// The schema version this build writes: D7d's bump to 2, the bump to 3 that added
/// `general.characterWindow`, and the bump to 4 that gave the ball a size and took the master switch
/// away.
///
/// 2 is 1 plus the animation, phrase and layout fields the ledger's remaining rows needed; 3 is 2
/// plus the second of the pet's two per-window switches; 4 is 3 plus `general.ballSize` **and** the
/// change to what `general.enabled` means. Each bump is what makes the read-only rule do its work in
/// the other direction: a build that only knows the older version meets the newer record, reports
/// `read-only` and leaves it alone instead of reading the fields it recognises, defaulting the ones
/// it does not, and writing that back over what the user chose — for `characterWindow` that would be
/// a window they had switched off.
///
/// The 3→4 bump is the first one whose *meaning* moved rather than the field list, and it is why the
/// number is not merely bookkeeping: a 3 record's `enabled: false` was a master switch turned off —
/// "no pet window at all" — and reading it as the derived value would say `true` for a record whose
/// two switches were both on, bringing a pet back for someone who had put it away. [`migrate`] is
/// where that is answered, and the version is how it knows to.
/// `pet-contracts/config.ts` declares the same number, and `the_schema_version_is_the_typescript_one`
/// reads it off disk.
pub const PET_SETTINGS_SCHEMA_VERSION: i64 = 4;

/// The version `general.enabled` stopped being a master switch the user could set.
///
/// Named rather than spelled as a literal in [`migrate`], because it is a fact about the schema
/// rather than about one step: every record older than this one carries a master switch, and a
/// reader of the migration should be able to see which builds wrote one.
const MASTER_SWITCH_VERSION: i64 = 4;

/// The revision a domain that has never been written is at.
///
/// Named because both sides have to agree on it. A store that started its counter anywhere else
/// would turn the first write built from a `defaults` record into a false conflict, and the user's
/// first setting change would come back as "someone else changed this".
pub const PET_SETTINGS_INITIAL_REVISION: i64 = 0;

/// §5.3's independent schemas: one versioned record per domain.
///
/// Independent because they change for different reasons and at different speeds, and because §5.3
/// forbids threading one untyped object through every component: a restore-default action on one
/// page must not silently reset another. §5.1's 高级与集成 has no schema here — its contents are the
/// external-monitor, cloud and ranking features, which have not been agreed and whose schema would
/// be shipping a shape for a feature that does not exist.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PetSettingsDomain {
    General,
    Character,
    View,
    Message,
    Notification,
    Care,
    Project,
}

impl PetSettingsDomain {
    /// Every domain, in the schema's own order. The one list: `parse` and `ids` are both built
    /// from it, so a domain added to the enum and forgotten here fails `every_domain_round_trips`
    /// rather than becoming a string no caller can use.
    pub const ALL: [PetSettingsDomain; 7] = [
        PetSettingsDomain::General,
        PetSettingsDomain::Character,
        PetSettingsDomain::View,
        PetSettingsDomain::Message,
        PetSettingsDomain::Notification,
        PetSettingsDomain::Care,
        PetSettingsDomain::Project,
    ];

    /// The name this domain is stored and sent under, as `PET_SETTINGS_DOMAINS` spells it.
    pub fn id(self) -> &'static str {
        match self {
            PetSettingsDomain::General => "general",
            PetSettingsDomain::Character => "character",
            PetSettingsDomain::View => "view",
            PetSettingsDomain::Message => "message",
            PetSettingsDomain::Notification => "notification",
            PetSettingsDomain::Care => "care",
            PetSettingsDomain::Project => "project",
        }
    }

    /// The domain `id` names, or `None` — a request's string is a caller's, and this is where it
    /// stops being one.
    pub fn parse(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|domain| domain.id() == id)
    }

    /// The names, for a refusal that says what the caller could have asked for.
    pub fn ids() -> [&'static str; 7] {
        Self::ALL.map(Self::id)
    }
}

/// One domain's values, with the version they were written under and the revision they are at.
///
/// The record's shape is D1's (`pet-contracts/config.ts`), field for field, because a record on
/// disk and a record on the wire are the same fact: the settings file a user can open holds exactly
/// what an IPC answer carries.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSettingsRecord {
    pub domain: PetSettingsDomain,
    pub schema_version: i64,
    pub revision: i64,
    pub values: Map<String, Value>,
}

impl PetSettingsRecord {
    /// The record a domain that has never been written reads as: this build's version, the initial
    /// revision, and the schema's own defaults.
    pub fn defaults(domain: PetSettingsDomain) -> Self {
        Self {
            domain,
            schema_version: PET_SETTINGS_SCHEMA_VERSION,
            revision: PET_SETTINGS_INITIAL_REVISION,
            values: values::defaults(domain),
        }
    }

    /// One field of the record, or `None` when this build's schema does not declare it. Every read
    /// of a record's values goes through here, so "the field exists" is asked once.
    pub fn value(&self, field: &str) -> Option<&Value> {
        self.values.get(field)
    }
}

/// One domain's write: the whole domain's values, at the revision the caller read.
///
/// `revision` is a JSON number and not an integer type, because the contract's revision is a
/// JavaScript number: a form that submits `3.0` has submitted the revision it read, and a
/// deserializer refusing it would be this side inventing a distinction the contract does not make.
#[derive(Clone, PartialEq, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSettingsWrite {
    pub domain: PetSettingsDomain,
    pub revision: f64,
    pub values: Value,
}

/// What reading a domain produced — `readPetSettingsDomain`'s four arms.
///
/// Four arms because they are four different things the caller has to do, which is why they are not
/// a record with a flag: `defaults` and `migrated` may be written back, `current` need not be, and
/// `read_only` must not be.
#[derive(Clone, PartialEq, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PetSettingsLoad {
    Current {
        record: PetSettingsRecord,
    },
    Migrated {
        record: PetSettingsRecord,
        #[serde(rename = "fromVersion")]
        from_version: i64,
        /// Dotted paths whose stored value could not be used and took its rule's fallback.
        repaired: Vec<String>,
    },
    Defaults {
        reason: DefaultsReason,
        record: PetSettingsRecord,
    },
    ReadOnly {
        reason: ReadOnlyReason,
        #[serde(rename = "foundVersion")]
        found_version: i64,
    },
}

impl PetSettingsLoad {
    /// The record this read produced, or `None` when the answer is the one that has none.
    pub fn record(&self) -> Option<&PetSettingsRecord> {
        match self {
            PetSettingsLoad::Current { record }
            | PetSettingsLoad::Migrated { record, .. }
            | PetSettingsLoad::Defaults { record, .. } => Some(record),
            PetSettingsLoad::ReadOnly { .. } => None,
        }
    }
}

/// The notification switches a stored record holds, as §6.3's ledger reads them.
///
/// The mapping is a serde round-trip rather than seven `value("…")` calls, because the field names
/// have exactly one spelling — `NotificationPreferences`'s own rename, which
/// `desktop_pet_notification_test` pins against `pet-contracts/config.ts` — and a second spelling
/// written out by hand here would be a switch that silently stopped deciding the day one of the two
/// moved. The types do the rest: this is the one place the settings schema and the ledger meet, and
/// neither side has to name the other's shape.
///
/// `None` when the record is not the notification domain's, or when its values are not switches
/// this build can read — a file a user edited into a different shape. The caller keeps the switches
/// it has rather than deciding a notice from half a record, which is the same choice `read_domain`
/// makes one layer down when it answers `unreadable` instead of a record.
pub fn notification_preferences(record: &PetSettingsRecord) -> Option<NotificationPreferences> {
    if record.domain != PetSettingsDomain::Notification {
        return None;
    }
    serde_json::from_value(Value::Object(record.values.clone())).ok()
}

/// Why a read answered with this build's defaults rather than a record.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DefaultsReason {
    /// There is no record: nobody has written this domain yet.
    Absent,
    /// There is one and it cannot be read as a record.
    Unreadable,
}

/// Why a read answered with nothing at all.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadOnlyReason {
    /// The record was written by a build with a newer schema (§10.2).
    SchemaNewer,
}

/// What writing a domain produced — `decidePetSettingsWrite`'s four arms.
///
/// `conflict` is §5.3's cross-window rule: a write based on a revision that is no longer current is
/// refused and the caller reloads, with the record that is there now so it has something to reload
/// *from*. `failed` exists so a write that could not be persisted is neither reported as a success
/// nor turned into an exception the caller might treat as a bug; the edited value stays with the
/// caller and the write stays retryable.
#[derive(Clone, PartialEq, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PetSettingsUpdate {
    Applied {
        record: PetSettingsRecord,
    },
    Conflict {
        current: PetSettingsRecord,
    },
    Refused {
        reason: RefusalReason,
        message: String,
    },
    Failed {
        message: String,
    },
}

/// Why a write was refused before anything was written.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefusalReason {
    /// The submission is not a value this build can store, or it is for another domain.
    InvalidValue,
    /// The store is at a newer schema, so this build does not write it at all.
    SchemaNewer,
}

/// What one stored record is, as this build can read it — `readPetSettingsDomain`.
///
/// `stored` is the record as it was found, or `None` when there is none. The version check
/// precedes every other one and has to: reading a future record as "this version, with defaults for
/// anything I did not recognise" is the overwrite §10.2's 「遇到新版本数据，旧程序只读/报错，禁止按
/// 默认值覆盖」 exists to prevent, and it is exactly what a caller would then write back.
///
/// A record whose version or revision is not a whole, non-negative number cannot be written
/// against, so there is nothing here to merge a change into, and inventing a revision would hand
/// the caller a token the store never issued: that is the `unreadable` arm, which is also the one a
/// caller is meant to back the file up from before writing.
pub fn read_domain(domain: PetSettingsDomain, stored: Option<&Value>) -> PetSettingsLoad {
    let Some(stored) = stored else {
        return defaults_load(domain, DefaultsReason::Absent);
    };
    let Some(object) = stored.as_object() else {
        return unreadable_load(domain);
    };
    let Some(version) = whole_number(object.get("schemaVersion")) else {
        return unreadable_load(domain);
    };
    if version > PET_SETTINGS_SCHEMA_VERSION {
        return PetSettingsLoad::ReadOnly {
            reason: ReadOnlyReason::SchemaNewer,
            found_version: version,
        };
    }
    let Some(revision) = whole_number(object.get("revision")) else {
        return unreadable_load(domain);
    };
    // What an older build *meant* by a field is read here, once, rather than by every reader of the
    // field forever — and it runs on the *stored* values rather than on the normalized ones, because
    // the field it is about is one normalization recomputes: a schema-3 `enabled: false` is gone the
    // moment the derived value is written back over it.
    let mut raw_values = object.get("values").cloned().unwrap_or(Value::Null);
    migrate(domain, version, &mut raw_values);
    let Some(readout) = values::read_stored_values(domain, &raw_values) else {
        return unreadable_load(domain);
    };
    // The upgraded record carries *this* build's version, so a write-back is an upgrade rather
    // than a migration that has to be replayed on every read.
    let record = PetSettingsRecord {
        domain,
        schema_version: PET_SETTINGS_SCHEMA_VERSION,
        revision,
        values: readout.values,
    };
    if version == PET_SETTINGS_SCHEMA_VERSION {
        // `current` carries no field for repairs, so a current-version record with an unusable
        // value is normalized without a report here; a caller that needs the list calls
        // `values::read_values` itself.
        PetSettingsLoad::Current { record }
    } else {
        PetSettingsLoad::Migrated {
            record,
            from_version: version,
            repaired: readout.repaired,
        }
    }
}

/// What an older record's values mean in this build's schema, applied once on the way in.
///
/// One migration so far, and it is a change of *meaning* rather than of shape: `general.enabled` was
/// a master switch through schema 3 — with it off there was no pet window at all, whichever way
/// `characterWindow` and `ball` were set — and is derived from those two switches from 4 on. Reading
/// a 3 record's `enabled: false` as the derived value would compute *true* for a record whose both
/// switches were on: the user had asked for no pet at all, and they would get one back. That is the
/// regression a schema bump exists to prevent, and it is the reason this one happened.
///
/// So the old master's *off* is written into the two switches it used to stand above. Both go off,
/// the derived value is `false` for the right reason, and the user's answer survives the upgrade.
/// Everything else a 3 record carries is this build's already — `characterWindow` and `ball` are
/// fields of both schemas, and `ballSize` is a field a 3 record simply does not have, which is what
/// the schema's own default is for — so there is no second step here.
///
/// It mutates the *stored* object rather than the normalized one, and it has to: the field it is
/// about is the one normalization recomputes, so a derived `enabled: true` would have hidden the
/// user's answer from this function.
fn migrate(domain: PetSettingsDomain, version: i64, raw: &mut Value) {
    if domain != PetSettingsDomain::General || version >= MASTER_SWITCH_VERSION {
        return;
    }
    let Some(values) = raw.as_object_mut() else {
        // Not an object at all: `read_stored_values` answers `None` for it a line later, and there
        // is nothing here to migrate in any case.
        return;
    };
    if values.get("enabled").and_then(Value::as_bool) != Some(false) {
        return;
    }
    values.insert("characterWindow".to_string(), Value::Bool(false));
    values.insert("ball".to_string(), Value::Bool(false));
}

/// Whether one submitted write may be applied — `decidePetSettingsWrite`.
///
/// The refusals are ordered by what the caller has to do about them: a newer store is refused
/// before anything else, so a build that meets data from its future does not overwrite it even with
/// a write that *looks* current; a write for another domain is refused, because the record's
/// `domain` and the submission's are two halves of one fact and a mismatch means the pair was
/// assembled wrong; and a submission that is not at the revision the caller read is a *conflict*,
/// refused so the caller reloads.
///
/// What is deliberately absent is a `failed` arm: this function cannot fail to decide, and "the
/// store could not persist it" is a fact about the store rather than a judgement about a
/// submission.
pub fn decide_write(stored: &PetSettingsRecord, write: &PetSettingsWrite) -> PetSettingsUpdate {
    if stored.schema_version > PET_SETTINGS_SCHEMA_VERSION {
        return PetSettingsUpdate::Refused {
            reason: RefusalReason::SchemaNewer,
            message: schema_newer_message(stored.domain, stored.schema_version),
        };
    }
    if stored.domain != write.domain {
        return PetSettingsUpdate::Refused {
            reason: RefusalReason::InvalidValue,
            message: format!(
                "a {} write against a {} record",
                write.domain.id(),
                stored.domain.id()
            ),
        };
    }
    if (stored.revision as f64) != write.revision {
        return PetSettingsUpdate::Conflict {
            current: stored.clone(),
        };
    }
    let problems = values::problems(write.domain, &write.values);
    if !problems.is_empty() {
        return PetSettingsUpdate::Refused {
            reason: RefusalReason::InvalidValue,
            message: values::problem_message(&problems),
        };
    }
    let readout = values::read_values(write.domain, &write.values);
    PetSettingsUpdate::Applied {
        record: PetSettingsRecord {
            domain: write.domain,
            schema_version: PET_SETTINGS_SCHEMA_VERSION,
            revision: stored.revision + 1,
            values: readout.values,
        },
    }
}

/// The sentence a store at a newer schema is refused with, as the TypeScript half spells it.
fn schema_newer_message(domain: PetSettingsDomain, found: i64) -> String {
    format!(
        "{} is at schema {found}; this build writes {PET_SETTINGS_SCHEMA_VERSION}",
        domain.id()
    )
}

/// The answer for a record that is there and could not be read.
///
/// Shared by [`read_domain`] and [`store`], because "the file is not a record" and "the file could
/// not be read at all" are one answer: what the caller does about them is the same, which is to
/// treat the store as one it has nothing to write against — and to back the file up before
/// overwriting it.
pub(crate) fn unreadable_load(domain: PetSettingsDomain) -> PetSettingsLoad {
    defaults_load(domain, DefaultsReason::Unreadable)
}

/// The answer for a domain that has no record this build can write against.
fn defaults_load(domain: PetSettingsDomain, reason: DefaultsReason) -> PetSettingsLoad {
    PetSettingsLoad::Defaults {
        reason,
        record: PetSettingsRecord::defaults(domain),
    }
}

/// A JSON value that is a whole, non-negative number, as the `i64` a revision or a version is.
///
/// `Number.isInteger(value) && value >= 0`, as `pet-settings-policy.ts` asks it — asked of the
/// number rather than of the `serde_json::Number`, because a document that spells `3.0` is the
/// integer three to the other half and has to be one to this half too.
fn whole_number(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || number < 0.0 || number > i64::MAX as f64 {
        return None;
    }
    Some(number as i64)
}
