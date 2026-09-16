/**
 * The import merge — §4's 导入回退 clause, and the half of the ledger that only ever raises.
 *
 * This is the second file of `care_ledger.rs`, and the split is by what each half has to be true of
 * rather than by size. Settlement has to be idempotent across replays and restarts, so it owns the
 * per-run decision record; an import must not be able to walk a user's progress backwards, so it
 * owns the raise-only merge and the revision a submission was read against. Neither rule can be
 * stated in the other's terms. What both halves share — [`super::LocalDay`], [`super::DayTally`] and
 * the `IMPORT_*` field names in the module root — stays there, which is where the tests and
 * `pet-care-rules.ts`'s reader already look for the ledger's vocabulary.
 *
 * [`CareLedger::import`] follows D6's shape for the write — a submission carries the revision it was
 * read at, and a stale one is a [`CareImportOutcome::Conflict`] that writes nothing rather than a
 * merge — and §4's rule for what a repair may do: **it only raises**. A total below the one already
 * here is kept and reported as kept, a badge is added and never removed, and a file that does not
 * parse is refused whole: reading the fields that parsed and defaulting the rest is the
 * "normalisation" that discards a user's progress while looking like a success.
 */
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{
    CareLedger, DayTally, LocalDay, IMPORT_DAYS, IMPORT_MEALS, IMPORT_STREAK, IMPORT_TOKENS,
    IMPORT_XP,
};

/**
 * A file's worth of progress, offered to [`CareLedger::import`].
 *
 * Every field is optional and the names are upstream's own (`CareState`, `care.ts:11-24`), so a file
 * the user picked parses as far as it can be read. A field that is *absent* is not a zero: it is a
 * fact the file did not carry, and the merge leaves the ledger's own value alone.
 */
#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CareImportPayload {
    pub xp: Option<u64>,
    pub total_meals: Option<u64>,
    pub total_tokens: Option<u64>,
    pub streak_days: Option<u32>,
    /// Upstream's `lastFedDayKey`: the day a streak counts from — without it the count cannot be
    /// placed on a calendar.
    pub last_fed_day_key: Option<String>,
    /// Upstream's `days`: day key → tokens.
    pub days: BTreeMap<String, u64>,
    /// Upstream's `unlockedAchievements`. Kept verbatim, including ids this build cannot name.
    pub unlocked_achievements: Vec<String>,
}

/// One import: what was read, and the revision it was read against.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CareImport {
    /// The revision the caller read (§5.3). A submission built against an older one is refused.
    pub revision: u64,
    /// The schema version the record was written under.
    pub schema_version: u32,
    pub payload: CareImportPayload,
}

/// What the merge did, field by field, so a page can show the user what changed (§5.3's 预览差异).
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CareImportReport {
    /// Fields the file raised, by [`IMPORT_FIELDS`](super::IMPORT_FIELDS)' names.
    pub raised: Vec<String>,
    /// Fields the ledger already had at or ahead of the file. Kept — nothing was lowered.
    pub kept: Vec<String>,
    /// Badge ids the file carried that the ledger did not have. Added, never removed.
    pub badges_added: usize,
    /// The revision the merge produced, which is the one the caller read when nothing moved.
    pub revision: u64,
}

/// Why an import was refused whole — the file is refused rather than half-read; see the header.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CareImportRefusal {
    /// The record was written by a newer build (§10.2: read it, do not overwrite it).
    SchemaNewer,
}

impl CareImportRefusal {
    pub fn detail(self) -> &'static str {
        match self {
            CareImportRefusal::SchemaNewer => {
                "this progress was recorded by a newer version of the app, so it is read and not written"
            }
        }
    }
}

/// What an import did.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CareImportOutcome {
    Merged(CareImportReport),
    /// The ledger moved between the read and the submission. Nothing was written, and nothing is
    /// merged on the way past: a merge is how a value the user just earned gets undone.
    Conflict { current_revision: u64 },
    Refused {
        reason: CareImportRefusal,
        detail: String,
    },
}

