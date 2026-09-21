//! The seam between §6.1's task facts and §8's care ledger: which endings pay, and what one fact is
//! worth to a total.
//!
//! **Why this file exists.** `care_ledger.rs` owns the rule — paid once, on a local day, with an
//! unknown usage never read as a zero — and it is complete and tested. What it did not have was a
//! *producer*. `CareLedger::settle` was called from `tests/` and from nowhere else, so
//! `desktop_pet_care_read` could only ever answer `Empty`, while every case in
//! `tests/desktop_pet_care_test` passed about a ledger the shipped app never fed. That is this
//! repository's own named defect — 「built but unreachable」, `docs/HANDOVER.md` §6.7 — and the
//! instrument that finds it in TypeScript (`scripts/check-dead-exports.py`) cannot see a Rust method
//! whose only caller is a test.
//!
//! **Why it is a module and not four lines in `task_feed.rs`.** The mapping is a rule with two
//! halves that a reader has to be able to check without a window, an engine or a Tauri builder: the
//! vocabulary (`PetTaskState` → `CareOutcome`, which is the contract's terminal-state table seen
//! from the ledger's side) and the calendar (one host instant → one local day and hour). Both are
//! pure, and both are wrong in ways that are invisible until a user's streak is.
//!
//! The ledger's own rule about the calendar is why [`local_time_of`] is here and not in
//! `care_ledger.rs`: that module 「owns no clock, not `chrono` and not `SystemTime`」, and this is the
//! one place an instant becomes a civil date. Read once, at settlement, and stored with the reward —
//! converting an instant into a day later is the bug the ledger's header describes.

use chrono::{DateTime, Datelike, Local, Timelike, Utc};

use super::care_ledger::{
    CareEvent, CareLedger, CareOrigin, CareOutcome, CareRefusal, CareSettlement, LocalDay,
    LocalTime,
};
use super::task_projection::{PetTaskKey, PetTaskState};

/// The ending one settled task state is, or `None` when the state is not an ending.
///
/// `Working`, `WaitingInput` and `Unknown` are not endings, and the distinction is the whole of what
/// this function is for: a fact that is not an ending must reach nobody, and a fact that *is* one
/// must reach the ledger even when it pays nothing — §6.2's cancellation, refusal, failure and
/// interruption are four facts for the user and one decision here (`CareDecision::Unpaid`), which is
/// what stops a late frame from paying a run that was already ruled on.
///
/// **`Unknown` is deliberately not an ending.** It is the state for "no ending can be stated", and
/// the ledger's rule about a decision is that it is final: deciding a run on the strength of the
/// host's own uncertainty would make a later, truthful ending a replay — the reward would be lost
/// to the one frame that admitted it did not know.
///
/// The two vocabularies are pinned to each other rather than derived: `CareOutcome::name` and
/// `PetTaskState`'s serde spelling are compared, one for one, by
/// `tests/desktop_pet_care_test/settlement.rs`, the way the contract's own list is pinned by
/// `replay.rs`.
pub fn care_outcome(state: PetTaskState) -> Option<CareOutcome> {
    match state {
        PetTaskState::TurnFinished => Some(CareOutcome::TurnFinished),
        PetTaskState::Stopped => Some(CareOutcome::Stopped),
        PetTaskState::Refused => Some(CareOutcome::Refused),
        PetTaskState::Cancelled => Some(CareOutcome::Cancelled),
        PetTaskState::Failed => Some(CareOutcome::Failed),
        PetTaskState::Interrupted => Some(CareOutcome::Interrupted),
        // A belief about a run still going, and a state that admits it has none to state.
        PetTaskState::Working | PetTaskState::WaitingInput | PetTaskState::Unknown => None,
    }
}

/// The machine's local calendar reading of one host instant.
///
/// The day is the one a person would write down at `at_ms`, in the timezone the machine is in *now*
/// — which is the clause `care_ledger.rs` states at length: a completion at 23:59 local stays on
/// that day when the record is read in another country, because the day was decided once, here, and
/// stored with the reward.
///
/// The conversion is `Utc → Local` rather than `Local.timestamp_millis_opt`, and the difference is
/// the arms: a *local* time that does not exist (the hour a spring-forward skips) is a
/// [`chrono::LocalResult::None`], while an instant converted into local time always has exactly one
/// reading. So this is total without an `unwrap` on the driver's task, where a panic would cost the
/// pet its whole task list rather than one reward.
pub fn local_time_of(at_ms: i64) -> LocalTime {
    // Out of `chrono`'s range is the only `None` here, and it is a clock this machine cannot have:
    // `at_ms` comes from the same `SystemTime` the projection stamps `updated_at` with. Clamped to
    // the epoch rather than panicked for the reason above, and the `at_ms` is carried through
    // unchanged so the record still names the instant it was told.
    let utc = DateTime::<Utc>::from_timestamp_millis(at_ms).unwrap_or_else(|| {
        DateTime::<Utc>::from_timestamp_millis(0).expect("the epoch is an instant")
    });
    let moment: DateTime<Local> = utc.into();
    let date = moment.date_naive();
    LocalTime {
        day: LocalDay {
            year: date.year(),
            month: date.month(),
            day: date.day(),
        },
        hour: moment.hour(),
        at_ms,
    }
}

