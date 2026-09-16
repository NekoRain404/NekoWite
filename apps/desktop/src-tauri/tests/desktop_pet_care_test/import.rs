//! 导入回退: an import may only raise, and it says what it kept (§5.3, §4).
//!
//! The failure this file exists to catch is the quiet one: an import that "normalises" — reads a file
//! written by another install, decides some of it is stale or inconsistent, and writes its own idea of
//! the progress back. That is the same act as the window host's teardown clearing state because it
//! looks tidy, and it is unrecoverable for the user it happens to. So every test below is one shape of
//! that: a file that is behind, a file that is older, a file that carries half a fact, a file with a
//! date nobody can read — and the same assertion each time, which is that the ledger came out of it
//! with everything it had.

use crate::desktop_pet::care_ledger::{
    CareImport, CareImportOutcome, CareImportPayload, CareImportRefusal, CareLedger, IMPORT_DAYS,
    IMPORT_FIELDS, IMPORT_MEALS, IMPORT_STREAK, IMPORT_TOKENS, IMPORT_XP, LEDGER_SCHEMA_VERSION,
};
use crate::support::{day, ledger_with, noon, pay};

/// A submission of `payload` against a ledger that has not moved since it was read.
fn offer(ledger: &CareLedger, payload: CareImportPayload) -> CareImport {
    CareImport {
        revision: ledger.revision(),
        schema_version: LEDGER_SCHEMA_VERSION,
        payload,
    }
}

/// One report's fields, sorted, so an assertion is about which fields and not about the order the
/// merge happened to walk them in.
fn fields(list: &[String]) -> Vec<&str> {
    let mut names: Vec<&str> = list.iter().map(String::as_str).collect();
    names.sort_unstable();
    names
}

/// The report of a merge that happened, or a panic naming the arm that came back instead.
fn merged(outcome: CareImportOutcome) -> crate::desktop_pet::care_ledger::CareImportReport {
    match outcome {
        CareImportOutcome::Merged(report) => report,
        other => panic!("expected a merge, got {other:?}"),
    }
}

#[test]
fn a_merge_raises_what_is_higher_and_keeps_what_is_not() {
    let mut ledger = ledger_with(4); // 100 XP, 4 meals, day 2026-09-04
    let before = ledger.clone();

    let report = merged(ledger.import(offer(
        &ledger,
        CareImportPayload {
            xp: Some(50),
            total_meals: Some(9),
            total_tokens: Some(240_000),
            streak_days: Some(6),
            last_fed_day_key: Some("2026-09-09".to_string()),
            ..CareImportPayload::default()
        },
    )));

    assert_eq!(
        fields(&report.raised),
        [IMPORT_MEALS, IMPORT_STREAK, IMPORT_TOKENS]
    );
    assert_eq!(fields(&report.kept), [IMPORT_XP]);
    assert_eq!(ledger.xp(), 100, "a file that was behind lowered the total");
    assert_eq!(ledger.meals(), 9);
    assert_eq!(ledger.streak_days(), 6);
    assert_eq!(ledger.summary().reported_tokens, Some(240_000));
    // The runs the ledger had settled are still settled: a merge does not replace a book, it adds to
    // it, and every entry that was there is still there.
    assert_eq!(ledger.decided(), before.decided());
    assert!(ledger.revision() > before.revision());
}

#[test]
fn every_field_a_file_offered_lands_in_exactly_one_of_raised_and_kept() {
    let mut ledger = ledger_with(2);
    let report = merged(ledger.import(offer(
        &ledger,
        CareImportPayload {
            xp: Some(1_000),
            total_meals: Some(1),
            total_tokens: None,
            streak_days: Some(1),
            last_fed_day_key: Some("2026-09-02".to_string()),
            days: [("2026-09-02".to_string(), 900)].into_iter().collect(),
            unlocked_achievements: Vec::new(),
        },
    )));

    // The two lists are what a page shows the user, so a field that appeared in neither would be a
    // change nobody was told about, and one in both would be a contradiction.
    let mut seen: Vec<&str> = report
        .raised
        .iter()
        .chain(report.kept.iter())
        .map(String::as_str)
        .collect();
    let offered = seen.len();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), offered, "a field was reported twice");
    for field in &seen {
        assert!(
            IMPORT_FIELDS.contains(field),
            "{field} is not a field this ledger declares"
        );
    }
    assert!(seen.contains(&IMPORT_XP));
    assert!(seen.contains(&IMPORT_MEALS));
    assert!(seen.contains(&IMPORT_DAYS));
    assert_eq!(ledger.xp(), 1_000);
    assert_eq!(ledger.meals(), 2, "a lower meal count was applied");
}

