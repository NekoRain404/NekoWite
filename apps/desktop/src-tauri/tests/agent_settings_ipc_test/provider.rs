//! The provider block a settings form writes, submitted through the command the window calls.
//!
//! The settings page's provider form is not a raw JSONC editor: it takes a base URL, a display name
//! and an id, and the window assembles the block the engine reads out of them. Two things follow
//! from that, and this file is both of them:
//!
//! - **The window names the members, so this file checks the names against the engine.** The value
//!   the form writes is asserted here to have exactly the member paths `agent_live_test.rs`'s
//!   `PROVIDER_CONFIG` has — the block this repository measured against the pinned engine — and the
//!   test reads *that file* rather than a copy of it. A member the form invented would fail here
//!   rather than in a user's session, where the symptom is an engine that lists no models.
//! - **A block is written into a group, and the group is usually not the form's.** `provider` may
//!   hold providers a user wrote by hand, so the form submits two edits: the group with
//!   `ifAbsent`, then the block. The first is a no-op wherever the group already exists, which is
//!   the case below that makes the arm worth having — without it the same submission would replace
//!   the group and delete every provider in it.
//!
//! The document is read back as bytes rather than as JSON, because "the parts it did not touch were
//! not rewritten" is a claim about bytes: a round-trip through a parser would pass this file while
//! losing the comments a real configuration is full of.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::agent_runtime::config_edit;
use crate::agent_runtime::profile::ProfileStore;
use crate::agent_settings::{submit_document, EditSubmission};
use crate::support::{scratch, write_config, RELATIVE};

/// The block, as the window's provider form builds it — the same member paths as `PROVIDER_CONFIG`,
/// with an id and a base URL a test can read without mistaking them for a real endpoint.
fn provider_block(id: &str, base_url: &str, models: &[&str]) -> Value {
    json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": "iApp Gateway",
        "options": { "baseURL": base_url, "apiKey": format!("{{env:NWK_{}_API_KEY}}", id.to_uppercase()) },
        "models": models
            .iter()
            .map(|model| (model.to_string(), json!({ "name": model })))
            .collect::<serde_json::Map<_, _>>(),
    })
}

/// The two edits the form submits, in the order the form submits them.
fn submission(id: &str, base_url: &str, models: &[&str]) -> Vec<EditSubmission> {
    vec![
        EditSubmission {
            path: vec!["provider".to_string()],
            value: json!({}),
            if_absent: true,
        },
        EditSubmission {
            path: vec!["provider".to_string(), id.to_string()],
            value: provider_block(id, base_url, models),
            if_absent: false,
        },
    ]
}

fn submit(store: &ProfileStore, revision: Option<&str>, edits: &[EditSubmission]) -> Value {
    submit_document(store, "engine-alpha", "alpha", RELATIVE, revision, edits)
        .expect("the submission is applied")
}

/// Every member path in a JSON value, as `a.b.c` strings.
fn paths(value: &Value, prefix: &mut Vec<String>, out: &mut Vec<String>) {
    let Value::Object(object) = value else { return };
    for (key, child) in object {
        prefix.push(key.clone());
        out.push(prefix.join("."));
        paths(child, prefix, out);
        prefix.pop();
    }
}

/// `PROVIDER_CONFIG` out of the live test, as JSON.
///
/// Read from the file rather than copied: the point of the comparison is that the two blocks are
/// the same shape, and a copy would be this test agreeing with itself.
fn measured_provider_config() -> Value {
    let source =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/agent_live_test.rs"))
            .expect("the live test is in the tree");
    let raw = source
        .split("const PROVIDER_CONFIG: &str = r#\"")
        .nth(1)
        .and_then(|rest| rest.split("\"#;").next())
        .expect("PROVIDER_CONFIG is a raw string in the live test");
    serde_json::from_str(raw).expect("PROVIDER_CONFIG is JSON")
}

// ---------------------------------------------------------------------------
// The shape, against the block this repository measured
// ---------------------------------------------------------------------------

