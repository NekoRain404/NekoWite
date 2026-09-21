//! §8's care ledger across a restart — the half `care_ledger.rs` states but nothing performed.
//!
//! `care_ledger/import.rs`'s header gives settlement two clauses at once: it 「has to be idempotent
//! across replays **and restarts**」. The replay half is `desktop_pet_care_test/replay.rs`'s, and it
//! holds. The restart half needs somewhere for a decision to outlive the process, and until this
//! target existed there was none: a ledger was built empty at every start, so a machine that was
//! closed overnight lost every meal, its streak and — the part that is not merely sad — its `decided`
//! map, which is the only thing that stops a re-delivered completion from being paid a second time.
//!
//! **These cases drive `PetTaskFeed::for_app` rather than the store's own API**, and that is the
//! point of the file: what a user has is the feed's assembly of a directory, so a case that built a
//! store by hand would be a case about a store the app never constructs. The frames below are the
//! runtime's own envelopes — the same shape `tests/desktop_pet_ipc_test/wiring.rs` drives — so a
//! completion here is a completion there.
//!
//! The `data_dir` helper plants nothing in the repository and reads nothing from the developer's own
//! data directory: it builds a fresh tree under the system temporary directory, one per process.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use nekowite_lib::agent_runtime::events::{AgentEventEnvelope, AgentEventKind, AgentIdentity};
use nekowite_lib::desktop_pet::care_ledger::{LEDGER_SCHEMA_VERSION, MEAL_XP};
use nekowite_lib::desktop_pet::care_store::{CareStore, SaveOutcome};
use nekowite_lib::desktop_pet::PetTaskFeed;

/// The identity a real start installs, named field by field so a helper cannot agree with a bug that
/// ignores one of them (`desktop_pet_task_projection_test/support.rs` states the rule).
fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "default".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-a".to_string(),
    }
}

/// The frame that ends one run normally, in the shape `runs.rs` publishes.
fn finished(run_id: &str, sequence: u64, total_tokens: Option<u64>) -> AgentEventEnvelope {
    let usage = match total_tokens {
        Some(tokens) => json!({ "totalTokens": tokens }),
        None => json!(null),
    };
    AgentEventEnvelope {
        agent_id: "opencode".to_string(),
        profile_id: "default".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-a".to_string(),
        session_id: "ses-1".to_string(),
        run_id: Some(run_id.to_string()),
        sequence,
        kind: AgentEventKind::RunFinished,
        payload: json!({ "stopReason": "end-turn", "usage": usage }),
    }
}