impl CareLedger {
    /**
     * Merge a record the user picked a file for. Raises; never lowers, never removes.
     *
     * The order of the checks is the order of what a caller has to do about them: a newer record is
     * refused first (nothing sensible could be merged into it), a stale submission is a conflict that
     * says to read again, and only then does the merge run. The revision moves **only when something
     * moved**, so importing the same file twice leaves the ledger — and its revision — where the first
     * import left it, which is what makes an import safe to retry.
     */
    pub fn import(&mut self, submission: CareImport) -> CareImportOutcome {
        if submission.schema_version > self.schema_version {
            return CareImportOutcome::Refused {
                reason: CareImportRefusal::SchemaNewer,
                detail: CareImportRefusal::SchemaNewer.detail().to_string(),
            };
        }
        if submission.revision != self.revision {
            return CareImportOutcome::Conflict {
                current_revision: self.revision,
            };
        }

        let payload = submission.payload;
        let mut raised: Vec<String> = Vec::new();
        let mut kept: Vec<String> = Vec::new();

        if let Some(xp) = payload.xp {
            raise(&mut self.xp, xp, IMPORT_XP, &mut raised, &mut kept);
        }
        if let Some(meals) = payload.total_meals {
            raise(&mut self.meals, meals, IMPORT_MEALS, &mut raised, &mut kept);
        }
        // A file that carried no usage total at all offered nothing and is not reported; one that
        // carried a total is compared against the known one, where `None` sorts below every total —
        // so a file that reports nothing cannot cover a ledger that does.
        if let Some(tokens) = payload.total_tokens {
            raise(
                &mut self.reported_tokens,
                Some(tokens),
                IMPORT_TOKENS,
                &mut raised,
                &mut kept,
            );
        }
        self.import_streak(&payload, &mut raised, &mut kept);
        self.import_days(&payload, &mut raised, &mut kept);

        let mut badges_added = 0;
        for id in &payload.unlocked_achievements {
            if self.recorded.insert(id.clone()) {
                badges_added += 1;
            }
        }

        if !raised.is_empty() || badges_added > 0 {
            self.revision += 1;
        }
        CareImportOutcome::Merged(CareImportReport {
            raised,
            kept,
            badges_added,
            revision: self.revision,
        })
    }

    /// A streak is a pair — how many days, and the day they count from — and half of one cannot be
    /// placed on a calendar, so a file carrying only half has it kept rather than guessed at.
    fn import_streak(
        &mut self,
        payload: &CareImportPayload,
        raised: &mut Vec<String>,
        kept: &mut Vec<String>,
    ) {
        let offered = payload.streak_days.unwrap_or(0);
        let Some(day) = payload.last_fed_day_key.as_deref().and_then(LocalDay::parse) else {
            if offered > 0 {
                kept.push(IMPORT_STREAK.to_string());
            }
            return;
        };
        if offered == 0 {
            return;
        }
        // A later day wins outright; the same day wins only on a longer streak. An *earlier* day never
        // wins, however long a streak it claims: importing an old file must not walk the user back.
        let ahead = match self.streak_day {
            None => true,
            Some(mine) => {
                day.ordinal() > mine.ordinal() || (day == mine && offered > self.streak_days)
            }
        };
        if ahead {
            self.streak_days = offered;
            self.streak_day = Some(day);
            raised.push(IMPORT_STREAK.to_string());
        } else {
            kept.push(IMPORT_STREAK.to_string());
        }
    }

    /// Upstream's `days` is day key → tokens, so each key raises that day's *usage*; completions
    /// cannot be recovered from it and are left as the ledger has them.
    fn import_days(
        &mut self,
        payload: &CareImportPayload,
        raised: &mut Vec<String>,
        kept: &mut Vec<String>,
    ) {
        let (mut moved, mut stayed) = (false, false);
        for (key, tokens) in &payload.days {
            let Some(day) = LocalDay::parse(key) else {
                stayed = true;
                continue;
            };
            let tally = self.days.entry(day).or_default();
            let merged = tally.raise(DayTally {
                completions: tally.completions,
                tokens: Some(*tokens),
            });
            if merged == *tally {
                stayed = true;
            } else {
                *tally = merged;
                moved = true;
            }
        }
        if moved {
            raised.push(IMPORT_DAYS.to_string());
        }
        if stayed {
            kept.push(IMPORT_DAYS.to_string());
        }
    }
}

/// Raise one total, or report it as kept, for one field a file actually carried.
///
/// Every such field lands in exactly one of the two lists, so a page can show the whole story of an
/// import rather than only its surprises. A field the file did not carry is not passed here at all:
/// absent is not the same fact as zero.
fn raise<T: PartialOrd>(
    mine: &mut T,
    offered: T,
    field: &str,
    raised: &mut Vec<String>,
    kept: &mut Vec<String>,
) {
    if offered > *mine {
        *mine = offered;
        raised.push(field.to_string());
    } else {
        kept.push(field.to_string());
    }
}
