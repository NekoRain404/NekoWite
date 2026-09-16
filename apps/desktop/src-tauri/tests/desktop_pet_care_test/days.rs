//! 日期/时区: what a day is, and what a streak may not be broken by (§11's 「跨午夜/时区变化」).
//!
//! The ledger stores the day the host reported and never converts an instant into one, so most of what
//! these tests can check is the *boundary*: the last minute of a day and the first of the next are two
//! days, a month end and a leap day are still one day apart, and an instant that falls on a different
//! UTC day is filed where the user was standing rather than where Greenwich is. The one it can check
//! that is not a boundary is the direction a streak may move: a clock that went *back* is a machine
//! fact, and the pet is not allowed to take it out on the user.

use crate::desktop_pet::care_ledger::{CareLedger, LocalDay, LocalTime};
use crate::support::{at, day, noon, pay};

#[test]
fn the_last_minute_of_one_day_and_the_first_of_the_next_are_two_days() {
    let mut ledger = CareLedger::new();
    pay(&mut ledger, "run-a", at(day(2026, 9, 16), 23));
    pay(&mut ledger, "run-b", at(day(2026, 9, 17), 0));

    let days = ledger.summary().days;
    assert_eq!(days.len(), 2);
    assert_eq!(days[0].day, "2026-09-16");
    assert_eq!(days[1].day, "2026-09-17");
    // Midnight is the boundary the streak counts across, so crossing it in the right direction has to
    // grow the streak. A UTC-derived day would put both of these on 2026-09-16 west of Greenwich and
    // on 2026-09-17 east of it — one of the two audiences gets it wrong, which is the whole clause.
    assert_eq!(ledger.streak_days(), 2);
}

#[test]
fn the_day_is_the_one_the_host_reported_not_the_one_the_instant_falls_on() {
    let mut ledger = CareLedger::new();
    // 2026-09-15T16:30Z, which is 2026-09-16 00:30 in UTC+8: the local calendar has already turned over
    // while the UTC one has not. The ledger is handed both facts and must file by the first.
    let local = LocalTime {
        day: day(2026, 9, 16),
        hour: 0,
        at_ms: 1_789_547_400_000,
    };
    pay(&mut ledger, "run-a", local);

    assert_eq!(ledger.summary().days[0].day, "2026-09-16");
    // Nothing in the ledger reads `at_ms` to decide a day, so nothing in it can disagree with the
    // host about one: the same instant filed as two days is two days, which is what a machine that
    // moved between them actually experienced.
    let mut moved = CareLedger::new();
    pay(&mut moved, "run-a", local);
    pay(
        &mut moved,
        "run-b",
        LocalTime {
            day: day(2026, 9, 15),
            ..local
        },
    );
    assert_eq!(moved.summary().days.len(), 2);
}

#[test]
fn a_streak_survives_a_clock_that_moved_back_a_day() {
    let mut ledger = CareLedger::new();
    let (first, second, third) = (day(2026, 9, 16), day(2026, 9, 17), day(2026, 9, 18));
    pay(&mut ledger, "run-a", noon(first));
    pay(&mut ledger, "run-b", noon(second));
    assert_eq!(ledger.streak_days(), 2);

    // A flight west, or a corrected clock: the machine now says it is the 16th again. The completion
    // is still tallied — it happened — and the streak is left exactly where it was. Restarting it here
    // would be the pet punishing the user for their laptop's timezone.
    pay(&mut ledger, "run-c", noon(first));
    assert_eq!(
        ledger.streak_days(),
        2,
        "a day that went backwards broke the streak"
    );

    // And the last settled day did not move, so the day after *it* still continues the run.
    pay(&mut ledger, "run-d", noon(third));
    assert_eq!(ledger.streak_days(), 3);
}

#[test]
fn two_days_on_restarts_the_streak_at_one() {
    let mut ledger = CareLedger::new();
    pay(&mut ledger, "run-a", noon(day(2026, 9, 16)));
    pay(&mut ledger, "run-b", noon(day(2026, 9, 19)));

    assert_eq!(ledger.streak_days(), 1);
}

#[test]
fn several_completions_in_one_day_are_one_day_of_streak() {
    let mut ledger = CareLedger::new();
    let when = noon(day(2026, 9, 16));
    pay(&mut ledger, "run-a", when);
    pay(&mut ledger, "run-b", at(day(2026, 9, 16), 23));
    pay(&mut ledger, "run-c", at(day(2026, 9, 16), 1));

    assert_eq!(ledger.streak_days(), 1);
    assert_eq!(ledger.summary().days.len(), 1);
    assert_eq!(ledger.summary().days[0].completions, 3);
}

#[test]
fn a_month_end_and_a_leap_day_are_one_day_apart_each() {
    // March 1st follows February 28th by exactly one day in 2026, and February 29th exists in 2028:
    // both are cases where a day key that was lexicographically "one more" would be the wrong answer.
    assert_eq!(day(2026, 3, 1).ordinal(), day(2026, 2, 28).ordinal() + 1);
    assert_eq!(day(2028, 2, 29).ordinal(), day(2028, 2, 28).ordinal() + 1);
    assert_eq!(day(2028, 3, 1).ordinal(), day(2028, 2, 29).ordinal() + 1);
    // 2100 is not a leap year, which is the case a naive `% 4` gets wrong.
    assert_eq!(day(2100, 3, 1).ordinal(), day(2100, 2, 28).ordinal() + 1);

    let mut ledger = CareLedger::new();
    for (index, day) in [day(2026, 2, 28), day(2026, 3, 1)].into_iter().enumerate() {
        pay(&mut ledger, &format!("run-{index}"), noon(day));
    }
    // February 2026 has no 29th, and the streak continues across the month end rather than restarting
    // at a date that does not exist.
    assert_eq!(ledger.streak_days(), 2);
}

#[test]
fn a_key_is_the_spelling_upstream_writes_and_a_bad_one_is_refused() {
    assert_eq!(day(2026, 9, 6).key(), "2026-09-06");
    assert_eq!(LocalDay::parse("2026-09-06"), Some(day(2026, 9, 6)));
    assert_eq!(LocalDay::parse("2028-02-29"), Some(day(2028, 2, 29)));

    // A stored date nobody can reason about is refused rather than sorted by: an import carrying one
    // loses that day, which the import test asserts it *reports*.
    for bad in [
        "2026-02-30",
        "2027-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-9-6",
        "",
        "today",
    ] {
        assert_eq!(LocalDay::parse(bad), None, "{bad} was accepted as a date");
    }
}

#[test]
fn one_day_of_runs_tallies_the_same_whatever_order_they_arrive_in() {
    // Within a day, order is not a fact: the tally counts runs and the day is one day. (Across days it
    // is — the streak is decided as days arrive, so a burst replayed *out of sequence* can under-count
    // a streak; the runtime delivers settled runs in order, and the care ledger does not re-order a
    // history it cannot see the whole of.)
    let when = noon(day(2026, 9, 16));
    let mut first = CareLedger::new();
    for key in ["run-a", "run-b", "run-c"] {
        pay(&mut first, key, when);
    }

    let mut second = CareLedger::new();
    for key in ["run-c", "run-a", "run-b"] {
        pay(&mut second, key, when);
    }

    assert_eq!(first.summary(), second.summary());
    assert_eq!(first.streak_days(), 1);
}