#[test]
fn a_stale_submission_is_a_conflict_that_writes_nothing() {
    let mut ledger = ledger_with(1);
    let stale = offer(
        &ledger,
        CareImportPayload {
            xp: Some(10_000),
            ..Default::default()
        },
    );

    // The ledger earned something after the file was read — which is what makes the file stale. D6's
    // shape for a stale write is a refusal the caller reloads from, never a merge: merging is how the
    // completion that just happened gets replaced by a file that predates it.
    pay(&mut ledger, "run-later", noon(day(2026, 9, 20)));
    let before = ledger.clone();

    let outcome = ledger.import(stale);
    assert_eq!(
        outcome,
        CareImportOutcome::Conflict {
            current_revision: before.revision()
        }
    );
    assert_eq!(ledger, before);
    assert_eq!(
        ledger.xp(),
        2 * crate::desktop_pet::care_ledger::MEAL_XP,
        "a conflicted import wrote anyway"
    );
}

#[test]
fn importing_the_same_file_twice_leaves_the_ledger_and_its_revision_where_they_were() {
    let mut ledger = ledger_with(2);
    let payload = CareImportPayload {
        xp: Some(5_000),
        total_meals: Some(40),
        days: [("2026-09-05".to_string(), 4_000)].into_iter().collect(),
        unlocked_achievements: vec!["firstMeal".to_string()],
        ..CareImportPayload::default()
    };

    merged(ledger.import(offer(&ledger, payload.clone())));
    let after_first = ledger.clone();

    // A retry after a crash is the reason this matters: the second import of the same file moves
    // nothing, so it is safe to run again without knowing whether the first one finished.
    let report = merged(ledger.import(offer(&ledger, payload)));
    assert_eq!(ledger, after_first);
    assert!(report.raised.is_empty());
    assert_eq!(report.badges_added, 0);
    assert_eq!(report.revision, after_first.revision());
}

#[test]
fn a_record_from_a_newer_build_is_refused_rather_than_read() {
    let mut ledger = ledger_with(1);
    let before = ledger.clone();
    let submission = CareImport {
        revision: ledger.revision(),
        schema_version: LEDGER_SCHEMA_VERSION + 1,
        payload: CareImportPayload {
            xp: Some(99_999),
            ..Default::default()
        },
    };

    let outcome = ledger.import(submission);
    match outcome {
        CareImportOutcome::Refused { reason, detail } => {
            assert_eq!(reason, CareImportRefusal::SchemaNewer);
            assert!(!detail.trim().is_empty());
        }
        other => panic!("a newer record was read: {other:?}"),
    }
    // §10.2: a build that meets data from its future leaves it alone. Read-only means read-only.
    assert_eq!(ledger, before);
    assert!(CareImportRefusal::SchemaNewer.detail().contains("newer"));
}

#[test]
fn an_older_file_cannot_walk_the_streak_backwards() {
    let mut ledger = ledger_with(2);
    // Five days running, up to the 2nd. A file from a week ago claims thirty days up to the 12th of
    // the *previous* month: long, and stale. Its length is not a reason to take it.
    merged(ledger.import(offer(
        &ledger,
        CareImportPayload {
            streak_days: Some(5),
            last_fed_day_key: Some("2026-09-02".to_string()),
            ..CareImportPayload::default()
        },
    )));
    assert_eq!(ledger.streak_days(), 5);

    let report = merged(ledger.import(offer(
        &ledger,
        CareImportPayload {
            streak_days: Some(30),
            last_fed_day_key: Some("2026-08-12".to_string()),
            ..CareImportPayload::default()
        },
    )));

    assert_eq!(fields(&report.kept), [IMPORT_STREAK]);
    assert!(report.raised.is_empty());
    assert_eq!(ledger.streak_days(), 5);
}

#[test]
fn half_a_streak_is_kept_rather_than_guessed_at() {
    let mut ledger = ledger_with(1);
    let before = ledger.clone();
    // A streak is a count *and* the day it is counted from. A file with the count and no day cannot be
    // placed on a calendar, and inventing today for it would be inventing the fact that was missing.
    let report = merged(ledger.import(offer(
        &ledger,
        CareImportPayload {
            streak_days: Some(20),
            last_fed_day_key: None,
            ..CareImportPayload::default()
        },
    )));

    assert_eq!(fields(&report.kept), [IMPORT_STREAK]);
    assert_eq!(ledger, before);
    assert_eq!(ledger.streak_days(), 1);
}

#[test]
fn a_badge_is_added_and_never_taken_away() {
    let mut ledger = ledger_with(1);
    let report = merged(ledger.import(offer(
        &ledger,
        CareImportPayload {
            unlocked_achievements: vec!["firstMeal".to_string(), "streak365".to_string()],
            ..CareImportPayload::default()
        },
    )));
    assert_eq!(report.badges_added, 2);
    // An id this build cannot name is kept verbatim: it is a badge the user earned on the other
    // install, and dropping it because it is unfamiliar is the normalisation §4 forbids. The panel is
    // where it is looked up, and `pet-care-rules.ts` shows an id it does not know as itself.
    assert_eq!(ledger.summary().unlocked, ["firstMeal", "streak365"]);

    // A second file that does not carry them does not remove them, either.
    let report = merged(ledger.import(offer(&ledger, CareImportPayload::default())));
    assert_eq!(report.badges_added, 0);
    assert_eq!(ledger.summary().unlocked, ["firstMeal", "streak365"]);
}

