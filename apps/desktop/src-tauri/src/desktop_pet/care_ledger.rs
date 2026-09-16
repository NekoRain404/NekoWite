/**
 * The care ledger: what a verified completion paid, and the record that it paid once.
 *
 * Ported from `references/desktop-pet/windows/src/care.ts` at commit
 * `be171a01273a1ed92a27bcdf72f8a58768bac421` — `recordMeal`/`feedTokens` (`care.ts:167-195`), the
 * per-pet store (`:207-232`) and the streak bookkeeping (`:155-165`). The level curve, the badge
 * table, the names and the chart are *not* here; they are `pet-care-rules.ts`.
 *
 * ## The seam: settlement here, meaning there
 *
 * §9 forbids one rule with two homes: 「可改为后端执行规则，但不得前后端维护两份规则真相」. Settlement is
 * here because it must be idempotent across replays and restarts, because it must see the *moment* a
 * run ended, and because a window that could write it could submit any amount of XP. Meaning — which
 * level a total is, how full the bar is, which badges the totals have crossed — is in
 * `pet-care-rules.ts`, where it is a pure function of [`CareLedger::summary`].
 *
 * So [`RECORDED_BADGES`] holds exactly one entry. Thirteen of upstream's fourteen badges follow from
 * the settled totals, and recording them here would be the second table of thresholds §9 forbids;
 * `nightOwl` (`care.ts:71`) is earned by the hour a meal happened at, so it is recorded.
 *
 * ## What a day is (the 日期/时区 clause)
 *
 * **A day is the machine's local calendar day at the moment the reward settles.** The host reads it
 * once from its injected clock — this module owns no clock, not `chrono` and not `SystemTime` — and
 * the key it yields is stored with the reward. Nothing here turns a timestamp into a day later, so
 * nothing here can be wrong about a timezone: a completion at 23:59 local stays on that day when the
 * record is read in another country a week on, which is what a UTC-derived key destroys for part of
 * every day wherever the offset is not zero.
 *
 * The streak is where that becomes visible. A machine that crossed a timezone, or whose clock was
 * corrected, can hand back a day *earlier* than the last one settled: that leaves the streak and its
 * day exactly as they were, so the sequence continues when the clock comes back — a flight west is
 * not a broken streak. Exactly one day later grows it, the same day is unchanged, and two or more
 * days on restarts it at one.
 *
 * ## What is not here (the 无 token clause)
 *
 * No network, no credential, no account, no price. Nothing here can hold a token *string*, a login or
 * a subscription, and nothing here can reach a socket — `tests/desktop_pet_care_test/local.rs` reads
 * this file and asserts as much. Usage exists only as [`CareEvent::tokens`], an `Option<u64>` an
 * engine *reported*, and it pays nothing: XP comes from verified completions alone, so a run whose
 * usage nobody reported earns what a known count earns. §8's 「token 未知不是 0」 is enforced in the
 * merge — an unreported day stays `None`, and `None` merged with a reported `Some(0)` is `Some(0)`.
 *
 * ## Import (the 导入回退 clause) — its own file
 *
 * [`CareLedger::import`] is the module's other half, and it is in `care_ledger/import.rs`: settlement
 * decides one run under a rule about replays, and an import merges a file the user picked under a rule
 * about never walking progress back — neither rule can be stated in the other's terms. The two halves
 * share this file's vocabulary (the types above and the `IMPORT_*` field names below) and nothing
 * else; the merge, its refusal and its revision rule are all in the child, with the reasoning.
 */
mod import;

pub use import::{
    CareImport, CareImportOutcome, CareImportPayload, CareImportRefusal, CareImportReport,
};

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// XP one verified completion pays. Upstream's `MEAL_XP` (`care.ts:7`), kept.
pub const MEAL_XP: u64 = 25;

/// How many days of history the ledger keeps (upstream keeps fourteen, `care.ts:176`).
pub const DAY_WINDOW: usize = 14;

/// The ledger's own schema version. Data from a newer one is refused rather than read (§10.2).
pub const LEDGER_SCHEMA_VERSION: u32 = 1;

