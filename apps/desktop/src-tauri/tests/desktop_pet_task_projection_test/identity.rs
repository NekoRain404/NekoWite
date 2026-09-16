//! What names a task — §6.1's composite identity, and the collision it exists for.
//!
//! Two engines reporting the same `sessionId` is not a hypothetical: the id is the engine's own
//! claim about itself (`agent_isolation_test.rs`'s premise, where two copies of one engine really
//! do emit `ses_fake_1`), and the upstream app keys its store on `` `${agent}:${session}` `` and
//! then finds a session by `endsWith(':${session}')` (`state.ts:54`, `:85-89`), which makes two
//! engines' work one entry. Every case here is that failure, in one of its forms.

use nekowite_lib::agent_runtime::events::AgentEventKind;

use crate::desktop_pet::task_projection::Disposition;
use crate::support::{
    envelope, finished, first_instance, key, other_instance, permission, projection, state_of,
    task_count,
};

/// The collision the whole section is about: one session id, two engines, both applied.
#[test]
fn two_engines_reporting_one_session_id_are_two_tasks() {
    let mut projection = projection();
    let ours = first_instance();
    let theirs = other_instance();
    projection.install(&ours);
    projection.install(&theirs);

    projection.started(&ours, "ses_1", "run-1");
    projection.started(&theirs, "ses_1", "run-1");

    assert_eq!(
        task_count(&projection),
        2,
        "one session id is two engines' sessions, so it is two tasks"
    );
    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "working"
    );
    assert_eq!(
        state_of(&projection, &key(&theirs, "ses_1", "run-1")),
        "working"
    );
}

/// Filing one engine's ending under the other's task is what a lookup by session id does, and it
/// is invisible from the outside: the list still has two rows, one of which is now wrong.
#[test]
fn one_engines_ending_does_not_end_the_others_run() {
    let mut projection = projection();
    let ours = first_instance();
    let theirs = other_instance();
    projection.install(&ours);
    projection.install(&theirs);
    projection.started(&ours, "ses_1", "run-1");
    projection.started(&theirs, "ses_1", "run-1");

    let ingest = projection.apply(&finished(&ours, "ses_1", "run-1", 1, "end-turn"));

    assert_eq!(ingest.disposition, Disposition::Applied);
    assert_eq!(
        ingest.key.as_ref(),
        Some(&key(&ours, "ses_1", "run-1")),
        "the frame was filed under the engine that sent it, run and all"
    );
    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "turn-finished"
    );
    assert_eq!(
        state_of(&projection, &key(&theirs, "ses_1", "run-1")),
        "working",
        "the other engine's run is still in flight"
    );
}

/// The sequence space belongs to an engine session (§6.3), so two engines numbering their frames
/// from one is not a replay — it is two streams. A log keyed by session id alone makes the second
/// engine's first frame look like the first engine's duplicate, and its work disappears.
#[test]
fn two_engines_numbering_from_one_are_not_replays_of_each_other() {
    let mut projection = projection();
    let ours = first_instance();
    let theirs = other_instance();
    projection.install(&ours);
    projection.install(&theirs);
    projection.started(&ours, "ses_1", "run-1");
    projection.started(&theirs, "ses_1", "run-1");

    let first = projection.apply(&finished(&ours, "ses_1", "run-1", 1, "end-turn"));
    let second = projection.apply(&finished(&theirs, "ses_1", "run-1", 1, "end-turn"));

    assert_eq!(first.disposition, Disposition::Applied);
    assert_eq!(
        second.disposition,
        Disposition::Applied,
        "the same number on another engine's stream is not the same frame"
    );
}