#[test]
fn a_day_nobody_can_read_is_skipped_and_reported() {
    let mut ledger = ledger_with(1);
    let report = merged(
        ledger.import(offer(
            &ledger,
            CareImportPayload {
                days: [
                    ("2026-02-30".to_string(), 1_000),
                    ("last tuesday".to_string(), 2_000),
                    ("2026-09-01".to_string(), 3_000),
                ]
                .into_iter()
                .collect(),
                ..CareImportPayload::default()
            },
        )),
    );

    // The readable day raised; the unreadable ones are skipped, and the report says so rather than
    // pretending the file had nothing else in it. Nothing was removed from the ledger, which is the
    // half that matters: the ledger's own day is still there with its own count.
    assert_eq!(fields(&report.raised), [IMPORT_DAYS]);
    assert_eq!(fields(&report.kept), [IMPORT_DAYS]);
    let days = ledger.summary().days;
    assert_eq!(days.len(), 1, "an unreadable date became a day");
    assert_eq!(days[0].day, "2026-09-01");
    assert_eq!(days[0].completions, 1, "a settled completion was lost");
    assert_eq!(days[0].tokens, Some(3_000));
}

#[test]
fn an_upstream_record_parses_and_a_broken_one_is_refused_whole() {
    // The shape of one pet's entry in upstream's `ap_care` store (`care.ts:11-24`): the fields this
    // merge reads, plus the ones it does not, which an ignored-field parse must survive.
    let record = r#"{
        "xp": 125, "tokenCarry": 4000, "tokensToday": 0, "mealsToday": 1,
        "totalTokens": 1044000, "totalMeals": 3, "lastFedAt": 1789000000000,
        "dayKey": "2026-09-16", "streakDays": 4, "lastFedDayKey": "2026-09-16",
        "days": {"2026-09-16": 12000, "2026-09-15": 3000},
        "unlockedAchievements": ["firstMeal", "tokens1M"]
    }"#;
    let payload: CareImportPayload =
        serde_json::from_str(record).expect("an upstream record parses");

    assert_eq!(payload.xp, Some(125));
    assert_eq!(payload.total_meals, Some(3));
    assert_eq!(payload.streak_days, Some(4));
    assert_eq!(payload.last_fed_day_key.as_deref(), Some("2026-09-16"));
    assert_eq!(payload.days.get("2026-09-16"), Some(&12_000));
    assert_eq!(payload.unlocked_achievements, ["firstMeal", "tokens1M"]);

    // A file that does not parse is refused whole — the caller has nothing to merge and says so. The
    // alternative is the failure this file is about: read the fields that parsed, default the rest,
    // and write that over a user's progress.
    let broken: Result<CareImportPayload, _> = serde_json::from_str(r#"{"xp": "a lot"}"#);
    assert!(broken.is_err(), "a corrupt field was read as a value");
}

#[test]
fn a_ledger_that_has_settled_nothing_accepts_a_file_and_keeps_its_own_history() {
    // The first import on a fresh install: nothing to keep, everything to raise. It also pins the
    // arm a fresh ledger must not take — reporting a conflict against revision 0, which would make the
    // feature unusable on the only run where it is most wanted.
    let mut ledger = CareLedger::new();
    let report = merged(ledger.import(offer(
        &ledger,
        CareImportPayload {
            xp: Some(1_250),
            total_meals: Some(10),
            streak_days: Some(3),
            last_fed_day_key: Some("2026-09-16".to_string()),
            days: [("2026-09-16".to_string(), 500)].into_iter().collect(),
            unlocked_achievements: vec!["firstMeal".to_string()],
            ..CareImportPayload::default()
        },
    )));

    assert_eq!(
        fields(&report.raised),
        [IMPORT_DAYS, IMPORT_MEALS, IMPORT_STREAK, IMPORT_XP]
    );
    assert_eq!(ledger.xp(), 1_250);
    assert_eq!(ledger.summary().days[0].day, "2026-09-16");

    // And the import did not invent a decided run out of it: no event was settled, so nothing is
    // deduplicated against, and the next real completion still pays.
    assert_eq!(ledger.decided(), 0);
    pay(&mut ledger, "run-a", noon(day(2026, 9, 17)));
    assert_eq!(
        ledger.xp(),
        1_250 + crate::desktop_pet::care_ledger::MEAL_XP
    );
}
