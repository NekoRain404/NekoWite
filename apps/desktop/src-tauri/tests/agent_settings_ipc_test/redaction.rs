//! 凭据脱敏 — a value is reported with credentials removed.
//!
//! `profile::Secret` is the mechanism (no `Display`, no `Serialize`, a hand-written `Debug`), and
//! these tests search every surface a value could reach: the readout the page renders, the `Debug`
//! lines a diagnostic prints, the refusal messages a form shows, and the credential file itself.
//! The last test is the one that keeps redaction from being mistaken for a functional change: the
//! engine still receives the real value, because the environment is the channel P0 §3 names for it.

use std::fs;

use crate::agent_runtime::profile::{ProfileError, ProfileStore, Secret};
use crate::agent_settings::{read_document, read_profile, refusal_message, submit_credentials};
use crate::support::{remove, scratch, set, write_config, CONFIG, RELATIVE, SECRET_VALUE};

#[test]
fn a_credential_is_absent_from_every_readout_line_of_debug_and_refusal() {
    let managed = scratch("redaction");
    let store = ProfileStore::new(&managed);
    let secret = Secret::new(SECRET_VALUE);
    assert_eq!(format!("{secret:?}"), "\"<redacted>\"");

    submit_credentials(
        &store,
        "engine-alpha",
        "alpha",
        &[set("ANTHROPIC_API_KEY", SECRET_VALUE)],
    )
    .unwrap();

    let view = read_profile(&store, "engine-alpha", "alpha").unwrap();
    let rendered = view.to_string();
    assert!(!rendered.contains(SECRET_VALUE), "{rendered}");
    // The name is reported — which providers are configured is a fact about the setup — and the
    // value is the placeholder.
    assert_eq!(view["credentials"][0]["name"], "ANTHROPIC_API_KEY");
    assert_eq!(view["credentials"][0]["value"], "<redacted>");
    // The storage is described honestly: not encrypted, not a keychain (§8.1).
    assert_eq!(view["credentialStorage"]["encrypted"], false);
    assert_eq!(view["credentialStorage"]["keychain"], false);
    assert_eq!(view["credentialStorage"]["mode"], "600");

    // The refusal messages are the other surface a value could leak through, so every arm is
    // walked rather than the one a test happened to trigger.
    for error in [
        ProfileError::Id { profile_id: "../x".to_string() },
        ProfileError::AgentMismatch {
            profile_id: "alpha".to_string(),
            requested: "engine-beta".to_string(),
            bound: "engine-alpha".to_string(),
        },
        ProfileError::ReadOnly,
        ProfileError::Field { field: "mode" },
        ProfileError::Credential { name: "A=B".to_string() },
    ] {
        let message = refusal_message(&error);
        assert!(!message.contains(SECRET_VALUE), "{message}");
    }

    // The credential still reaches the launch environment — the one exposure, by name, and the
    // reason this is asserted rather than left implicit: redaction that also stopped the engine
    // from authenticating would be a broken feature, not a safe one.
    let profile = store.open("engine-alpha", "alpha").unwrap();
    assert_eq!(
        profile.credentials().launch_pairs(),
        vec![("ANTHROPIC_API_KEY".to_string(), SECRET_VALUE.to_string())]
    );
    assert!(!format!("{:?}", profile.credentials()).contains(SECRET_VALUE));
    assert!(!format!("{:?}", profile.readout()).contains(SECRET_VALUE));
}

#[test]
fn editing_one_credential_leaves_the_others_alone() {
    let managed = scratch("credential-patch");
    let store = ProfileStore::new(&managed);
    submit_credentials(
        &store,
        "engine-alpha",
        "alpha",
        &[set("ANTHROPIC_API_KEY", "sk-one"), set("OPENAI_API_KEY", "sk-two")],
    )
    .unwrap();

    // The page shows names and the placeholder, so it cannot resubmit a value it does not have.
    // A surface that took a whole set would have deleted `OPENAI_API_KEY` on this request, with
    // nothing on screen to say so.
    let after_set = submit_credentials(&store, "engine-alpha", "alpha", &[set("ANTHROPIC_API_KEY", "sk-three")])
        .unwrap();
    let names: Vec<&str> = after_set["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

    let mut profile = store.open("engine-alpha", "alpha").unwrap();
    assert_eq!(
        profile.credentials().launch_pairs(),
        vec![
            ("ANTHROPIC_API_KEY".to_string(), "sk-three".to_string()),
            ("OPENAI_API_KEY".to_string(), "sk-two".to_string()),
        ]
    );

    // And a removal is a removal: the name is gone from the set rather than stored as an empty
    // string, which is what an engine would read as "a key that is empty".
    let after_remove =
        submit_credentials(&store, "engine-alpha", "alpha", &[remove("OPENAI_API_KEY")]).unwrap();
    assert_eq!(after_remove["credentials"].as_array().unwrap().len(), 1);
    profile = store.open("engine-alpha", "alpha").unwrap();
    assert_eq!(profile.credentials().names(), vec!["ANTHROPIC_API_KEY"]);
    let file = fs::read_to_string(profile.credential_file()).unwrap();
    assert!(!file.contains("OPENAI_API_KEY"));
}

#[test]
fn the_document_read_is_the_editors_and_carries_no_redaction_it_would_have_to_undo() {
    let managed = scratch("editor-text");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    write_config(profile.root(), RELATIVE, CONFIG);

    let view = read_document(&store, "engine-alpha", "alpha", RELATIVE).unwrap();
    assert_eq!(view["exists"], true);
    assert_eq!(view["editable"], true);
    // Byte-identical to the file: an editor that received a rewritten document could not save it
    // back without destroying the comments.
    assert_eq!(view["text"].as_str().unwrap(), CONFIG);
    assert!(view["path"].as_str().unwrap().starts_with(&profile.root().to_string_lossy().to_string()));
}
