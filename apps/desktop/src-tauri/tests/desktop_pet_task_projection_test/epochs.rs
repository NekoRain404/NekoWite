//! Which incarnation may write to a task — §6.1's `runtimeEpoch`, and the trailing-edge frames
//! that outlive the instance they came from.
//!
//! This is `state::WatcherState::generation`'s problem (`app_state.rs:30-35`) in another place: a
//! frame minted under an installation that is over must be recognizable as such rather than
//! applicable. The two differ in what the mark is — a counter for the folder watcher, the
//! registry's own epoch here — and they agree in the rule. **The mark is compared, never
//! interpreted:** nothing in this module sorts epochs or asks which is newer, because
//! `registry.rs` mints them as `epoch-<pid>-<counter>` and a restart reuses the low numbers, so
//! "later string" and "later incarnation" are not the same thing.

use std::sync::atomic::Ordering;

use crate::desktop_pet::task_projection::Disposition;
use crate::support::{
    finished, first_instance, identity, key, projection, state_of, task_count, AGENT, VAULT,
};

#[test]
fn a_frame_from_the_previous_instance_is_refused() {
    let mut projection = projection();
    let previous = first_instance();
    let current = identity(AGENT, VAULT, "epoch-2");
    projection.install(&previous);
    projection.install(&current);

    let ingest = projection.apply(&finished(&previous, "ses_1", "run-1", 1, "end-turn"));

    assert_eq!(ingest.disposition, Disposition::Foreign);
    assert_eq!(
        projection.installed(AGENT, "default", VAULT),
        Some("epoch-2"),
        "a frame that lost the race does not change which instance is installed"
    );
}

/// The two ways a frame can name the wrong instance are different facts about it, and the refusal
/// says which: one is a stale incarnation of an engine this host runs, the other is an identity it
/// has no record of at all. Both are refused; a reader of the detail does not have to guess.
#[test]
fn a_frame_from_an_instance_this_host_never_started_is_refused() {
    let mut projection = projection();
    projection.install(&first_instance());

    let superseded = identity(AGENT, VAULT, "epoch-from-another-run");
    let stale = projection.apply(&finished(&superseded, "ses_1", "run-1", 1, "end-turn"));

    assert_eq!(stale.disposition, Disposition::Foreign);
    assert!(
        stale
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("this host serves epoch-1")),
        "the refusal names the incarnation that is current: {:?}",
        stale.detail
    );

    let unknown = crate::support::identity(AGENT, "a-vault-never-opened", "epoch-1");
    let stranger = projection.apply(&finished(&unknown, "ses_1", "run-1", 1, "end-turn"));

    assert_eq!(stranger.disposition, Disposition::Foreign);
    assert!(
        stranger
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("never started")),
        "and a triple this host has no record of reads as itself: {:?}",
        stranger.detail
    );
    assert_eq!(task_count(&projection), 0);
}

/// The trailing edge, which is what the generation exists for: the first instance is over, and a
/// frame it published before it went is still on its way. It must not be applied — and the run it
/// belonged to must not be left looking like it is still running either, because the runtime that
/// was running it is gone (§6.2's last row).
#[test]
fn installing_a_new_instance_restates_what_the_previous_one_had_in_flight() {
    let (mut projection, clock) = crate::support::projection_with_clock();
    let previous = first_instance();
    let current = identity(AGENT, VAULT, "epoch-2");
    projection.install(&previous);
    projection.started(&previous, "ses_1", "run-1");

    clock.store(2_000, Ordering::SeqCst);
    let restated = projection.install(&current);

    assert_eq!(restated.len(), 1, "the run that was in flight is restated");
    assert_eq!(state_of(&projection, &key(&previous, "ses_1", "run-1")), "interrupted");
    assert_eq!(
        projection
            .task(&key(&previous, "ses_1", "run-1"))
            .map(|task| task.updated_at),
        Some(2_000),
        "and stamped with the moment the host learned it"
    );
    // The frame that was still in flight arrives afterwards, into a projection that has moved on.
    let late = projection.apply(&finished(&previous, "ses_1", "run-1", 1, "end-turn"));
    assert_eq!(
        late.disposition,
        Disposition::Foreign,
        "a late completion cannot reach back into an instance that is over"
    );
    assert_eq!(state_of(&projection, &key(&previous, "ses_1", "run-1")), "interrupted");
}

