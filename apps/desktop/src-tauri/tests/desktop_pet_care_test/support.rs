//! The fixtures the domain files share.
//!
//! Small on purpose: a ledger, a day and an event are three values, and the tests below are about what
//! happens between them rather than about building them. `at_ms` is derived from the local day's
//! ordinal so that a fixture cannot accidentally describe an instant that belongs to another day —
//! the one property several of the tests are *about* is not something a helper should get to decide
//! quietly.

use crate::desktop_pet::care_ledger::{
    CareEvent, CareLedger, CareOrigin, CareOutcome, CareSettlement, LocalDay, LocalTime,
};

/// A civil date, as the host would report it.
pub fn day(year: i32, month: u32, day: u32) -> LocalDay {
    LocalDay { year, month, day }
}

/// A local wall-clock reading at `hour`, with an instant that sits inside that same local day.
pub fn at(day: LocalDay, hour: u32) -> LocalTime {
    LocalTime {
        day,
        hour,
        at_ms: i64::from(day.ordinal()) * 86_400_000 + i64::from(hour) * 3_600_000,
    }
}

/// Noon on one day: the fixture for tests that are about days rather than about hours.
pub fn noon(day: LocalDay) -> LocalTime {
    at(day, 12)
}

/// A real event that ended normally, carrying no usage report.
pub fn finished<'a>(key: &'a str, at: LocalTime) -> CareEvent<'a> {
    CareEvent {
        key,
        outcome: CareOutcome::TurnFinished,
        at,
        tokens: None,
        origin: CareOrigin::Real,
    }
}

/// Settle a run that finished normally, and hand back what the ledger decided.
pub fn pay(ledger: &mut CareLedger, key: &str, at: LocalTime) -> CareSettlement {
    ledger
        .settle(finished(key, at))
        .expect("a real, identified completion is never refused")
}

/// A ledger with `count` completions already settled, one per consecutive day from 2026-09-01.
pub fn ledger_with(count: usize) -> CareLedger {
    let mut ledger = CareLedger::new();
    for index in 0..count {
        let day = day(2026, 9, 1 + index as u32);
        pay(&mut ledger, &format!("run-{index}"), noon(day));
    }
    ledger
}