/// The one badge settlement records: earned by the hour a meal happened at (`care.ts:71`).
pub const NIGHT_OWL: &str = "nightOwl";

/**
 * The badges settlement records rather than leaves to be derived.
 *
 * One entry, and the length is the point: a badge recomputable from [`CareLedger::summary`] does not
 * belong in a stored set, and a second entry here means a second badge that cannot be derived — never
 * a short-cut for a threshold the display side already has.
 */
pub const RECORDED_BADGES: [&str; 1] = [NIGHT_OWL];

/// One field an import can raise, as the id a surface looks a word up by.
pub const IMPORT_XP: &str = "xp";
pub const IMPORT_MEALS: &str = "meals";
pub const IMPORT_STREAK: &str = "streak";
pub const IMPORT_DAYS: &str = "days";
pub const IMPORT_TOKENS: &str = "tokens";

/// Every field an import can raise, in the order a report lists them. The words are
/// `pet-care-rules.ts`'s, the way §7.2's capability names are D1's, and there is deliberately no
/// "other" arm: a field that could be raised with no name is a change nobody is told about.
pub const IMPORT_FIELDS: [&str; 5] = [
    IMPORT_XP,
    IMPORT_MEALS,
    IMPORT_STREAK,
    IMPORT_DAYS,
    IMPORT_TOKENS,
];

