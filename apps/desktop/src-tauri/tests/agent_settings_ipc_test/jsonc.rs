//! JSONC 保留 — §8.1's 「保留注释和未知字段」, asserted as bytes.
//!
//! A real configuration has comments in it, and a round-trip that reformats the file is data loss
//! from the user's point of view. The strongest form of "preserved" is what the first test below
//! checks: the result is the original with exactly one span replaced. The rest cover the three ways
//! an edit can go wrong around that — a member added in the wrong style, a parent chain that is
//! absent, and a document the scanner cannot follow at all (refused, never half-rewritten).

use std::fs;

use serde_json::json;

use crate::agent_runtime::config_edit::{self, ConfigError, WriteOutcome};
use crate::agent_runtime::profile::ProfileStore;
use crate::agent_settings::refusal_message;
use crate::support::{edit, scratch, write_config, CONFIG, RELATIVE};

// ---------------------------------------------------------------------------
// JSONC 保留
// ---------------------------------------------------------------------------

#[test]
fn an_edit_replaces_one_span_and_leaves_every_other_byte_alone() {
    let managed = scratch("jsonc");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = write_config(profile.root(), RELATIVE, CONFIG);
    let document = config_edit::read(&path).unwrap().unwrap();

    let outcome = config_edit::apply(
        &path,
        document.revision(),
        &[edit(&["model"], json!("openai/gpt-5"))],
    )
    .unwrap();
    assert!(matches!(outcome, WriteOutcome::Written { .. }));

    let after = fs::read_to_string(&path).unwrap();
    assert_eq!(
        after,
        CONFIG.replace("\"anthropic/claude-sonnet-4\"", "\"openai/gpt-5\""),
        "the document must be the original with exactly one value replaced"
    );
    // Named individually as well, so a failure says which kind of preservation broke.
    for kept in [
        "// The model this engine starts with.",
        "/* Provider blocks are keyed by provider id.",
        "An unreadable member below is kept exactly as written. */",
        "\"apiKey\": \"sk-not-a-real-key-000000\",", // the trailing comma included
        "\"experimental\": { \"someFutureFlag\": true },",
    ] {
        assert!(after.contains(kept), "{kept:?} was lost");
    }
}

#[test]
fn a_new_member_is_added_in_the_documents_own_style() {
    let managed = scratch("jsonc-add");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = write_config(profile.root(), RELATIVE, CONFIG);
    let document = config_edit::read(&path).unwrap().unwrap();

    config_edit::apply(
        &path,
        document.revision(),
        &[
            edit(&["provider", "anthropic", "options", "timeout"], json!(30)),
            edit(&["small"], json!(true)),
        ],
    )
    .unwrap();

    let after = fs::read_to_string(&path).unwrap();
    // Both objects already end their last member with a comma, so an added member goes *past* that
    // comma and brings its own: the document keeps its style rather than ending up with one member
    // separated by a newline and the rest by commas.
    assert!(
        after.contains("\"apiKey\": \"sk-not-a-real-key-000000\",\n"),
        "{after}"
    );
    assert!(after.contains("\"timeout\": 30,\n"), "{after}");
    assert!(
        after.contains("\"experimental\": { \"someFutureFlag\": true },\n"),
        "{after}"
    );
    assert!(after.contains("\"small\": true,\n}"), "{after}");
    assert!(!after.contains(",,"), "{after}");
    // The comments and the unknown member are still there.
    assert!(after.contains("/* Provider blocks are keyed by provider id."));
    assert!(after.contains("\"someFutureFlag\": true"));
    // And the result is a document this scanner can read again: the strongest available statement
    // that the text it produced is still JSONC, and that a second edit can be built on it.
    let reread = config_edit::read(&path).unwrap().unwrap();
    assert_ne!(reread.revision(), document.revision());
    config_edit::apply(&path, reread.revision(), &[edit(&["model"], json!("x"))]).unwrap();
}

#[test]
fn a_member_whose_parent_chain_is_missing_is_refused_rather_than_invented() {
    let managed = scratch("jsonc-missing");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = write_config(profile.root(), RELATIVE, CONFIG);
    let document = config_edit::read(&path).unwrap().unwrap();

    // `mcp` is not in the document, and building it would be this app deciding what an engine's
    // configuration should look like (§3.4.5 says that is the adapter's answer).
    let outcome = config_edit::apply(
        &path,
        document.revision(),
        &[edit(&["mcp", "filesystem"], json!({}))],
    );
    match outcome {
        Err(ConfigError::Missing { path }) => assert_eq!(path, vec!["mcp".to_string()]),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        CONFIG,
        "nothing was written"
    );
}

#[test]
fn a_document_this_scanner_cannot_follow_is_refused_and_left_alone() {
    let managed = scratch("jsonc-broken");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let broken = "{ // unterminated member list\n  \"model\": \"x\"\n";
    let path = write_config(profile.root(), RELATIVE, broken);
    let document = config_edit::read(&path).unwrap().unwrap();

    match config_edit::apply(&path, document.revision(), &[edit(&["model"], json!("y"))]) {
        // The offset is where the scan stopped — here the opening brace, because the member list
        // is what never closed — and the message says which structure was left open.
        Err(ConfigError::Syntax { message, .. }) => {
            assert!(message.contains("never closed"), "{message}")
        }
        other => panic!("expected a syntax refusal, got {other:?}"),
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), broken);
    // The refusal the settings page renders names a byte offset and quotes nothing: a parse error
    // is not a place a document's text — or a key inside it — may appear.
    let message = refusal_message(
        &ConfigError::Syntax {
            path: path.clone(),
            offset: 12,
            message: "unexpected end of input".to_string(),
        }
        .into(),
    );
    assert!(message.contains("byte 12"), "{message}");
    assert!(!message.contains("sk-not-a-real-key-000000"));
}
