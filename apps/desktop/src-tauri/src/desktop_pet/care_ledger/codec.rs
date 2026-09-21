//! The care ledger as bytes: one record, written whole, and what a read may and may not do with it.
//!
//! **Why the codec is here and the file is not.** `tests/desktop_pet_care_test/local.rs` holds this
//! module to a rule it states as 「progress is local and must stay local」: every file `care_ledger` is
//! built from is scanned, and none of them may name `std::fs`, `File::`, a socket, a process or a
//! credential. So the *shape* of the record lives here — pure conversion, no path, no lock, no I/O —
//! and the file it is written to lives in the sibling `desktop_pet::care_store`, which owns the path
//! and the atomic replacement. The split is the one `history` already makes one directory over
//! (`history.rs` encodes, `history/store.rs` writes), and it is what keeps the invariant true rather
//! than narrowing it: the ledger's rules cannot reach a disk, and the code that can is somewhere a
//! reader can see it.
//!
//! **The record is a translation, not a `derive` on the ledger.** A `#[derive(Serialize)]` on
//! [`CareLedger`] would put the wire shape and the working shape in one declaration, which is exactly
//! the coupling `pet-contracts/task.ts` warns about for the task vocabulary: a field renamed for the
//! ledger's own reasons would silently become a field renamed on disk, and an old file would read as a
//! ledger with a default in it. The record below is written out field by field for the same reason
//! `desktop_pet_task_projection_test/support.rs` writes its envelopes out field by field — a field
//! added to the ledger is a compile error here, not a file that quietly loses it.
//!
//! **Days and runs are lists, not maps.** Everything else could be either; these two cannot be maps
//! with their keys as JSON object keys, because `LocalDay` is a struct and a run is named by a token
//! that may hold any byte. A list is also the honest shape for a file whose reader is a person: the
//! day a meal was paid is written as `2026-09-21`, the spelling [`LocalDay::key`] already owns.

use serde::{Deserialize, Serialize};

use super::{CareDecision, CareLedger, DayTally, LocalDay, LEDGER_SCHEMA_VERSION};

/// What one read of a stored record produced.
///
/// Three arms rather than two, and each is an answer a caller has to *do* something with rather than
/// a flag on one: a record this build can use, a record a newer build wrote, and bytes that are not a
/// record at all. §10.2's newer-record rule is the second — it must not be read as "this version, with
/// defaults", because the first write after that reading replaces a newer build's file with this one's
/// understanding of it.
#[derive(Debug)]
pub enum Decoded {
    /// The ledger the record held.
    Restored(Box<CareLedger>),
    /// The bytes are not this record — a truncated write, a hand-edited file, a newer shape this
    /// build's schema version does not admit to. The consequence is bounded and worth stating: the
    /// ledger starts empty, so a run that was already paid may be paid again. The caller says so
    /// rather than pretending, which is why this arm carries the reason.
    Unreadable { detail: String },
    /// A newer build wrote it. Read-only from here: nothing this build saves may replace it.
    NewerSchema { found: u32 },
}

/// One decided run, as a row.
///
/// `key` is `PetTaskKey::token()` — the contract's own `petTaskToken`
/// (`pet-contracts/task.ts:90`), which the ledger's producer hands over as the settlement key, so the
/// map that stops a replay is keyed by the same string here as it is in memory.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecidedRow {
    key: String,
    decision: CareDecision,
}

/// One day of the trailing window, as a row.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DayRow {
    /// `YYYY-MM-DD`, the spelling [`LocalDay::key`] writes and [`LocalDay::parse`] refuses to guess at.
    day: String,
    completions: u64,
    /// `None` is 「nobody reported any」 and never a zero: §8's rule survives the file too.
    #[serde(default)]
    tokens: Option<u64>,
}

/// The record as it is written.
///
/// Every field is spelled out rather than flattened from the ledger, and `rename_all = "camelCase"`
/// matches the vocabulary the TypeScript reader uses for the same facts (`pet-contracts/care.ts`),
/// so a file and the wire agree about what a field is called.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CareRecord {
    schema_version: u32,
    revision: u64,
    xp: u64,
    meals: u64,
    decided: Vec<DecidedRow>,
    recorded: Vec<String>,
    days: Vec<DayRow>,
    streak_days: u32,
    /// `YYYY-MM-DD` or absent. Absent is a ledger that has never settled on a day.
    streak_day: Option<String>,
    reported_tokens: Option<u64>,
    unreported_runs: u64,
    last_settled_at: Option<i64>,
}