/// A different vault is a different process (`registry.rs:414-440` keys its table by the triple),
/// so a new instance in one vault says nothing about what is running in another. Abandoning the
/// other vault's work would be reading "this engine restarted" into "this engine started".
#[test]
fn a_new_instance_in_another_vault_abandons_nothing() {
    let (mut projection, _) = crate::support::projection_with_clock();
    let here = first_instance();
    let elsewhere = identity(AGENT, "vault-b", "epoch-1");
    projection.install(&here);
    projection.install(&elsewhere);
    projection.started(&here, "ses_1", "run-1");
    projection.started(&elsewhere, "ses_2", "run-1");

    let restated = projection.install(&identity(AGENT, VAULT, "epoch-2"));

    assert_eq!(
        restated.iter().map(|task| &task.key).collect::<Vec<_>>(),
        vec![&key(&here, "ses_1", "run-1")],
        "only the vault whose engine was replaced has anything restated"
    );
    assert_eq!(state_of(&projection, &key(&elsewhere, "ses_2", "run-1")), "working");
    assert_eq!(state_of(&projection, &key(&here, "ses_1", "run-1")), "interrupted");
}

/// Installing the same instance twice is an ordinary thing for a caller to do — a start that is
/// retried, a re-attach — and it must not restate anything: the runtime is still the one that was
/// already running.
#[test]
fn installing_the_same_instance_twice_changes_nothing() {
    let (mut projection, clock) = crate::support::projection_with_clock();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    let stamped = projection
        .task(&key(&ours, "ses_1", "run-1"))
        .map(|task| task.updated_at);

    clock.store(9_000, Ordering::SeqCst);
    let restated = projection.install(&ours.clone());

    assert!(restated.is_empty());
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "working");
    assert_eq!(
        projection
            .task(&key(&ours, "ses_1", "run-1"))
            .map(|task| task.updated_at),
        stamped,
        "nothing about the task changed, so nothing about it is restated"
    );
}

/// The host stopping an engine is not the same moment as the next one starting, and it is the one
/// where the host knows for certain that the process is gone.
#[test]
fn retiring_an_instance_restates_its_work_and_refuses_its_later_frames() {
    let (mut projection, _) = crate::support::projection_with_clock();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");

    let restated = projection.retire(&ours);

    assert_eq!(restated.len(), 1);
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "interrupted");
    assert_eq!(projection.installed(AGENT, "default", VAULT), None);
    assert_eq!(
        projection.apply(&finished(&ours, "ses_1", "run-1", 1, "end-turn")).disposition,
        Disposition::Foreign
    );
}

/// A task that already ended keeps its ending. §6.3 forbids an older event being read back into a
/// terminal state, and a runtime that went away went away *after* those runs were over — so the
/// loss says nothing about them, and restating them as `interrupted` would replace a known result
/// with a guess.
#[test]
fn a_task_that_already_ended_keeps_its_ending() {
    let (mut projection, _) = crate::support::projection_with_clock();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.started(&ours, "ses_2", "run-2");
    projection.apply(&finished(&ours, "ses_2", "run-2", 1, "max-tokens"));

    let restated = projection.retire(&ours);

    assert_eq!(restated.len(), 1, "only the run that was in flight is restated");
    assert_eq!(state_of(&projection, &key(&ours, "ses_2", "run-2")), "stopped");
    assert_eq!(state_of(&projection, &key(&ours, "ses_1", "run-1")), "interrupted");
}

/// Retiring an instance that is not the installed one is a no-op rather than an error: a teardown
/// raced by a start would otherwise restate the new instance's work.
#[test]
fn retiring_an_instance_that_is_not_installed_does_nothing() {
    let (mut projection, _) = crate::support::projection_with_clock();
    let previous = first_instance();
    let current = identity(AGENT, VAULT, "epoch-2");
    projection.install(&previous);
    projection.install(&current);
    projection.started(&current, "ses_1", "run-1");

    let restated = projection.retire(&previous);

    assert!(restated.is_empty());
    assert_eq!(state_of(&projection, &key(&current, "ses_1", "run-1")), "working");
    assert_eq!(projection.installed(AGENT, "default", VAULT), Some("epoch-2"));
}

/// A prompt is a fact about a run, and a run is only a task if its instance is the installed one:
/// the host's own view of a session is still a claim by one incarnation.
#[test]
fn a_run_cannot_be_started_against_an_instance_that_is_not_installed() {
    let mut projection = projection();
    let previous = first_instance();
    projection.install(&previous);
    projection.install(&identity(AGENT, VAULT, "epoch-2"));

    let ingest = projection.started(&previous, "ses_1", "run-1");

    assert_eq!(ingest.disposition, Disposition::Foreign);
    assert_eq!(task_count(&projection), 0);
}