#[test]
fn the_block_the_form_writes_has_the_members_the_measured_block_has() {
    let mut form = Vec::new();
    paths(
        &provider_block("iapp", "https://ai.example.org/v1", &["m"]),
        &mut Vec::new(),
        &mut form,
    );

    // The one block `PROVIDER_CONFIG` declares — taken as the single member of its `provider`
    // object rather than by the id it happens to use, so renaming the measurement's own provider
    // does not turn this comparison into a failure about a name.
    let measured = measured_provider_config();
    let group = measured["provider"].as_object().expect("a provider group");
    assert_eq!(group.len(), 1, "the measurement declares one provider");
    let mut block = Vec::new();
    paths(
        group.values().next().expect("the measured block"),
        &mut Vec::new(),
        &mut block,
    );

    // The model id is the one name the two blocks may not share — the form writes the ids the
    // endpoint just listed, and the measurement writes the one it was measured with — so it is
    // abstracted on both sides and every *other* member name is compared as it is written.
    let shape = |paths: Vec<String>| -> Vec<String> {
        let mut paths = paths
            .into_iter()
            .map(|path| {
                path.strip_prefix("models.")
                    .map(|rest| match rest.split_once('.') {
                        Some((_, member)) => format!("models.<model>.{member}"),
                        None => "models.<model>".to_string(),
                    })
                    .unwrap_or(path)
            })
            .collect::<Vec<_>>();
        paths.sort();
        paths
    };
    assert_eq!(
        shape(form),
        shape(block),
        "the form's block and `agent_live_test.rs`'s PROVIDER_CONFIG must name the same members",
    );
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

#[test]
fn a_provider_lands_in_the_group_the_document_already_has_and_nothing_else_moves() {
    let managed = scratch("provider-group");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    // `support::CONFIG` is the hard case on purpose: a `provider` member that is already there,
    // holding a block somebody else wrote, with two kinds of comment around it.
    let path = write_config(profile.root(), RELATIVE, crate::support::CONFIG);
    let document = config_edit::read(&path).unwrap().unwrap();

    let answer = submit(
        &store,
        Some(document.revision().as_str()),
        &submission("iapp", "https://ai.example.org/v1", &["deepseek-v4-flash"]),
    );
    assert_eq!(answer["status"], "written");

    // Read back as text, because the fixture is JSONC and no parser here may be handed it — which
    // is the same fact the page is built on. The claims below are the ones a parser would make,
    // spelled as the bytes they are: the group is still the one that was there, the block is inside
    // it, and everything the fixture had is still in the file.
    let after = fs::read_to_string(&path).unwrap();
    for kept in [
        "// The model this engine starts with.",
        "/* Provider blocks are keyed by provider id.",
        "An unreadable member below is kept exactly as written. */",
        "\"anthropic\": {",
        "\"apiKey\": \"sk-not-a-real-key-000000\",", // the trailing comma included
    ] {
        assert!(after.contains(kept), "{kept:?} was lost:\n{after}");
    }
    // One `provider` member, not two: the block went into the group rather than being written
    // beside it as a second member of the root.
    assert_eq!(after.matches("\"provider\": {").count(), 1, "{after}");
    assert_eq!(after.matches("\"iapp\": {").count(), 1, "{after}");
    // The block is the caller's serialization, written as that value's own text — one compact line
    // rather than the document's pretty-printed style. That is what "set this member to this value"
    // means everywhere in this module and it is what the raw editor does too, so it is asserted
    // rather than worked around: a `set` that reformatted a caller's value would be this module
    // having an opinion about JSON the user did not write.
    assert!(
        after.contains("\"baseURL\":\"https://ai.example.org/v1\""),
        "{after}"
    );
    assert!(
        after.contains("\"apiKey\":\"{env:NWK_IAPP_API_KEY}\""),
        "the configuration must carry a reference, never a key:\n{after}"
    );
    // The block is inside the group's braces: everything after the group's opening brace is where
    // both providers are, and the root's closing brace is the only `}` at the end.
    let group_at = after.find("\"provider\": {").unwrap();
    let iapp_at = after.find("\"iapp\": {").unwrap();
    let anthropic_at = after.find("\"anthropic\": {").unwrap();
    assert!(group_at < anthropic_at && group_at < iapp_at, "{after}");
}

#[test]
fn a_document_with_no_provider_member_gains_one() {
    let managed = scratch("provider-absent");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    // The document `apply_shipped_permissions` leaves behind on a first run: a `permission` member
    // and nothing else. A form that could only set members of groups that exist could not configure
    // a provider here at all, which is the state every new profile is in.
    let path = write_config(
        profile.root(),
        RELATIVE,
        "{\n  \"permission\": { \"edit\": \"ask\", \"bash\": \"ask\" }\n}\n",
    );
    let document = config_edit::read(&path).unwrap().unwrap();

    let answer = submit(
        &store,
        Some(document.revision().as_str()),
        &submission(
            "iapp",
            "https://ai.example.org/v1",
            &["deepseek-v4.1-flash"],
        ),
    );
    assert_eq!(answer["status"], "written");

    let after = fs::read_to_string(&path).unwrap();
    assert!(after.contains("\"edit\": \"ask\""), "{after}");
    let parsed: Value = serde_json::from_str(&after).expect("still JSON");
    assert_eq!(
        parsed["provider"]["iapp"]["models"]["deepseek-v4.1-flash"]["name"],
        "deepseek-v4.1-flash"
    );
}

#[test]
fn a_document_that_is_not_there_yet_is_created_with_the_group_and_the_block() {
    let managed = scratch("provider-create");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = profile.root().join(RELATIVE);
    assert!(!path.exists());

    let answer = submit(
        &store,
        None,
        &submission("iapp", "https://ai.example.org/v1", &["glm-5.2"]),
    );
    assert_eq!(answer["status"], "written");
    let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        parsed["provider"]["iapp"]["npm"],
        "@ai-sdk/openai-compatible"
    );
    assert_eq!(
        parsed["provider"]["iapp"]["models"]["glm-5.2"]["name"],
        "glm-5.2"
    );
}

