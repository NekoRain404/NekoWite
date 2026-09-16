//! 并发冲突 — two writers, and the loser finds out.
//!
//! The rule is the one `platform/gateways/memory-pet/settings.ts` states and the one Rust enforces:
//! a write built on a revision that has moved is refused and the caller reloads. It is never
//! merged, and the test asserts the *file's bytes* after the race rather than only the returned
//! arm, because "the loser was told" and "the winner's value is what is on disk" are two claims.

use std::fs;

use serde_json::json;

use crate::agent_runtime::config_edit::{self, WriteOutcome};
use crate::agent_runtime::profile::{ConfigMode, ProfileFields, ProfileStore, RecordUpdate};
use crate::agent_settings::{read_document, submit_document, EditSubmission};
use crate::support::{edit, scratch, write_config, CONFIG, RELATIVE};

#[test]
fn two_writers_and_the_loser_is_told_rather_than_silently_clobbered() {
    let managed = scratch("conflict");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = write_config(profile.root(), RELATIVE, CONFIG);

    // Both writers read the same document, which is what two open settings pages are.
    let first = config_edit::read(&path).unwrap().unwrap();
    let second = config_edit::read(&path).unwrap().unwrap();
    assert_eq!(first.revision(), second.revision());

    let written = config_edit::apply(
        &path,
        first.revision(),
        &[edit(&["model"], json!("winner/model"))],
    )
    .unwrap();
    let winner_revision = match written {
        WriteOutcome::Written { revision } => revision,
        other => panic!("the first writer must win: {other:?}"),
    };

    let refused = config_edit::apply(
        &path,
        second.revision(),
        &[edit(&["model"], json!("loser/model"))],
    )
    .unwrap();
    match refused {
        WriteOutcome::Conflicted { current } => {
            let current = current.expect("the file is there");
            // The caller is handed the document to reload from — and it is the winner's, not a
            // merge of the two.
            assert_eq!(current.revision(), &winner_revision);
            assert!(current.text().contains("winner/model"));
            assert!(!current.text().contains("loser/model"));
        }
        other => panic!("the second writer must be refused: {other:?}"),
    }
    let after = fs::read_to_string(&path).unwrap();
    assert!(after.contains("winner/model"));
    assert!(!after.contains("loser/model"));
    assert_eq!(
        after,
        CONFIG.replace("\"anthropic/claude-sonnet-4\"", "\"winner/model\"")
    );
}

#[test]
fn the_same_race_through_the_ipc_surface_reports_a_conflict_and_reloads() {
    let managed = scratch("conflict-ipc");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    write_config(profile.root(), RELATIVE, CONFIG);
    let read = read_document(&store, "engine-alpha", "alpha", RELATIVE).unwrap();
    let revision = read["revision"].as_str().unwrap().to_string();

    let edits = vec![EditSubmission {
        path: vec!["model".to_string()],
        value: json!("first/model"),
    }];
    let written =
        submit_document(&store, "engine-alpha", "alpha", RELATIVE, &revision, &edits).unwrap();
    assert_eq!(written["status"], "written");
    let moved = written["revision"].as_str().unwrap().to_string();
    assert_ne!(moved, revision);

    let lost =
        submit_document(&store, "engine-alpha", "alpha", RELATIVE, &revision, &edits).unwrap();
    assert_eq!(lost["status"], "conflict");
    assert_eq!(lost["current"]["revision"], moved);
    assert!(lost["current"]["text"]
        .as_str()
        .unwrap()
        .contains("first/model"));

    // A token that is not the shape this host issues is a *different* refusal from a conflict: the
    // page was never built from a document, and "reload and try again" is the wrong instruction.
    let malformed =
        submit_document(&store, "engine-alpha", "alpha", RELATIVE, "", &edits).unwrap_err();
    assert!(malformed.contains("not a revision"), "{malformed}");
}

#[test]
fn a_record_write_at_a_stale_revision_conflicts_and_hands_back_the_current_one() {
    let managed = scratch("record-conflict");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let stale = profile.revision().clone();

    let first = ProfileFields {
        mode: ConfigMode::AppManaged,
        provider: Some("anthropic".to_string()),
        model_id: Some("model-one".to_string()),
    };
    assert!(matches!(
        profile.set_fields(&stale, first).unwrap(),
        RecordUpdate::Written { .. }
    ));

    // The same form submitted twice: the second is refused, and what it gets back is the record as
    // it now is, not a merge of the two.
    match profile
        .set_fields(
            &stale,
            ProfileFields {
                mode: ConfigMode::AppManaged,
                provider: Some("openai".to_string()),
                model_id: Some("model-two".to_string()),
            },
        )
        .unwrap()
    {
        RecordUpdate::Conflicted { current } => {
            assert_eq!(current.fields.provider.as_deref(), Some("anthropic"));
            assert_eq!(current.fields.model_id.as_deref(), Some("model-one"));
            assert_ne!(&current.revision, &stale);
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
}