/// Settle one pet fact into the ledger, when the fact is an ending.
///
/// `None` is "nothing to decide" — a frame about a run still going — and is not an error: most
/// frames are that. `Some(Err(..))` is a fact the ledger refuses to record at all
/// ([`CareRefusal`]), which for this path means a key with no identity; the caller reports it and
/// carries on, because a task a window can see is worth more than the reward it did not earn.
///
/// `key.token()` is the ledger's dedup identity, and it is the contract's own `petTaskToken`
/// (`pet-contracts/task.ts:90`) rather than a second encoding: one run is one key on both sides of
/// the IPC, which is what makes "this run has been decided" a fact the ledger can hold across a
/// restart.
///
/// `tokens` is what the engine *reported* for the turn, or `None`. Never derived, never zero-filled:
/// §8's 「token 未知不是 0」 is enforced in the ledger (`unreported_runs`), and the only way to keep
/// it true is to hand over nothing when nothing arrived.
pub fn settle(
    ledger: &mut CareLedger,
    key: &PetTaskKey,
    state: PetTaskState,
    at: LocalTime,
    tokens: Option<u64>,
) -> Option<Result<CareSettlement, CareRefusal>> {
    let outcome = care_outcome(state)?;
    let token = key.token();
    Some(ledger.settle(CareEvent {
        key: &token,
        outcome,
        at,
        tokens,
        origin: CareOrigin::Real,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two vocabularies, one for one. A state added to one and not the other is a run that
    /// silently stops earning, which is the failure this whole module exists to make impossible.
    ///
    /// Spelled as paths rather than as two glob imports, and that is not style: the two enums share
    /// their whole ending vocabulary — `Stopped` is a state *and* an outcome — so `use ...::*` twice
    /// is ambiguous for six of the six pairs, which is the compiler agreeing that these names mean one
    /// thing in both places.
    #[test]
    fn every_ending_the_contract_names_has_a_care_outcome() {
        let pairs = [
            (CareOutcome::TurnFinished, PetTaskState::TurnFinished),
            (CareOutcome::Stopped, PetTaskState::Stopped),
            (CareOutcome::Refused, PetTaskState::Refused),
            (CareOutcome::Cancelled, PetTaskState::Cancelled),
            (CareOutcome::Failed, PetTaskState::Failed),
            (CareOutcome::Interrupted, PetTaskState::Interrupted),
        ];
        for (care, task) in pairs {
            assert_eq!(
                care_outcome(task).map(|outcome| outcome.name()),
                Some(care.name()),
                "{task:?} must reach the ledger under its own name"
            );
        }
        for not_an_ending in [
            PetTaskState::Working,
            PetTaskState::WaitingInput,
            PetTaskState::Unknown,
        ] {
            assert_eq!(
                care_outcome(not_an_ending),
                None,
                "{not_an_ending:?} is not an ending and must reach nobody"
            );
        }
    }

    /// The contract's six endings and the ledger's six outcomes are the same six words.
    #[test]
    fn the_care_vocabulary_is_the_contracts() {
        let names: Vec<&str> = super::super::care_ledger::CARE_OUTCOMES
            .iter()
            .map(|outcome| outcome.name())
            .collect();
        assert_eq!(
            names,
            [
                "turn-finished",
                "stopped",
                "refused",
                "cancelled",
                "failed",
                "interrupted"
            ]
        );
    }

    /// A local reading is the machine's own, and the hour belongs to that calendar.
    ///
    /// Asserted against the offset `chrono` reports for the same instant rather than against a fixed
    /// number: this case has to hold on a machine in UTC and on one in Asia/Shanghai, and a test
    /// that hardcoded an hour would be a test about the machine it ran on.
    #[test]
    fn an_instant_reads_as_its_own_locals_day_and_hour() {
        let at_ms = 1_789_000_000_000_i64;
        let expected: DateTime<Local> = DateTime::<Utc>::from_timestamp_millis(at_ms)
            .expect("an instant")
            .into();
        let read = local_time_of(at_ms);
        assert_eq!(read.at_ms, at_ms);
        assert_eq!(read.day.year, expected.year());
        assert_eq!(read.day.month, expected.month());
        assert_eq!(read.day.day, expected.day());
        assert_eq!(read.hour, expected.hour());
    }

    /// The day a local reading reports is the day its own key spells.
    #[test]
    fn the_day_carries_the_key_the_record_is_stored_under() {
        let read = local_time_of(1_789_000_000_000);
        let key = read.day.key();
        assert_eq!(LocalDay::parse(&key), Some(read.day));
    }
}
