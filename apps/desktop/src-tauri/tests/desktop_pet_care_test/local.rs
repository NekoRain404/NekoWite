//! 无 token: local progress that is not a credential, and usage that is unknown rather than zero.
//!
//! Two claims, and neither is observable from outside the module, so both are checked where they can
//! be:
//!
//! - **Nothing here can reach out.** A care ledger has no business holding a network client, a login
//!   or a price, and a claim like that cannot be tested by calling it — a call that succeeded would
//!   prove the opposite. So the module's own source is read, the way `desktop_pet_ipc_test/teardown.rs`
//!   reads the window host's, and the *code* is what must not name any of it. Comments may: the header
//!   says what is deliberately absent, and that sentence is worth keeping.
//! - **未知不是 0 (§8).** An engine that reported no usage leaves an unknown, not a zero, and the two
//!   must stay distinguishable all the way to the summary — a surface that drew them the same way
//!   would be telling the user they used nothing. The mirror of that is that usage pays nothing at
//!   all: XP comes from completions, so the two ledgers below differ in everything except progress.

use std::fs;
use std::path::Path;

use serde_json::json;

use crate::desktop_pet::care_ledger::{CareEvent, CareLedger, CareOrigin, CareOutcome, MEAL_XP};
use crate::support::{day, finished, noon, pay};

#[test]
fn the_module_cannot_reach_a_network_a_process_or_a_file() {
    // `http` and not `https`, so a bare hostname beside either spelling is caught; `Command` rather
    // than `std::process::Command` because a `use` could shorten it.
    const FORBIDDEN: [&str; 12] = [
        "std::net",
        "TcpStream",
        "UdpSocket",
        "reqwest",
        "http",
        "std::process",
        "Command",
        "std::env",
        "std::fs",
        "File::",
        "OAuth",
        "Bearer",
    ];

    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/desktop_pet/care_ledger.rs");
    let text = fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"));
    let code = code_only(&text);

    for token in FORBIDDEN {
        assert!(
            !code.contains(token),
            "care_ledger.rs names {token} in its code; progress is local and must stay local"
        );
    }
    // A check on nothing is not a check: the header this strips is what carries the reasoning, so a
    // scanner that found an empty file would pass everything above.
    assert!(code.contains("pub fn settle"), "the scanner read nothing");
    assert!(text.len() > code.len(), "nothing was stripped");
}

#[test]
fn the_summary_carries_what_was_settled_and_no_level_and_no_price() {
    let mut ledger = CareLedger::new();
    pay(&mut ledger, "run-a", noon(day(2026, 9, 16)));
    let summary = serde_json::to_value(ledger.summary()).expect("the summary serialises");

    let mut keys: Vec<&str> = summary
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "days",
            "lastSettledAt",
            "meals",
            "reportedTokens",
            "revision",
            "schemaVersion",
            "streakDays",
            "unlocked",
            "unreportedRuns",
            "xp",
        ]
    );

    // Not a field-by-field assertion but a statement about what the record may contain at all. A
    // `level` here would be the second copy of the curve §9 forbids; a price, a balance, a
    // subscription or a login would be the paid thing this is not — and either would have to be added
    // to the list above, which is where it would be noticed.
    for key in ["level", "stage", "progress", "price", "cost", "balance", "login", "account"] {
        assert!(
            !keys.iter().any(|name| name.to_lowercase().contains(key)),
            "the summary grew a {key} field; that is not progress and is not this ledger's"
        );
    }
}

#[test]
fn an_unreported_usage_is_unknown_rather_than_zero() {
    let mut ledger = CareLedger::new();
    pay(&mut ledger, "run-a", noon(day(2026, 9, 16)));

    let summary = ledger.summary();
    assert_eq!(summary.reported_tokens, None, "silence was read as a total");
    assert_eq!(summary.unreported_runs, 1);
    assert_eq!(summary.days[0].tokens, None, "the day was read as a zero");
}