impl CareLedger {
    /// The ledger as the bytes a store writes.
    ///
    /// `expect` rather than a `Result`, and the reason is the type rather than the mood: every field
    /// is an integer, a string, an optional or a list of those, and `serde_json` cannot fail to write
    /// one — the same argument `TaskHistory::encode` makes one directory over. A `Result` here would
    /// be an error a caller has to handle and can never produce, which is how a real failure gets
    /// lumped in with an impossible one.
    pub fn encode(&self) -> String {
        let record = CareRecord {
            schema_version: self.schema_version,
            revision: self.revision,
            xp: self.xp,
            meals: self.meals,
            decided: self
                .decided
                .iter()
                .map(|(key, decision)| DecidedRow {
                    key: key.clone(),
                    decision: *decision,
                })
                .collect(),
            recorded: self.recorded.iter().cloned().collect(),
            days: self
                .days
                .iter()
                .map(|(day, tally)| DayRow {
                    day: day.key(),
                    completions: tally.completions,
                    tokens: tally.tokens,
                })
                .collect(),
            streak_days: self.streak_days,
            streak_day: self.streak_day.map(|day| day.key()),
            reported_tokens: self.reported_tokens,
            unreported_runs: self.unreported_runs,
            last_settled_at: self.last_settled_at,
        };
        serde_json::to_string(&record).expect("a record of counts and days always serialises")
    }

    /// Read a stored ledger back (§8's progress across a restart).
    ///
    /// **Refused whole rather than partly.** A day key that is not a date, or a record whose required
    /// field is missing, is [`Decoded::Unreadable`] — never "the fields that parsed, and defaults for
    /// the rest". That is `care_ledger/import.rs`'s rule for a file a user hands in, and it holds for
    /// this one for a stronger reason: a partially read ledger would be *written back*, so the fields
    /// this build could not read would be gone from the file as well as from memory.
    ///
    /// `schema_version` is compared before anything else is believed. Equal is this build's record;
    /// lower is an older build's, and is read as it stands — those fields are the ones it wrote;
    /// higher is [`Decoded::NewerSchema`], which the store latches so nothing here can replace it.
    pub fn decode(raw: &str) -> Decoded {
        let parsed = match serde_json::from_str::<CareRecord>(raw) {
            Ok(parsed) => parsed,
            Err(error) => {
                return Decoded::Unreadable {
                    detail: error.to_string(),
                }
            }
        };
        if parsed.schema_version > LEDGER_SCHEMA_VERSION {
            return Decoded::NewerSchema {
                found: parsed.schema_version,
            };
        }

        let mut decided = std::collections::BTreeMap::new();
        for row in parsed.decided {
            // A duplicate key is not an error: the map is the dedup memory, and a file that named one
            // run twice would be a file written twice, with the later row the one that was last true.
            decided.insert(row.key, row.decision);
        }
        let mut days = std::collections::BTreeMap::new();
        for row in parsed.days {
            let Some(day) = LocalDay::parse(&row.day) else {
                return Decoded::Unreadable {
                    detail: format!("{:?} is not a calendar day", row.day),
                };
            };
            days.insert(
                day,
                DayTally {
                    completions: row.completions,
                    tokens: row.tokens,
                },
            );
        }
        let streak_day = match parsed.streak_day {
            Some(day) => match LocalDay::parse(&day) {
                Some(day) => Some(day),
                None => {
                    return Decoded::Unreadable {
                        detail: format!("{day:?} is not a calendar day"),
                    }
                }
            },
            None => None,
        };

        Decoded::Restored(Box::new(CareLedger {
            schema_version: parsed.schema_version,
            revision: parsed.revision,
            xp: parsed.xp,
            meals: parsed.meals,
            decided,
            recorded: parsed.recorded.into_iter().collect(),
            days,
            streak_days: parsed.streak_days,
            streak_day,
            reported_tokens: parsed.reported_tokens,
            unreported_runs: parsed.unreported_runs,
            last_settled_at: parsed.last_settled_at,
        }))
    }
}
