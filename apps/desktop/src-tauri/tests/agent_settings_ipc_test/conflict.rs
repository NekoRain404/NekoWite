//! 并发冲突 — two writers, and the loser finds out.
//!
//! The rule is the one `platform/gateways/memory-pet/settings.ts` states and the one Rust enforces:
//! a write built on a revision that has moved is refused and the caller reloads. It is never
//! merged, and the test asserts the *file's bytes* after the race rather than only the returned
//! arm, because "the loser was told" and "the winner's value is what is on disk" are two claims.
//!
//! **A create is the same rule, and it is tested here for that reason.** The claim an edit carries
//! is what its caller *read*, and one of the things a page can read is no document at all — the
//! state a profile whose engine has not been configured is in. So "there was no document" is a
//! claim about the filesystem like any other: it is checked under the same lock against the same
//! disk, and the loser of a create race is told rather than overwriting the file that appeared.
//! What a create may not do is invent a *member chain* (§3.4.5), which the last test pins.

use std::fs;
use std::os::unix::fs::PermissionsExt;

use serde_json::{json, Value};

use crate::agent_runtime::config_edit::{self, ConfigError, WriteOutcome};
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
    let written = submit_document(
        &store,
        "engine-alpha",
        "alpha",
        RELATIVE,
        Some(revision.as_str()),
        &edits,
    )
    .unwrap();
    assert_eq!(written["status"], "written");
    let moved = written["revision"].as_str().unwrap().to_string();
    assert_ne!(moved, revision);

    let lost = submit_document(
        &store,
        "engine-alpha",
        "alpha",
        RELATIVE,
        Some(revision.as_str()),
        &edits,
    )
    .unwrap();
    assert_eq!(lost["status"], "conflict");
    assert_eq!(lost["current"]["revision"], moved);
    assert!(lost["current"]["text"]
        .as_str()
        .unwrap()
        .contains("first/model"));

    // A token that is not the shape this host issues is a *different* refusal from a conflict: the
    // page was never built from a document, and "reload and try again" is the wrong instruction.
    // `Some("")` and not `None`: the empty string is a malformed *revision*, while the claim that
    // there is no document at all is `None` and is a legitimate one (the create tests below).
    let malformed =
        submit_document(&store, "engine-alpha", "alpha", RELATIVE, Some(""), &edits).unwrap_err();
    assert!(malformed.contains("not a revision"), "{malformed}");
}

// ---------------------------------------------------------------------------
// The claim that there is no document
// ---------------------------------------------------------------------------

/// An edit against a document that is not there creates it, with the member the caller named as
/// its whole content.
///
/// `RELATIVE` is not a path this host writes on its own, which is the fixture this needs: the
/// document an engine reads (`ENGINE_CONFIG_DOCUMENT`) is created by the open itself, for the
/// consent default, so the absent state is only reachable for a document nothing else has written.
#[test]
fn an_edit_against_a_document_that_is_not_there_creates_it() {
    let managed = scratch("create");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = profile.root().join(RELATIVE);
    assert!(
        config_edit::read(&path).unwrap().is_none(),
        "this test is about a document that is not there; the fixture must start without one"
    );

    let outcome = config_edit::apply_claim(
        &path,
        None,
        &[edit(&["model"], json!("anthropic/claude-sonnet-4"))],
    )
    .unwrap();
    let revision = match outcome {
        WriteOutcome::Written { revision } => revision,
        other => panic!("a create must write: {other:?}"),
    };

    // The member the caller named and nothing else: no comment, no member this host invented, and
    // the empty document spliced exactly the way a member is added to one that is already there.
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\n  \"model\": \"anthropic/claude-sonnet-4\"\n}"
    );
    // The revision the answer reports is the bytes that are on disk, which is what makes the next
    // edit buildable from the answer alone.
    assert_eq!(
        config_edit::read(&path).unwrap().unwrap().revision(),
        &revision
    );
    // And it is a document this host wrote, so it wears the mode every document of ours wears.
    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, config_edit::DOCUMENT_MODE);
}