/**
 * A civil date in the machine's local calendar — a day as a person writes one down.
 *
 * Deliberately not a timestamp: a timestamp is an instant, and the clause is that difference.
 * [`LocalDay::parse`] is strict, so a stored `2026-02-30` is refused rather than counted.
 */
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub struct LocalDay {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl LocalDay {
    /// `YYYY-MM-DD`, zero-padded: the spelling upstream's `dayKey` writes and reads (`care.ts:142-145`).
    pub fn key(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    /// The day a key names, or `None` when it is not a date — including one that does not exist.
    pub fn parse(key: &str) -> Option<Self> {
        let (year, rest) = key.split_once('-')?;
        let (month, day) = rest.split_once('-')?;
        if year.len() != 4 || month.len() != 2 || day.len() != 2 {
            return None;
        }
        let (year, month, day) = (
            year.parse::<i32>().ok()?,
            month.parse::<u32>().ok()?,
            day.parse::<u32>().ok()?,
        );
        if month == 0 || month > 12 || day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(LocalDay { year, month, day })
    }

    /// Days since 1970-01-01, so "the day after" is arithmetic rather than a calendar.
    ///
    /// Hinnant's days-from-civil: the arithmetic a `Date` has underneath it in the TS half, exact for
    /// every year `i32` holds, and the only calendar computation in either half.
    pub fn ordinal(&self) -> i32 {
        let year = self.year - i32::from(self.month <= 2);
        let era = if year >= 0 { year } else { year - 399 } / 400;
        let year_of_era = (year - era * 400) as u32;
        let month = self.month as i32;
        let day_of_year =
            (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + self.day as i32 - 1;
        let day_of_era =
            year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year as u32;
        era * 146_097 + day_of_era as i32 - 719_468
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

/// The host's reading of its own clock, as of one settled fact. Three fields because there are three
/// questions, and none follows from the others without the timezone this module does not know: the
/// day is a calendar question, the hour is that calendar's (the user's evening, not the server's),
/// and the instant answers *duration* — how long ago the last meal was.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct LocalTime {
    pub day: LocalDay,
    /// 0..=23, in the machine's local time.
    pub hour: u32,
    /// Epoch milliseconds, for durations only.
    pub at_ms: i64,
}

/**
 * How a run ended, for the one question settlement asks: does this pay?
 *
 * The vocabulary is `pet-contracts/task.ts`'s terminal states, mirrored rather than re-invented
 * (§6.1) and pinned to that file by `tests/desktop_pet_care_test/replay.rs`. §6.2's
 * endings-that-are-not-endings stay apart even though one of them pays, because a surface asked "why
 * did this earn nothing" would otherwise have to guess it back out of a boolean.
 */
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum CareOutcome {
    TurnFinished,
    Stopped,
    Refused,
    Cancelled,
    Failed,
    Interrupted,
}

/// Every outcome, in the contract's order. The pin test walks this list.
pub const CARE_OUTCOMES: [CareOutcome; 6] = [
    CareOutcome::TurnFinished,
    CareOutcome::Stopped,
    CareOutcome::Refused,
    CareOutcome::Cancelled,
    CareOutcome::Failed,
    CareOutcome::Interrupted,
];

impl CareOutcome {
    /// The state's own name in the contract, so the two vocabularies can be compared by a test.
    pub fn name(self) -> &'static str {
        match self {
            CareOutcome::TurnFinished => "turn-finished",
            CareOutcome::Stopped => "stopped",
            CareOutcome::Refused => "refused",
            CareOutcome::Cancelled => "cancelled",
            CareOutcome::Failed => "failed",
            CareOutcome::Interrupted => "interrupted",
        }
    }

    /// Whether this end earns anything. Exactly one does: §6.2's only completion is a turn that ended
    /// normally. A ceiling, a refusal, a failure and a lost runtime are four facts for the user and
    /// one thing here; a cancellation is named because §6.2 asks for 「不算失败奖励」 as well as no
    /// success sound — a cancelled run is neither paid nor counted against the pet.
    pub fn pays(self) -> bool {
        matches!(self, CareOutcome::TurnFinished)
    }
}

/// Where a fact came from. A demonstration or a preview is never the real ledger (§5.2).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CareOrigin {
    Real,
    Preview,
}

/// One trusted fact the runtime hands the ledger.
///
/// `key` is the run's identity as the task projection mints it (§6.1's `petTaskToken`), opaque here:
/// what a run *is* belongs to the projection, and the ledger's only interest is that one run cannot
/// be paid twice. No field here is one a window could fill in with a reward.
#[derive(Clone, Copy, Debug)]
pub struct CareEvent<'a> {
    pub key: &'a str,
    pub outcome: CareOutcome,
    pub at: LocalTime,
    /// Usage the engine reported, or `None` when it reported none. Never a guess, never a zero.
    pub tokens: Option<u64>,
    pub origin: CareOrigin,
}

/// Why an event was not even recorded. Both arms leave the ledger exactly as they found it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CareRefusal {
    /// A fact with no identity cannot be deduplicated, so paying it would be paying it every replay.
    NoIdentity,
    /// A preview's event: §5.2 keeps demonstration data out of real history, rewards and notifications.
    Preview,
}

impl CareRefusal {
    pub fn detail(self) -> &'static str {
        match self {
            CareRefusal::NoIdentity => {
                "this event carries no run identity, so a replay could not be told from a completion"
            }
            CareRefusal::Preview => {
                "this event came from a preview or a demonstration, which never reach the ledger"
            }
        }
    }
}

/// What the ledger decided about one run — stored, so a replay is answered with the decision that was
/// actually made rather than with whatever the caller claims now.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum CareDecision {
    Paid { xp: u64 },
    Unpaid { outcome: CareOutcome },
}

/// What one call to [`CareLedger::settle`] did.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CareSettlement {
    /// Whether *this* call is the one that decided the run. False means it had been decided already,
    /// possibly in an earlier process, and the totals are the ones that decision produced.
    pub first: bool,
    pub decision: CareDecision,
    /// Badges this call recorded, in [`RECORDED_BADGES`] order. Empty on a replay.
    pub badges: Vec<&'static str>,
}

/// One day's tally. `completions` is always known; `tokens` is known only if something reported one.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct DayTally {
    pub completions: u64,
    pub tokens: Option<u64>,
}

impl DayTally {
    /// Two runs on one day are two runs: settlement adds, and usage joins only where it was reported.
    fn add(self, tokens: Option<u64>) -> Self {
        DayTally {
            completions: self.completions + 1,
            tokens: match (self.tokens, tokens) {
                (None, reported) => reported,
                (known, None) => known,
                (Some(a), Some(b)) => Some(a.saturating_add(b)),
            },
        }
    }

