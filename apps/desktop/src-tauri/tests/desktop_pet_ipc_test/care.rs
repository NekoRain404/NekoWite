//! §8's care ledger over the real IPC entry: the read a page draws, and the facts that move it.
//!
//! **Why these cases are not in `wiring.rs`.** They were, and the file outgrew its behaviour domain:
//! `wiring.rs` is about the runtime's *task list* — which run a window is shown, and where a click on
//! one goes — while every case here is about §8's totals. This target's own header states the rule
//! (「The cases are divided by behaviour domain rather than kept in one file」), and a reward and a task
//! row are different subjects even though one frame produces both.
//!
//! **What is asserted, and what cannot be.** The chain is frame → projection → ledger → the read, and
//! the failure these cases exist for is the one no lower layer can see: a settlement rule with **no
//! producer at all**, where every case in `desktop_pet_care_test` passes while the shipped app answers
//! `empty` for ever. Handing the ledger an event from a test is exactly what these must not do — the
//! event has to come off a real frame, and the answer has to come off the app's own command.
//!
//! The harness (`app`, `app_on_data`, `window`, `call`, and the identity and envelope fixtures) is
//! `wiring.rs`'s, imported rather than copied: this target's other module (`commands.rs`) carries its
//! own copy, which is one too many already, and a third would be a third place for the IPC request
//! shape to drift.

use serde_json::{json, Value};
use tauri::Manager;

use nekowite_lib::agent_runtime::events::AgentEventKind;
use nekowite_lib::desktop_pet::care_ledger::{LEDGER_SCHEMA_VERSION, MEAL_XP};
use nekowite_lib::desktop_pet::care_store::CareStore;
use nekowite_lib::state::DesktopPetState;

use crate::support::MAIN_WINDOW;
use crate::wiring::{app, app_on_data, envelope, identity, window};

/// A run that ended normally is progress, and the care page is where a user sees it.
///
/// The chain is the notification ledger's one file over — frame → projection → ledger → the read a page
/// draws — and the failure it holds down is the one the projection cannot see: a ledger with a
/// settlement rule and no producer. Handing the ledger an event from a test is exactly what this case
/// must not do; the event has to come off a real frame.
#[test]
fn a_completed_run_is_progress_the_care_page_can_draw() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    let state = pet.app.state::<DesktopPetState>();
    state.tasks.install(&identity()).expect("a fresh feed");
    state
        .tasks
        .started(&identity(), "ses-1", "run-0")
        .expect("a fresh feed");

    state
        .tasks
        .apply(&envelope(
            AgentEventKind::RunFinished,
            // The usage the engine reported, in the shape `runs.rs` serializes `PromptResponse.usage`
            // into. §8's 「usage 未知不是 0」 is why a frame that carried none must not read as one.
            json!({ "stopReason": "end-turn", "usage": { "totalTokens": 4200 } }),
        ))
        .expect("a fresh feed");

    let read = call_care(&main);
    assert_eq!(
        read["status"], "current",
        "a finished run is progress, not the absence of a record: {read}"
    );
    assert_eq!(read["summary"]["xp"], MEAL_XP, "one completion, one meal");
    assert_eq!(read["summary"]["meals"], 1);
    assert_eq!(
        read["summary"]["reportedTokens"], 4200,
        "the number the engine reported, not one derived from it"
    );
    assert_eq!(read["summary"]["unreportedRuns"], 0);
}

/// An ending that pays nothing is still an ending, and it is recorded as one.
///
/// §6.2's cancelled run is neither a success nor a failure, and `CareOutcome`'s own table says so: it
/// decides the run without paying it. What the case holds down is the difference between *no decision*
/// (the page draws nothing) and *a decision that paid nothing* (the page draws the totals it has, which
/// are zero) — the same distinction `PetCareRead`'s two arms exist for.
#[test]
fn a_cancelled_run_is_decided_and_pays_nothing() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    let state = pet.app.state::<DesktopPetState>();
    state.tasks.install(&identity()).expect("a fresh feed");
    state
        .tasks
        .started(&identity(), "ses-1", "run-0")
        .expect("a fresh feed");

    state
        .tasks
        .apply(&envelope(
            AgentEventKind::RunFinished,
            json!({ "stopReason": "cancelled", "usage": null }),
        ))
        .expect("a fresh feed");

    let read = call_care(&main);
    assert_eq!(
        read["status"], "current",
        "a cancelled run is a decision, so there is a record to draw: {read}"
    );
    assert_eq!(
        read["summary"]["xp"], 0,
        "§6.2: a cancellation 不算失败奖励"
    );
    assert_eq!(read["summary"]["meals"], 0);
    assert_eq!(read["summary"]["unreportedRuns"], 0);
}