#[test]
fn a_reported_zero_is_a_fact_and_an_unreported_day_is_not() {
    let mut ledger = CareLedger::new();
    let reported = CareEvent {
        key: "run-a",
        outcome: CareOutcome::TurnFinished,
        at: noon(day(2026, 9, 16)),
        tokens: Some(0),
        origin: CareOrigin::Real,
    };
    ledger.settle(reported).expect("settles");
    pay(&mut ledger, "run-b", noon(day(2026, 9, 17)));

    let summary = ledger.summary();
    // Reported zero, then silence: the total is a known zero and the silent *run* is still counted as
    // unknown, because the two facts are about different things.
    assert_eq!(summary.reported_tokens, Some(0));
    assert_eq!(summary.unreported_runs, 1);
    assert_eq!(summary.days[0].tokens, Some(0), "a reported zero became unknown");
    assert_eq!(summary.days[1].tokens, None, "an unknown day became a zero");
}

#[test]
fn usage_never_pays_anything() {
    let mut quiet = CareLedger::new();
    let mut loud = CareLedger::new();
    let when = noon(day(2026, 9, 16));
    quiet.settle(finished("run-a", when)).expect("settles");
    loud.settle(CareEvent {
        key: "run-a",
        outcome: CareOutcome::TurnFinished,
        at: when,
        tokens: Some(50_000_000),
        origin: CareOrigin::Real,
    })
    .expect("settles");

    // §8: settlement is 「按实际可信完成事件」. A run that reported fifty million tokens and a run that
    // reported nothing earn the same thing, so a wrong or missing count can never distort progress —
    // which is also why upstream's `TOKENS_PER_XP` has no counterpart here.
    assert_eq!(quiet.xp(), MEAL_XP);
    assert_eq!(loud.xp(), MEAL_XP);
    assert_eq!(quiet.meals(), loud.meals());
    assert_eq!(quiet.streak_days(), loud.streak_days());
}

#[test]
fn usage_adds_up_within_a_day_and_stays_unknown_only_where_nothing_reported() {
    let mut ledger = CareLedger::new();
    let when = noon(day(2026, 9, 16));
    ledger
        .settle(CareEvent { tokens: Some(1_200), ..finished("run-a", when) })
        .expect("settles");
    ledger
        .settle(CareEvent { tokens: Some(300), ..finished("run-b", when) })
        .expect("settles");
    ledger
        .settle(finished("run-c", when))
        .expect("settles");

    let summary = ledger.summary();
    assert_eq!(summary.days[0].tokens, Some(1_500), "a known day lost its total");
    assert_eq!(summary.reported_tokens, Some(1_500));
    assert_eq!(summary.unreported_runs, 1);
    assert_eq!(summary.days[0].completions, 3);
}

#[test]
fn the_later_handed_in_of_two_events_is_a_replay_and_not_a_second_run() {
    // The same run, described twice with different usage, is still one run: the second description is
    // a replay, so the report it carries cannot change what the first one paid.
    let mut ledger = CareLedger::new();
    let when = noon(day(2026, 9, 16));
    ledger
        .settle(CareEvent { tokens: None, ..finished("run-a", when) })
        .expect("settles");
    let second = ledger
        .settle(CareEvent {
            tokens: Some(9_000_000),
            ..finished("run-a", when)
        })
        .expect("a replay is not an error");

    assert!(!second.first);
    assert_eq!(ledger.xp(), MEAL_XP);
    assert_eq!(serde_json::to_value(ledger.summary()).expect("serialises")["reportedTokens"], json!(null));
    assert_eq!(serde_json::to_value(ledger.summary()).expect("serialises")["unreportedRuns"], json!(1));
}

/// The source with its comments removed, so a claim about what the *code* cannot name is not defeated
/// by a comment that says the same words.
fn code_only(text: &str) -> String {
    let mut out = String::new();
    let mut in_block = false;
    for line in text.lines() {
        let mut rest = line;
        let mut kept = String::new();
        loop {
            if in_block {
                match rest.find("*/") {
                    Some(end) => {
                        in_block = false;
                        rest = &rest[end + 2..];
                    }
                    None => break,
                }
            } else {
                match rest.find("/*") {
                    Some(start) => {
                        kept.push_str(&rest[..start]);
                        rest = &rest[start + 2..];
                        in_block = true;
                    }
                    None => {
                        kept.push_str(match rest.find("//") {
                            Some(at) => &rest[..at],
                            None => rest,
                        });
                        break;
                    }
                }
            }
        }
        out.push_str(&kept);
        out.push('\n');
    }
    out
}