#[test]
fn a_second_provider_is_added_beside_the_first_without_touching_it() {
    let managed = scratch("provider-second");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = write_config(
        profile.root(),
        RELATIVE,
        "{\n  \"permission\": { \"edit\": \"ask\" }\n}\n",
    );

    let first = config_edit::read(&path).unwrap().unwrap();
    submit(
        &store,
        Some(first.revision().as_str()),
        &submission("first", "https://first.example.org/v1", &["m1"]),
    );
    let after_first = fs::read_to_string(&path).unwrap();

    let second = config_edit::read(&path).unwrap().unwrap();
    submit(
        &store,
        Some(second.revision().as_str()),
        &submission("second", "https://second.example.org/v1", &["m2"]),
    );

    let after_second = fs::read_to_string(&path).unwrap();
    let parsed: Value = serde_json::from_str(&after_second).unwrap();
    assert_eq!(
        parsed["provider"]["first"]["options"]["baseURL"],
        "https://first.example.org/v1"
    );
    assert_eq!(
        parsed["provider"]["second"]["options"]["baseURL"],
        "https://second.example.org/v1"
    );
    // The first provider's own bytes are the ones the first write produced: adding a second one did
    // not rewrite the group, which is the whole of what `ifAbsent` is for.
    assert!(
        after_second.contains("\"first\": {\"npm\":\"@ai-sdk/openai-compatible\""),
        "the first block was rewritten:\n{after_second}"
    );
    assert_ne!(after_first, after_second);
}

// ---------------------------------------------------------------------------
// What the group edit may not do
// ---------------------------------------------------------------------------

#[test]
fn the_group_edit_is_a_no_op_on_a_group_a_user_already_wrote() {
    let managed = scratch("provider-ifabsent");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = write_config(profile.root(), RELATIVE, crate::support::CONFIG);
    let document = config_edit::read(&path).unwrap().unwrap();

    // The group edit alone — the arm `ifAbsent` adds, against the member the document already has.
    // This is the falsifying case for the alternative the form could have used: a plain
    // `set(["provider"], {})` would leave this document with no providers in it at all.
    let answer = submit(
        &store,
        Some(document.revision().as_str()),
        &[EditSubmission {
            path: vec!["provider".to_string()],
            value: json!({}),
            if_absent: true,
        }],
    );
    assert_eq!(answer["status"], "written");
    assert_eq!(
        answer["revision"].as_str().unwrap(),
        document.revision().as_str(),
        "a submission that wrote nothing is not a rewrite"
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        crate::support::CONFIG,
        "the document must be byte for byte what it was"
    );
}

#[test]
fn the_same_submission_without_the_flag_replaces_the_group() {
    let managed = scratch("provider-no-flag");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    // JSON, not the JSONC fixture: this test is about what the plain arm does to a group, and the
    // group it does it to has to be readable back for the assertion to be about the members.
    let path = write_config(
        profile.root(),
        RELATIVE,
        "{\n  \"provider\": {\n    \"anthropic\": { \"npm\": \"@ai-sdk/anthropic\" }\n  }\n}\n",
    );
    let document = config_edit::read(&path).unwrap().unwrap();

    // The plain `set` arm, on the same member: the difference between the two arms, stated as what
    // would have happened without the flag. It is also the existing behaviour of the raw editor,
    // which sets a member to a value and always has.
    submit(
        &store,
        Some(document.revision().as_str()),
        &[EditSubmission {
            path: vec!["provider".to_string()],
            value: json!({}),
            if_absent: false,
        }],
    );
    let parsed: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        parsed["provider"],
        json!({}),
        "the plain arm replaces what is there"
    );
}

#[test]
fn a_group_that_is_not_an_object_is_refused_rather_than_replaced() {
    let managed = scratch("provider-not-object");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let path = write_config(
        profile.root(),
        RELATIVE,
        "{\n  \"provider\": \"a string\"\n}\n",
    );
    let document = config_edit::read(&path).unwrap().unwrap();

    let refused = submit_document(
        &store,
        "engine-alpha",
        "alpha",
        RELATIVE,
        Some(document.revision().as_str()),
        &submission("iapp", "https://ai.example.org/v1", &["m"]),
    )
    .unwrap_err();
    assert!(refused.contains("is not a group of settings"), "{refused}");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\n  \"provider\": \"a string\"\n}\n",
        "a refused edit leaves the document as it was"
    );
}