    /// An import raises. The file is another view of the *same* history, so adding would count a
    /// second import of one file twice, and lowering it is the normalisation §4 forbids. Only a day
    /// nothing reported for stays unknown: one side reporting a zero is a fact about that day.
    fn raise(self, other: DayTally) -> Self {
        DayTally {
            completions: self.completions.max(other.completions),
            tokens: match (self.tokens, other.tokens) {
                (None, None) => None,
                (Some(known), None) | (None, Some(known)) => Some(known),
                (Some(mine), Some(theirs)) => Some(mine.max(theirs)),
            },
        }
    }
}

/// The ledger. Cloneable and comparable: a test holds a copy and proves a replay changed nothing.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct CareLedger {
    schema_version: u32,
    revision: u64,
    xp: u64,
    meals: u64,
    /// Every run that has been decided, by identity token, with its decision. Unbounded on purpose:
    /// forgetting an entry is the one way a reward can be paid twice.
    decided: BTreeMap<String, CareDecision>,
    /// Badges not derivable from a total ([`RECORDED_BADGES`]) plus whatever an import carried.
    /// Monotone — nothing in this file removes one.
    recorded: BTreeSet<String>,
    days: BTreeMap<LocalDay, DayTally>,
    streak_days: u32,
    streak_day: Option<LocalDay>,
    reported_tokens: Option<u64>,
    unreported_runs: u64,
    last_settled_at: Option<i64>,
}