/// A frame about a run that already ended pays nothing a second time.
///
/// §6.3's terminal state is the record, and the ledger's own `decided` map is what makes a replay free
/// rather than merely unlikely. Both halves are exercised here: the projection refuses to revive the
/// run, and the ledger would refuse to pay it again even if the projection had not.
#[test]
fn a_later_frame_about_a_settled_run_pays_nothing_again() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    let state = pet.app.state::<DesktopPetState>();
    state.tasks.install(&identity()).expect("a fresh feed");
    state
        .tasks
        .started(&identity(), "ses-1", "run-0")
        .expect("a fresh feed");

    let ending = envelope(
        AgentEventKind::RunFinished,
        json!({ "stopReason": "end-turn", "usage": null }),
    );
    state.tasks.apply(&ending).expect("a fresh feed");
    // A second frame about the same run, past the one that ended it: a sequence the stream has not
    // seen, so the projection cannot answer with `Replayed` — it has to answer with `Settled`, which is
    // the rule this case is about.
    let mut again = ending.clone();
    again.sequence = 2;
    state.tasks.apply(&again).expect("a fresh feed");

    let read = call_care(&main);
    assert_eq!(
        read["summary"]["xp"], MEAL_XP,
        "the run was paid exactly once"
    );
    assert_eq!(read["summary"]["meals"], 1);
}

/// A frame that is not an ending is not progress.
///
/// `TextDelta` says nothing about a task's state, and the projection answers `NoChange` for it. The case
/// is here because the cheap way to feed a ledger is to hand it every frame, which would pay a run for
/// its own keystrokes.
#[test]
fn a_frame_that_is_not_an_ending_leaves_the_ledger_empty() {
    let pet = app();
    let main = window(&pet, MAIN_WINDOW);
    let state = pet.app.state::<DesktopPetState>();
    state.tasks.install(&identity()).expect("a fresh feed");
    state
        .tasks
        .started(&identity(), "ses-1", "run-0")
        .expect("a fresh feed");

    state
        .tasks
        .apply(&envelope(
            AgentEventKind::TextDelta,
            json!({ "text": "still going" }),
        ))
        .expect("a fresh feed");

    let read = call_care(&main);
    assert_eq!(
        read["status"], "empty",
        "nothing has been decided, so there is nothing to draw: {read}"
    );
}

/// A record a newer build wrote is reported as such, not drawn as "no progress".
///
/// §10.2's newer-record rule, seen from the page. The ledger this build loaded is *empty* — it cannot
/// make rows out of fields it does not know — so the `empty` arm is exactly what a page would get for a
/// user who has months of progress on disk. The distinction the arms exist for (`care.ts`: the arms are
/// things the caller *does*) therefore has to survive the store, and this is the case that holds it.
#[test]
fn a_record_from_a_newer_build_is_reported_rather_than_drawn_as_nothing() {
    let data = care_data_dir("newer");
    let store = CareStore::new(&data).expect("an absolute data directory is in scope");
    let path = store.path().to_path_buf();
    std::fs::create_dir_all(path.parent().expect("a file has a folder")).expect("the pet's folder");
    std::fs::write(
        &path,
        json!({
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
        .to_string(),
    )
    .expect("the planted record");

    let pet = app_on_data(&data);
    let main = window(&pet, MAIN_WINDOW);

    assert_eq!(
        call_care(&main),
        json!({ "status": "read-only" }),
        "a record this build cannot read was answered as a ledger with nothing in it"
    );
    let _ = std::fs::remove_dir_all(&data);
}

// ---------------------------------------------------------------------------
// The two things this file owns: the read, and where a planted record lives
// ---------------------------------------------------------------------------

/// The read, over the real IPC entry.
///
/// A helper rather than a `call(...)` in five places for the reason `commands.rs` gives for its own:
/// once a command needs a second argument or a rename, one call site is the one that gets missed.
fn call_care(window: &tauri::WebviewWindow<tauri::test::MockRuntime>) -> Value {
    crate::wiring::call(window, "desktop_pet_care_read", Value::Null).expect("the read answers")
}

/// A data directory of this process's own, emptied before use.
///
/// Under the system temporary directory and never in the repository, so nothing a case writes can be
/// mistaken for a fixture — the convention `desktop_pet_task_feed_test.rs` established for the files
/// these ledgers keep.
fn care_data_dir(label: &str) -> std::path::PathBuf {
    let data = std::env::temp_dir().join(format!("nkw-pet-care-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).expect("a temporary data directory");
    data
}
