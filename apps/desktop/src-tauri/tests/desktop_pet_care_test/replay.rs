//! 幂等奖励: the same event pays once, and a terminal state stays terminal (§6.3, §11's 养成 row).
//!
//! "Idempotent" is not something a test can see in the shape of a function, so these tests take the
//! form that can see it: a copy of the ledger is held before the replay, and the assertion after the
//! replay is *equality* — every field, including the revision a write is based on. A reward that paid
//! twice fails that; so does a revision that moved because a duplicate arrived, which is the quieter
//! version of the same bug, since it would reject a settings write nobody actually raced.

use std::fs;
use std::path::Path;

use crate::desktop_pet::care_ledger::{
    CareDayRow, CareEvent, CareLedger, CareOrigin, CareOutcome, CareRefusal, LocalDay,
    CARE_OUTCOMES, MEAL_XP,
};
use crate::support::{day, finished, noon, pay};

/// One row of the summary's day window, as a fixture.
fn row(day: &str, completions: u64, tokens: Option<u64>) -> CareDayRow {
    CareDayRow {
        day: day.to_string(),
        completions,
        tokens,
    }
}

#[test]
fn a_replayed_completion_leaves_the_ledger_exactly_as_it_was() {
    let mut ledger = CareLedger::new();
    let event = finished("run-a", noon(day(2026, 9, 16)));
    let first = ledger.settle(event).expect("decided once");

    assert!(first.first);
    assert_eq!(ledger.xp(), MEAL_XP);
    assert_eq!(ledger.meals(), 1);

    let before = ledger.clone();
    for _ in 0..5 {
        let replay = ledger.settle(event).expect("a replay is not an error");
        assert!(!replay.first, "a replay claimed to be the first decision");
        assert_eq!(replay.decision, first.decision);
        assert!(replay.badges.is_empty(), "a replay recorded a badge again");
    }

    // The whole record, not one field of it: a total that stayed put while a day count, a decided
    // entry or the revision moved would still be a second settlement.
    assert_eq!(ledger, before, "the ledger moved on a replay");
    assert_eq!(ledger.xp(), MEAL_XP);
    assert_eq!(ledger.meals(), 1);
    assert_eq!(ledger.decided(), 1);
}

#[test]
fn two_runs_are_two_rewards_and_one_run_is_one() {
    let mut ledger = CareLedger::new();
    let when = noon(day(2026, 9, 16));
    pay(&mut ledger, "run-a", when);
    pay(&mut ledger, "run-b", when);
    pay(&mut ledger, "run-a", when);

    assert_eq!(ledger.xp(), 2 * MEAL_XP);
    assert_eq!(ledger.meals(), 2);
    assert_eq!(ledger.decided(), 2);
    // Two runs on one day are still one day: the window is the days a person lived, not the runs.
    assert_eq!(
        ledger.summary().days,
        [row("2026-09-16", 2, None)],
        "the third settle was a replay, so it must not have added a completion"
    );
}

#[test]
fn the_cancelled_run_is_decided_and_never_pays_later() {
    let mut ledger = CareLedger::new();
    let when = noon(day(2026, 9, 16));
    let cancelled = CareEvent {
        key: "run-a",
        outcome: CareOutcome::Cancelled,
        at: when,
        tokens: Some(9_000),
        origin: CareOrigin::Real,
    };

    let first = ledger
        .settle(cancelled)
        .expect("a cancellation is recorded");
    assert!(first.first);
    assert_eq!(
        first.decision,
        crate::desktop_pet::care_ledger::CareDecision::Unpaid {
            outcome: CareOutcome::Cancelled
        }
    );
    assert_eq!(ledger.xp(), 0);
    assert_eq!(ledger.meals(), 0);

    // §6.2 asks for 「不算失败奖励」 and no success sound, and §6.3 says a terminal state cannot be
    // revived by a later event. The ledger's half of that is here: the decision is stored, so a
    // completion arriving late for the same run is answered with the cancellation, not with a payout.
    let before = ledger.clone();
    let late = ledger
        .settle(finished("run-a", when))
        .expect("the late completion is refused by decision, not by error");
    assert!(!late.first);
    assert_eq!(
        late.decision,
        crate::desktop_pet::care_ledger::CareDecision::Unpaid {
            outcome: CareOutcome::Cancelled
        }
    );
    assert_eq!(ledger, before);
    assert_eq!(ledger.xp(), 0);
}

#[test]
fn every_ending_that_is_not_a_completion_pays_nothing() {
    // §6.2's rows, one at a time: a ceiling, a refusal, a cancellation, a failure, a lost runtime.
    // Each is a different fact for the user and the same fact here — none of them is a success.
    let mut ledger = CareLedger::new();
    for (index, outcome) in CARE_OUTCOMES.into_iter().enumerate() {
        if outcome.pays() {
            continue;
        }
        let key = format!("run-{index}");
        let settlement = ledger
            .settle(CareEvent {
                key: &key,
                outcome,
                at: noon(day(2026, 9, 16)),
                tokens: None,
                origin: CareOrigin::Real,
            })
            .expect("a real ending is recorded");
        assert!(settlement.badges.is_empty());
    }

    assert_eq!(ledger.xp(), 0);
    assert_eq!(ledger.meals(), 0);
    assert_eq!(ledger.streak_days(), 0, "an unearned day started a streak");
    assert!(
        ledger.summary().days.is_empty(),
        "an unearned day made a day"
    );
    // Five endings, five decisions: the record is what stops any of them paying later.
    assert_eq!(ledger.decided(), 5);
}

