//! The consent default this app ships, as a *write*: which document it lands in, what it does to a
//! document that is already there, and when it writes nothing at all.
//!
//! **Why a unit test can carry this half.** `agent_permission_configured_test.rs` is the live one —
//! it runs the engine and answers a real prompt, which is the only thing that can show the gate
//! closing. What it cannot cheaply show is the difference between the three states of an existing
//! document, because each is a fresh profile and a paid run. That difference is ordinary file
//! behaviour: given a document with a `permission` member, given one without, given none at all.
//!
//! **What is pinned here is the floor, not the rules.** The rules themselves are asserted against
//! the engine by the live test; here the question is only whether this host writes them where it
//! may, leaves alone what is already there, and says which of the two it did.

use std::fs;

use serde_json::Value;

use crate::agent_runtime::config_edit;
use crate::agent_runtime::profile::{
    shipped_permission_block, ConfigMode, PermissionDefaults, ProfileStore, ENGINE_CONFIG_DOCUMENT,
    PERMISSION_MEMBER, SHIPPED_PERMISSION_RULES,
};
use crate::agent_settings::{read_profile, ProfileSubmission};
use crate::support::{scratch, write_config};

/// The engine's own configuration as a profile starts: absent, because nothing has configured the
/// engine in it yet.
#[test]
fn a_fresh_profile_is_configured_to_ask() {
    let managed = scratch("permission-fresh");
    let profile = ProfileStore::new(&managed)
        .open("engine-alpha", "alpha")
        .unwrap();

    // The answer, not just the file: `Written` is what the settings page reports as "this app
    // wrote the rules", and the two other arms would each be a different sentence on screen.
    assert_eq!(
        profile.apply_shipped_permissions().unwrap(),
        PermissionDefaults::Written,
        "the member the first call wrote is this host's own, so a second call finds it already \
         in force rather than treating it as somebody else's and reporting `Left` about its own \
         write"
    );

    let document = config_edit::read(&profile.root().join(ENGINE_CONFIG_DOCUMENT))
        .unwrap()
        .expect("the first open wrote the engine's configuration");
    let parsed: Value = serde_json::from_str(document.text()).unwrap();
    assert_eq!(parsed[PERMISSION_MEMBER], shipped_permission_block());
    // `ask` is the engine's own word for this and the whole point of writing anything: the engine's
    // built-in default is to allow (`permission-is-the-only-lever.md` §3 measured a write with no
    // frame at all), so a rule that said anything else would leave the user where they were.
    for tool in ["edit", "bash"] {
        assert_eq!(parsed[PERMISSION_MEMBER][tool], Value::String("ask".into()));
    }
    assert_eq!(
        SHIPPED_PERMISSION_RULES.len(),
        2,
        "the shipped block is edit + bash"
    );
}

/// The readout says which of the two happened, because the page's sentence depends on it.
#[test]
fn the_readout_reports_that_this_host_wrote_the_rules() {
    let managed = scratch("permission-readout");
    let store = ProfileStore::new(&managed);
    store.open("engine-alpha", "alpha").unwrap();
    let readout = read_profile(&store, "engine-alpha", "alpha").unwrap();

    assert_eq!(readout["permissions"]["state"], "written");
    assert!(readout["permissions"]["document"].is_string());
    let rules = readout["permissions"]["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0]["tool"], "edit");
    assert_eq!(rules[0]["action"], "ask");
}

/// A document this host already wrote is kept byte for byte — the second open is not a rewrite.
#[test]
fn an_existing_document_keeps_its_bytes_and_its_own_member() {
    let managed = scratch("permission-existing");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();

    // A comment, a member this app has never heard of, and a permission member the *user* wrote —
    // the three things a write of ours must not touch. The document is written where the engine
    // reads it, through the same helper the profile's own path resolves to.
    let theirs = "{\n  // kept\n  \"provider\": { \"iapp\": {} },\n  \"permission\": { \"edit\": \"allow\" }\n}\n";
    write_config(profile.root(), ENGINE_CONFIG_DOCUMENT, theirs);

    let reopened = store.open("engine-alpha", "alpha").unwrap();
    assert_eq!(
        reopened.apply_shipped_permissions().unwrap(),
        PermissionDefaults::Left,
        "a document with its own `permission` member is not this host's to overwrite"
    );

    let after = fs::read_to_string(profile.root().join(ENGINE_CONFIG_DOCUMENT)).unwrap();
    assert_eq!(
        after, theirs,
        "the user's own rules, their comment and their provider block must survive unchanged"
    );
}

/// A document without the member gains it, and nothing else in it moves.
///
/// This is the arm a user who configured a provider but no permissions is in, and the one where
/// "preserve comments and unknown fields" stops being a slogan: the edit splices one member into
/// the text, so every other byte is the user's.
#[test]
fn a_document_without_the_member_gains_it_and_loses_nothing() {
    let managed = scratch("permission-splice");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();

    let theirs = "{\n  // my provider\n  \"provider\": { \"iapp\": { \"name\": \"mine\" } }\n}\n";
    write_config(profile.root(), ENGINE_CONFIG_DOCUMENT, theirs);

    let reopened = store.open("engine-alpha", "alpha").unwrap();
    assert_eq!(
        reopened.apply_shipped_permissions().unwrap(),
        PermissionDefaults::Written,
        "the member is there now and it is this host's own, so the second call writes nothing"
    );

    // Written twice and read twice: the second open must not have appended a second member, which
    // is what an idempotence that only *looked* idempotent would do.
    let after = fs::read_to_string(profile.root().join(ENGINE_CONFIG_DOCUMENT)).unwrap();
    assert_eq!(after.matches("\"permission\"").count(), 1, "{after}");
    assert!(after.contains("// my provider"), "{after}");
    assert!(after.contains("\"name\": \"mine\""), "{after}");
    assert!(after.contains("\"permission\""), "{after}");
}

/// A profile that reuses the user's own installation is not written to at all.
///
/// §8.1's reuse mode is the one where this host edits nothing — a page that showed rules here would
/// be showing a consent default nothing applied.
#[test]
fn a_reused_installation_is_not_written_to() {
    let managed = scratch("permission-reused");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let revision = profile.revision().as_str().to_string();
    let switched = crate::agent_settings::submit_profile(
        &store,
        "engine-alpha",
        "alpha",
        &revision,
        &ProfileSubmission {
            mode: ConfigMode::UserConfig.id().to_string(),
            provider: None,
            model_id: None,
        },
    )
    .unwrap();
    assert_eq!(switched["status"], "written");

    let reopened = store.open("engine-alpha", "alpha").unwrap();
    assert_eq!(
        reopened.apply_shipped_permissions().unwrap(),
        PermissionDefaults::NotThisHosts
    );
    let readout = read_profile(&store, "engine-alpha", "alpha").unwrap();
    assert_eq!(readout["permissions"]["state"], "not-this-host");
    // No path, because this host owns no document here — a page drawing one would be naming a file
    // it does not write.
    assert!(readout["permissions"]["document"].is_null());
}