/// A create that names a parent chain the document does not have is refused, and leaves no file.
///
/// The rule §3.4.5 leaves to the adapter does not depend on whether the file was already there:
/// which members an engine expects is not this host's answer, and an empty document is not licence
/// to start inventing them.
#[test]
fn a_create_refuses_a_chain_the_document_does_not_have_rather_than_inventing_it() {
    let managed = scratch("create-chain");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = profile.root().join(RELATIVE);

    match config_edit::apply_claim(&path, None, &[edit(&["mcp", "filesystem"], json!({}))]) {
        Err(ConfigError::Missing { path }) => assert_eq!(path, vec!["mcp".to_string()]),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(
        !path.exists(),
        "a refused create must not leave a file behind: an engine handed a document this host \
         invented members into is the failure the refusal exists to prevent"
    );
}

/// A create makes the directories the document lives in.
///
/// The engine's configuration directory is not one this host is guaranteed to have written before
/// — the document an engine reads lives under a root the *engine's own layout* names — so a create
/// that could only write beside an existing directory would fail on exactly the profile that needs
/// it.
#[test]
fn a_create_makes_the_directories_the_document_lives_in() {
    let managed = scratch("create-dirs");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let relative = "XDG_CONFIG_HOME/another-engine/config.jsonc";
    let path = profile.root().join(relative);
    assert!(!path.parent().unwrap().exists());

    assert!(matches!(
        config_edit::apply_claim(&path, None, &[edit(&["model"], json!("x"))]).unwrap(),
        WriteOutcome::Written { .. }
    ));
    assert!(path.exists());
}

/// A claim of absence with nothing to write is not a create.
///
/// The empty submission is the form resubmitted unchanged, and its answer for a document that
/// exists reports the revision already there so nothing touches the file's mtime. There is no such
/// revision here — and creating `{}` would be writing an engine a document nobody asked for — so the
/// answer is the arm that says "there is still no document", which is what the caller reloads from.
#[test]
fn a_create_with_nothing_to_create_it_from_writes_nothing() {
    let managed = scratch("create-empty");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = profile.root().join(RELATIVE);

    match config_edit::apply_claim(&path, None, &[]).unwrap() {
        WriteOutcome::Conflicted { current } => assert!(current.is_none()),
        other => panic!("expected the no-document arm, got {other:?}"),
    }
    assert!(!path.exists(), "nothing was asked to be written");
}

/// The same race as a create: the document appears between the read and the write, and the create
/// loses rather than overwriting what appeared.
#[test]
fn a_create_that_loses_its_race_is_told_rather_than_overwriting_what_appeared() {
    let managed = scratch("create-race");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();

    // What the page holds: the read answers there is nothing here, and hands the form the claim a
    // create is built on — `revision: null`.
    let read = read_document(&store, "engine-alpha", "alpha", RELATIVE).unwrap();
    assert_eq!(read["exists"], false);
    assert_eq!(read["revision"], Value::Null);

    let edits = vec![EditSubmission {
        path: vec!["model".to_string()],
        value: json!("winner/model"),
    }];
    let written = submit_document(&store, "engine-alpha", "alpha", RELATIVE, None, &edits).unwrap();
    assert_eq!(written["status"], "written");
    let winner = written["revision"].as_str().unwrap().to_string();

    // The second writer claims the same absence — and the file is there now. It is told, and the
    // winner's content is what is on disk afterwards: a create is a compare-and-swap, not a
    // licence to write over a document nobody read.
    let lost = submit_document(
        &store,
        "engine-alpha",
        "alpha",
        RELATIVE,
        None,
        &[EditSubmission {
            path: vec!["model".to_string()],
            value: json!("loser/model"),
        }],
    )
    .unwrap();
    assert_eq!(lost["status"], "conflict");
    assert_eq!(lost["current"]["revision"], winner.as_str());
    assert!(lost["current"]["text"]
        .as_str()
        .unwrap()
        .contains("winner/model"));

    let after = fs::read_to_string(profile.root().join(RELATIVE)).unwrap();
    assert!(after.contains("winner/model"), "{after}");
    assert!(!after.contains("loser/model"), "{after}");
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