#[test]
fn only_one_ending_pays_and_it_is_the_one_the_contract_calls_finished() {
    let paying: Vec<&str> = CARE_OUTCOMES
        .into_iter()
        .filter(|outcome| outcome.pays())
        .map(|outcome| outcome.name())
        .collect();

    assert_eq!(paying, ["turn-finished"]);
}

#[test]
fn the_outcome_vocabulary_is_the_contracts_terminal_states() {
    // §6.1's single source of truth: this file must not invent a state. The list is read out of
    // `pet-contracts/task.ts` — including *which* of its states are terminal, which is derived from
    // the contract's own `isPetTaskSettled` rather than restated — so a state added there without a
    // decision here fails this test rather than quietly falling outside the ledger.
    let contract = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/platform/gateways/pet-contracts/task.ts");
    let text =
        fs::read_to_string(&contract).unwrap_or_else(|error| panic!("{contract:?}: {error}"));

    let all = quoted(&slice_between(&text, "PET_TASK_STATES = [", "] as const"));
    let body = &text[text
        .find("export function isPetTaskSettled")
        .expect("the contract states which states are terminal")..];
    let body = &body[..body.find("\n}").expect("the function ends")];
    let terminal: Vec<String> = all
        .into_iter()
        .filter(|state| body.contains(&format!("'{state}'")))
        .collect();

    assert!(!terminal.is_empty(), "the contract has no terminal states?");
    let ours: Vec<String> = CARE_OUTCOMES
        .into_iter()
        .map(|outcome| outcome.name().to_string())
        .collect();
    assert_eq!(ours, terminal);
}

#[test]
fn an_event_with_no_identity_is_refused_rather_than_paid() {
    let mut ledger = CareLedger::new();
    let before = ledger.clone();

    for key in ["", "   "] {
        assert_eq!(
            ledger.settle(CareEvent {
                key,
                outcome: CareOutcome::TurnFinished,
                at: noon(day(2026, 9, 16)),
                tokens: None,
                origin: CareOrigin::Real,
            }),
            Err(CareRefusal::NoIdentity),
            "an unidentified completion was paid, and every replay of it would pay again"
        );
    }

    assert_eq!(ledger, before);
    assert_eq!(ledger.decided(), 0);
}

#[test]
fn a_preview_completion_never_reaches_the_real_ledger() {
    let mut ledger = CareLedger::new();
    let before = ledger.clone();

    // §5.2: 「演示事件隔离，不进入真实历史/奖励/通知」. The arm is a refusal and not a filter, so a
    // caller that handed a preview in has to deal with having done so.
    let refused = ledger.settle(CareEvent {
        key: "demo-1",
        outcome: CareOutcome::TurnFinished,
        at: noon(day(2026, 9, 16)),
        tokens: Some(1_000_000),
        origin: CareOrigin::Preview,
    });
    assert_eq!(refused, Err(CareRefusal::Preview));
    assert_eq!(ledger, before);
    assert_eq!(ledger.xp(), 0);

    // And the same key, settled for real afterwards, is a first decision: the preview left no trace
    // to be deduplicated against.
    let real = pay(&mut ledger, "demo-1", noon(day(2026, 9, 16)));
    assert!(real.first);
    assert_eq!(ledger.xp(), MEAL_XP);
}

#[test]
fn the_day_window_is_bounded_and_the_totals_are_not() {
    let mut ledger = CareLedger::new();
    for index in 0..20 {
        let when = noon(LocalDay {
            year: 2026,
            month: 9,
            day: 1 + index,
        });
        pay(&mut ledger, &format!("run-{index}"), when);
    }

    let summary = ledger.summary();
    assert_eq!(summary.days.len(), 14, "the window grew");
    assert_eq!(
        summary.days[0].day, "2026-09-07",
        "the window kept the wrong end"
    );
    assert_eq!(summary.days[13].day, "2026-09-20");
    // Pruning drops days, not what they earned: a ledger that forgot XP when its window rolled would
    // lose a user's level at the fortnight mark.
    assert_eq!(summary.xp, 20 * MEAL_XP);
    assert_eq!(summary.meals, 20);
    assert_eq!(
        summary.streak_days, 20,
        "pruning the window broke the streak"
    );
}

#[test]
fn a_day_exists_because_something_was_earned_on_it() {
    // The window is what the panel draws, so a day with no completion behind it would be a day the
    // user never had. Nothing but a payment can make one — the addition below is the only thing that
    // creates a row, and it creates exactly the one completion it was called for.
    let mut ledger = CareLedger::new();
    pay(&mut ledger, "run-a", noon(day(2026, 9, 16)));
    assert_eq!(ledger.summary().days, [row("2026-09-16", 1, None)]);

    // A replay is not a second run either: the row is what the one completion made it.
    pay(&mut ledger, "run-a", noon(day(2026, 9, 16)));
    assert_eq!(ledger.summary().days, [row("2026-09-16", 1, None)]);
}

#[test]
fn the_refusal_messages_say_what_happened() {
    for refusal in [CareRefusal::NoIdentity, CareRefusal::Preview] {
        assert!(refusal.detail().len() > 20, "{refusal:?} explains nothing");
    }
}

/// The text between two markers, or a panic naming the marker that moved.
fn slice_between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text
        .find(start)
        .unwrap_or_else(|| panic!("{start} is not in the contract"));
    let rest = &text[from + start.len()..];
    let to = rest
        .find(end)
        .unwrap_or_else(|| panic!("{end} does not follow {start} in the contract"));
    &rest[..to]
}

/// Every single-quoted string in a slice, in order.
fn quoted(slice: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = slice;
    while let Some(open) = rest.find('\'') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('\'') else { break };
        names.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    names
}