impl CareLedger {
    /// An empty ledger at this build's schema version.
    pub fn new() -> Self {
        CareLedger {
            schema_version: LEDGER_SCHEMA_VERSION,
            ..CareLedger::default()
        }
    }

    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }

    /// The revision every write is based on (§5.3, the shape `pet-settings-policy.ts` uses).
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn xp(&self) -> u64 {
        self.xp
    }

    pub fn meals(&self) -> u64 {
        self.meals
    }

    pub fn streak_days(&self) -> u32 {
        self.streak_days
    }

    /// How many runs have been decided — not how many paid: a cancellation is a decision too.
    pub fn decided(&self) -> usize {
        self.decided.len()
    }

    /// Record one trusted fact.
    ///
    /// The replay arm is the idempotence clause: a run that has been decided returns the decision it
    /// was given — not a recomputation from what the caller says now — and **no field of this ledger
    /// changes**, not even the revision.
    pub fn settle(&mut self, event: CareEvent<'_>) -> Result<CareSettlement, CareRefusal> {
        if event.origin == CareOrigin::Preview {
            return Err(CareRefusal::Preview);
        }
        let key = event.key.trim();
        if key.is_empty() {
            return Err(CareRefusal::NoIdentity);
        }
        if let Some(decision) = self.decided.get(key) {
            return Ok(CareSettlement {
                first: false,
                decision: *decision,
                badges: Vec::new(),
            });
        }

        let (decision, badges) = if event.outcome.pays() {
            let badges = self.pay(&event);
            (CareDecision::Paid { xp: MEAL_XP }, badges)
        } else {
            // Recorded even though it pays nothing: "this run has been decided" is what stops a late
            // or re-delivered event from paying it afterwards (§6.3's terminal states are terminal).
            (
                CareDecision::Unpaid {
                    outcome: event.outcome,
                },
                Vec::new(),
            )
        };

        self.decided.insert(key.to_string(), decision);
        self.revision += 1;
        self.prune_days();
        Ok(CareSettlement {
            first: true,
            decision,
            badges,
        })
    }

    /// A paying completion: the totals, the day, the streak, the usage and the recorded badges.
    fn pay(&mut self, event: &CareEvent<'_>) -> Vec<&'static str> {
        self.xp = self.xp.saturating_add(MEAL_XP);
        self.meals += 1;
        self.days
            .entry(event.at.day)
            .and_modify(|tally| *tally = tally.add(event.tokens))
            .or_insert_with(|| DayTally::default().add(event.tokens));
        match event.tokens {
            Some(tokens) => self.reported_tokens = Some(self.reported_tokens.unwrap_or(0) + tokens),
            // §8: the usage is unknown, which is a fact about the record and not a zero in it.
            None => self.unreported_runs += 1,
        }
        self.last_settled_at = Some(event.at.at_ms);
        self.advance_streak(event.at.day);
        self.record_badges(event.at.hour)
    }

    /// Move the streak to `day`, by the rule in this module's header.
    fn advance_streak(&mut self, day: LocalDay) {
        let day_after_last = self
            .streak_day
            .is_some_and(|last| day.ordinal() == last.ordinal() + 1);
        match self.streak_day {
            None => {
                self.streak_days = 1;
                self.streak_day = Some(day);
            }
            Some(last) if day == last => {}
            Some(_) if day_after_last => {
                self.streak_days += 1;
                self.streak_day = Some(day);
            }
            // The clock moved back under the user — a timezone, a flight, a corrected clock. The day
            // is still tallied, and the streak and its day are left alone rather than restarted:
            // §11's 「跨午夜/时区变化」 is where the machine must not be able to punish the user.
            Some(last) if day.ordinal() < last.ordinal() => {}
            Some(_) => {
                self.streak_days = 1;
                self.streak_day = Some(day);
            }
        }
    }

    /// The badges whose fact is the moment rather than a total — see [`RECORDED_BADGES`]. One row per
    /// entry, and the array's length is checked at compile time, so a badge added cannot be forgotten.
    fn record_badges(&mut self, hour: u32) -> Vec<&'static str> {
        let mut recorded = Vec::new();
        let earned: [bool; RECORDED_BADGES.len()] = [hour < 6 && self.meals >= 1];
        for (index, id) in RECORDED_BADGES.iter().enumerate() {
            if earned[index] && self.recorded.insert((*id).to_string()) {
                recorded.push(*id);
            }
        }
        recorded
    }

    /// Keep the trailing window. Days outside it are dropped; the totals they fed are not.
    fn prune_days(&mut self) {
        while self.days.len() > DAY_WINDOW {
            let Some(oldest) = self.days.keys().next().copied() else {
                return;
            };
            self.days.remove(&oldest);
        }
    }

    /// What the ledger settled, for whoever draws it. There is deliberately no level and no progress
    /// bar: those are `pet-care-rules.ts`'s, and carrying them would be a second level curve.
    pub fn summary(&self) -> CareSummary {
        CareSummary {
            schema_version: self.schema_version,
            revision: self.revision,
            xp: self.xp,
            meals: self.meals,
            streak_days: self.streak_days,
            unlocked: self.recorded.iter().cloned().collect(),
            days: self
                .days
                .iter()
                .map(|(day, tally)| CareDayRow {
                    day: day.key(),
                    completions: tally.completions,
                    tokens: tally.tokens,
                })
                .collect(),
            reported_tokens: self.reported_tokens,
            unreported_runs: self.unreported_runs,
            last_settled_at: self.last_settled_at,
        }
    }
}

/// The ledger's readout: settled totals, and no interpretation of them.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CareSummary {
    pub schema_version: u32,
    pub revision: u64,
    pub xp: u64,
    pub meals: u64,
    pub streak_days: u32,
    /// The badges settlement recorded; the derivable ones are derived where they are drawn.
    pub unlocked: Vec<String>,
    /// The trailing window, oldest first.
    pub days: Vec<CareDayRow>,
    /// Usage reported across every run, or `None` while nothing has reported any.
    pub reported_tokens: Option<u64>,
    /// Runs that finished without reporting usage. Their usage is unknown, and is not zero.
    pub unreported_runs: u64,
    pub last_settled_at: Option<i64>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct CareDayRow {
    pub day: String,
    pub completions: u64,
    /// `None` when nobody reported usage that day (§8: unknown is not zero).
    pub tokens: Option<u64>,
}