/// A data directory of this process's own, emptied before use.
fn data_dir(label: &str) -> PathBuf {
    let data = std::env::temp_dir().join(format!("nkw-pet-care-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data).expect("a temporary data directory");
    data
}

/// One run, driven through the feed the way the driver drives it.
fn run_to_completion(feed: &PetTaskFeed, run_id: &str, sequence: u64, tokens: Option<u64>) {
    feed.install(&identity()).expect("a fresh feed");
    feed.started(&identity(), "ses-1", run_id)
        .expect("a fresh feed");
    feed.apply(&finished(run_id, sequence, tokens))
        .expect("a fresh feed");
}

/// The totals the feed's ledger holds, read through the handle the page's own read uses.
fn totals(feed: &PetTaskFeed) -> (u64, u64, u64) {
    let ledger = feed.care();
    let ledger = ledger.lock().expect("the ledger's lock is fresh");
    (ledger.xp(), ledger.meals(), ledger.revision())
}

#[test]
fn the_totals_a_run_earned_are_still_there_after_a_restart() {
    let data = data_dir("survives");

    // The first launch: one run finishes and pays.
    let first = PetTaskFeed::for_app(&data, 1_000);
    run_to_completion(&first, "run-0", 1, Some(4_200));
    assert_eq!(totals(&first).0, MEAL_XP, "the run paid while the app ran");

    // The restart, built exactly as the next launch builds it: the same directory, a fresh process.
    let second = PetTaskFeed::for_app(&data, 2_000);
    let (xp, meals, _) = totals(&second);
    assert_eq!(xp, MEAL_XP, "the meal did not survive the restart");
    assert_eq!(meals, 1);
}

#[test]
fn a_replayed_completion_is_not_paid_twice_after_a_restart() {
    let data = data_dir("replay");

    let first = PetTaskFeed::for_app(&data, 1_000);
    run_to_completion(&first, "run-0", 1, None);
    assert_eq!(totals(&first).0, MEAL_XP);

    // The restart. It has to come back *already paid* before the replay means anything: a ledger that
    // started empty would pay the re-delivered run once and land on the same total as the first
    // launch, which is the shape a weak assertion reads as "not paid twice".
    let second = PetTaskFeed::for_app(&data, 2_000);
    assert_eq!(
        totals(&second).0,
        MEAL_XP,
        "the restart began with nothing, so the run below would be paid for the first time"
    );

    // And then the same run ends again. A fresh projection has no memory of the run, so the
    // *projection* cannot refuse this — which is exactly why the ledger's `decided` map has to
    // outlive the process for the idempotence clause to mean anything across one.
    run_to_completion(&second, "run-0", 1, None);

    let after = totals(&second);
    assert_eq!(
        after.0, MEAL_XP,
        "a re-delivered completion was paid a second time after the restart"
    );
    assert_eq!(
        after.1, 1,
        "one run is one meal, however many times it is decided"
    );
}

#[test]
fn an_unreported_usage_is_still_unknown_after_a_restart() {
    let data = data_dir("unknown-usage");

    let first = PetTaskFeed::for_app(&data, 1_000);
    run_to_completion(&first, "run-0", 1, None);

    // §8's 「token 未知不是 0」, held across the restart too: a record that had no count when it was
    // written must not come back reading as a zero.
    let second = PetTaskFeed::for_app(&data, 2_000);
    let ledger = second.care();
    let ledger = ledger.lock().expect("the ledger's lock is fresh");
    let summary = ledger.summary();
    assert_eq!(
        summary.reported_tokens, None,
        "silence came back as a total"
    );
    assert_eq!(summary.unreported_runs, 1);
}

/// Nothing is planted in the repository, and nothing here reads the developer's own data directory.
#[test]
fn the_cases_write_only_under_the_system_temporary_directory() {
    let data = data_dir("scope");
    assert!(
        data.starts_with(std::env::temp_dir()),
        "{data:?} is outside the temporary directory"
    );
    assert!(Path::new(&data).is_dir());
}

/// A record a newer build wrote is left exactly as it was, and the read says which fact that is.
///
/// §10.2's rule, and the reason it has to be a latch rather than a check at write time: this build
/// reads the future record as an *empty* ledger — it cannot make rows out of fields it does not know —
/// so its first settlement would write that emptiness back over the user's real progress. What the
/// user sees instead is a sentence, not a level-0 page.
#[test]
fn a_record_from_a_newer_build_is_not_replaced_and_says_so() {
    let data = data_dir("newer-schema");
    let store = CareStore::new(&data).expect("an absolute data directory is in scope");
    let path = store.path().to_path_buf();
    fs::create_dir_all(path.parent().expect("a file has a folder")).expect("the pet's folder");
    let future = json!({
        "schemaVersion": LEDGER_SCHEMA_VERSION + 1,
        "revision": 7,
        "xp": 1234,
        "meals": 9,
        "decided": [],
        "recorded": [],
        "days": [],
        "streakDays": 4,
        "streakDay": null,
        "reportedTokens": null,
        "unreportedRuns": 0,
        "lastSettledAt": null,
    })
    .to_string();
    fs::write(&path, &future).expect("the planted record");

    // A fresh store, because the latch is set by the read and a store that has not read is not the
    // store the app builds (`CareStore::new` starts it unwritable on purpose).
    let store = CareStore::new(&data).expect("an absolute data directory is in scope");
    let loaded = store.load();
    assert!(loaded.read_only, "a newer record was read as this build's");
    assert!(
        loaded.detail.is_some(),
        "nothing said why the progress on disk is not being drawn"
    );
    assert_eq!(
        loaded.ledger.xp(),
        0,
        "a future record was read as a ledger"
    );

    assert_eq!(
        store.save(&loaded.ledger).expect("a save answers"),
        SaveOutcome::ReadOnly
    );
    assert_eq!(
        fs::read_to_string(&path).expect("the file is still there"),
        future,
        "the newer build's record was overwritten"
    );
}

/// A file this build cannot read starts the ledger fresh — and says so, because a paid run may be
/// paid again.
///
/// The other arm of the same decision, and it is deliberately not a refusal: a build that would not
/// write over one bad byte would leave the care page empty for ever, with a line at startup and
/// nothing the user could do about it. The loss is bounded and named instead — the dedup memory is
/// what goes, so a re-delivered completion may be paid twice — and the next write replaces a file that
/// was never a ledger.
#[test]
fn a_file_this_build_cannot_read_starts_fresh_and_says_so() {
    let data = data_dir("garbled");
    let store = CareStore::new(&data).expect("an absolute data directory is in scope");
    let path = store.path().to_path_buf();
    fs::create_dir_all(path.parent().expect("a file has a folder")).expect("the pet's folder");
    fs::write(&path, "{ this is not a ledger").expect("the planted bytes");

    let store = CareStore::new(&data).expect("an absolute data directory is in scope");
    let loaded = store.load();
    assert!(
        loaded.detail.is_some(),
        "unreadable bytes were treated as a fresh install"
    );
    assert!(
        !loaded.read_only,
        "a garbled file is not a newer build's record"
    );
    assert_eq!(loaded.ledger.revision(), 0);

    assert_eq!(
        store.save(&loaded.ledger).expect("a save answers"),
        SaveOutcome::Written,
        "a build that will not replace one bad byte never records anything again"
    );
}

/// A day that is not a date is refused whole rather than parsed into the days that were.
///
/// The rule `care_ledger/import.rs` states for a file a user hands in, applied to this build's own:
/// reading the fields that parsed and defaulting the rest is the normalisation that discards a user's
/// progress while looking like a success — and here it would be *written back*, so the fields this
/// build could not read would leave the file as well as memory.
#[test]
fn a_record_with_an_impossible_day_is_refused_whole() {
    let data = data_dir("impossible-day");
    let store = CareStore::new(&data).expect("an absolute data directory is in scope");
    let path = store.path().to_path_buf();
    fs::create_dir_all(path.parent().expect("a file has a folder")).expect("the pet's folder");
    let record = json!({
        "schemaVersion": LEDGER_SCHEMA_VERSION,
        "revision": 3,
        "xp": 50,
        "meals": 2,
        "decided": [],
        "recorded": [],
        "days": [{ "day": "2026-02-30", "completions": 1, "tokens": null }],
        "streakDays": 1,
        "streakDay": "2026-02-30",
        "reportedTokens": null,
        "unreportedRuns": 0,
        "lastSettledAt": null,
    })
    .to_string();
    fs::write(&path, &record).expect("the planted record");

    let store = CareStore::new(&data).expect("an absolute data directory is in scope");
    let loaded = store.load();
    assert!(
        loaded.detail.is_some(),
        "February the 30th was accepted as a calendar day"
    );
    assert_eq!(loaded.ledger.xp(), 0, "a refused record was partly read");
}