/// §6.1: an event that belongs to no turn has no task to change, whatever else it says.
#[test]
fn a_frame_that_names_no_run_changes_no_task() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");

    // `commands-changed` is the kind the host publishes outside any run, which is why it is the
    // one used here: the case is about the missing run, not about the kind.
    let ingest = projection.apply(&envelope(
        &ours,
        "ses_1",
        None,
        1,
        AgentEventKind::CommandsChanged,
        serde_json::json!({ "commands": [] }),
    ));

    assert_eq!(ingest.disposition, Disposition::Foreign);
    assert!(ingest.key.is_none());
    assert_eq!(task_count(&projection), 1, "the started task is untouched");
}

/// A stream-scoped frame for the wrong session is a different task, not a missing one: the key it
/// is filed under is the one the frame named, and nothing about the engine is guessed.
#[test]
fn a_frame_is_filed_under_the_session_it_names() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.started(&ours, "ses_2", "run-1");

    projection.apply(&finished(&ours, "ses_2", "run-1", 1, "end-turn"));

    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "working"
    );
    assert_eq!(
        state_of(&projection, &key(&ours, "ses_2", "run-1")),
        "turn-finished"
    );
}

/// The prompt is filed under the run it belongs to, so a permission on one run cannot suspend
/// another run of the same session — which is what a session-keyed lookup would do.
#[test]
fn a_prompt_on_one_run_does_not_suspend_the_session_s_other_run() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    projection.started(&ours, "ses_1", "run-1");
    projection.started(&ours, "ses_1", "run-2");

    projection.apply(&permission(&ours, "ses_1", "run-2", 1, "req-1"));

    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-1")),
        "working"
    );
    assert_eq!(
        state_of(&projection, &key(&ours, "ses_1", "run-2")),
        "waiting-input"
    );
    assert_eq!(
        projection
            .task(&key(&ours, "ses_1", "run-2"))
            .and_then(|task| task.permission_request_id.clone()),
        Some("req-1".to_string())
    );
    assert_eq!(
        projection
            .task(&key(&ours, "ses_1", "run-1"))
            .and_then(|task| task.permission_request_id.clone()),
        None
    );
}

/// §6.1's identity is six fields, and every one of them tells two tasks apart. This is the case a
/// four-field key passes and a session-id key fails: same engine, same session, same run number,
/// two vaults.
#[test]
fn the_vault_a_run_belongs_to_is_part_of_what_names_it() {
    let mut projection = projection();
    let here = first_instance();
    let elsewhere = crate::support::identity(crate::support::AGENT, "vault-b", "epoch-1");
    projection.install(&here);
    projection.install(&elsewhere);
    projection.started(&here, "ses_1", "run-1");
    projection.started(&elsewhere, "ses_1", "run-1");

    projection.apply(&finished(&here, "ses_1", "run-1", 1, "end-turn"));

    assert_eq!(task_count(&projection), 2);
    assert_eq!(
        state_of(&projection, &key(&here, "ses_1", "run-1")),
        "turn-finished"
    );
    assert_eq!(
        state_of(&projection, &key(&elsewhere, "ses_1", "run-1")),
        "working"
    );
}

/// The shape the frontend reads. D1's `PetTaskProjection` is frozen, so the key's field names are
/// part of the contract and not an implementation detail of this module.
#[test]
fn the_projection_serializes_as_the_contract_names_it() {
    let mut projection = projection();
    let ours = first_instance();
    projection.install(&ours);
    let ingest = projection.started(&ours, "ses_1", "run-1");
    let task = ingest.task.expect("a run that just began is a task");
    let json = serde_json::to_value(&task).expect("the projection is serializable");

    assert_eq!(json["key"]["agentId"], "opencode");
    assert_eq!(json["key"]["profileId"], "default");
    assert_eq!(json["key"]["runtimeEpoch"], "epoch-1");
    assert_eq!(json["key"]["vaultId"], "vault-a");
    assert_eq!(json["key"]["sessionId"], "ses_1");
    assert_eq!(json["key"]["runId"], "run-1");
    assert_eq!(json["state"], "working");
    assert_eq!(json["permissionRequestId"], serde_json::Value::Null);
    assert_eq!(json["updatedAt"], 1_000);
}
