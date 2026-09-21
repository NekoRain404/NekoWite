//! 配置隔离 — §3.4's Profile row, as files on disk.
//!
//! The evidence is not a comment claiming isolation. `tree_text` reads every byte under one
//! engine's profile root, and the assertions are that the *other* engine's credential and model id
//! are not among them — plus the three refusals that make copying impossible in the first place: a
//! profile bound to one engine cannot be opened as another, an id that is not one path component is
//! not an id, and a relative path that would leave the root is refused rather than normalized.

use std::fs;

use crate::agent_runtime::profile::{
    ConfigMode, CredentialChange, ProfileError, ProfileFields, ProfileStore,
};
use crate::agent_runtime::secret::Secret;
use crate::agent_settings::{read_profile, refusal_message};
use crate::support::{scratch, tree_text, RELATIVE};

// ---------------------------------------------------------------------------
// 配置隔离
// ---------------------------------------------------------------------------

#[test]
fn one_engines_credentials_and_model_do_not_reach_another_profiles_files() {
    let managed = scratch("isolation");
    let store = ProfileStore::new(&managed);

    let mut alpha = store.open("engine-alpha", "alpha").expect("alpha");
    alpha
        .apply_credentials(&[CredentialChange::Set {
            name: "ANTHROPIC_API_KEY".to_string(),
            value: Secret::new("sk-alpha-0123456789abcdef"),
        }])
        .expect("alpha credentials");
    let mut beta = store.open("engine-beta", "beta").expect("beta");
    beta.apply_credentials(&[CredentialChange::Set {
        name: "OPENAI_API_KEY".to_string(),
        value: Secret::new("sk-beta-fedcba9876543210"),
    }])
    .expect("beta credentials");

    // Each profile's own model selection, which §3.4 names beside the credentials: a model id is
    // part of what must not be copied between engines.
    alpha
        .set_fields(
            alpha.revision(),
            ProfileFields {
                mode: ConfigMode::AppManaged,
                provider: Some("anthropic".to_string()),
                model_id: Some("alpha-only-model".to_string()),
            },
        )
        .expect("alpha fields");
    beta.set_fields(
        beta.revision(),
        ProfileFields {
            mode: ConfigMode::AppManaged,
            provider: Some("openai".to_string()),
            model_id: Some("beta-only-model".to_string()),
        },
    )
    .expect("beta fields");

    // Roots that cannot contain each other: nothing under one is reachable from the other.
    assert!(alpha.root().starts_with(&managed));
    assert!(beta.root().starts_with(&managed));
    assert_ne!(alpha.root(), beta.root());
    assert!(!beta.root().starts_with(alpha.root()));
    assert!(!alpha.root().starts_with(beta.root()));

    // The evidence: every byte of beta's profile, searched for alpha's secrets.
    let beta_text = tree_text(beta.root());
    assert!(
        beta_text.contains("sk-beta-fedcba9876543210"),
        "the other direction has to be real"
    );
    assert!(!beta_text.contains("sk-alpha-0123456789abcdef"));
    assert!(!beta_text.contains("alpha-only-model"));
    assert!(!beta_text.contains("ANTHROPIC_API_KEY"));

    let alpha_text = tree_text(alpha.root());
    assert!(!alpha_text.contains("sk-beta-fedcba9876543210"));
    assert!(!alpha_text.contains("beta-only-model"));

    // And through the readouts, which is what a page would render.
    let alpha_view = read_profile(&store, "engine-alpha", "alpha")
        .unwrap()
        .to_string();
    assert!(!alpha_view.contains("sk-beta-fedcba9876543210"));
    assert!(alpha_view.contains("alpha-only-model"));
    let beta_view = read_profile(&store, "engine-beta", "beta")
        .unwrap()
        .to_string();
    assert!(!beta_view.contains("sk-alpha-0123456789abcdef"));
    assert!(!beta_view.contains("alpha-only-model"));
}

#[test]
fn a_profile_bound_to_one_engine_cannot_be_opened_as_another() {
    let managed = scratch("rebind");
    let store = ProfileStore::new(&managed);
    store.open("engine-alpha", "shared").expect("created");

    match store.open("engine-beta", "shared") {
        Err(ProfileError::AgentMismatch {
            profile_id,
            requested,
            bound,
        }) => {
            assert_eq!(profile_id, "shared");
            assert_eq!(requested, "engine-beta");
            assert_eq!(bound, "engine-alpha");
        }
        other => panic!("a rebind must be refused, got {other:?}"),
    }
    // The refusal names the engine it does belong to, because "not found" would send the user
    // looking for a profile that is right there.
    let message = refusal_message(&store.open("engine-beta", "shared").unwrap_err());
    assert!(message.contains("engine-alpha"), "{message}");
}

#[test]
fn a_profile_id_that_is_not_one_path_component_is_refused() {
    let managed = scratch("ids");
    let store = ProfileStore::new(&managed);
    for id in ["..", ".", "a/b", "/etc", "", "./alpha"] {
        match store.open("engine-alpha", id) {
            Err(ProfileError::Id { profile_id }) => assert_eq!(profile_id, id),
            other => panic!("`{id}` must not be a profile id, got {other:?}"),
        }
    }
    // Nothing was created outside the managed directory by any of the attempts.
    let profiles = managed.join(crate::agent_runtime::profile::PROFILES_DIR);
    assert!(!profiles.exists() || fs::read_dir(&profiles).unwrap().count() == 0);
}

#[test]
fn a_document_path_that_would_leave_the_profile_is_refused() {
    let managed = scratch("escape");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    for relative in [
        "../outside.jsonc",
        "/etc/opencode/opencode.jsonc",
        "a/../../b",
    ] {
        match profile.document_path(relative) {
            Err(ProfileError::Escapes { relative: refused }) => assert_eq!(refused, relative),
            other => panic!("`{relative}` must not resolve, got {other:?}"),
        }
    }
    assert!(profile
        .document_path(RELATIVE)
        .unwrap()
        .starts_with(profile.root()));
}

/// **A name that would decide what the engine *runs* is refused, and the user is told why.**
///
/// Finding S5 in `docs/audits/2026-09-21-code-review.md`. This surface is reachable from the window
/// and what it writes becomes the engine's environment: `LD_PRELOAD` is read by the dynamic loader
/// before the engine's first instruction, and `OPENCODE_CONFIG_DIR` decides which document the
/// engine's permission rules come from — `environment.rs` records that a mis-set one stops this
/// app's shipped permission block from being applied.
///
/// What is pinned is the *reason*, not only the refusal. A user who typed `LD_PRELOAD` into a
/// credentials form should learn that the name would run their code rather than authenticate them,
/// and a bare "cannot be an environment variable name" would send them looking for a typo. The
/// last case is the same name in another case, because the kernel treats `Path` and `PATH` as one
/// variable and under-refusing is the dangerous direction.
#[test]
fn a_credential_name_that_would_decide_what_the_engine_runs_is_refused() {
    let managed = scratch("reserved-credential");
    let store = ProfileStore::new(&managed);
    let mut profile = store.open("engine-alpha", "alpha").expect("alpha");

    for (name, expected) in [
        ("LD_PRELOAD", "dynamic loader"),
        ("DYLD_INSERT_LIBRARIES", "dynamic loader"),
        ("NODE_OPTIONS", "before its first line"),
        ("OPENCODE_CONFIG_DIR", "configuration namespace"),
        ("XDG_CONFIG_HOME", "configuration roots"),
        ("HOME", "configuration and state"),
        ("Path", "bare command"),
    ] {
        let refusal = profile
            .apply_credentials(&[CredentialChange::Set {
                name: name.to_string(),
                value: Secret::new("/tmp/elsewhere"),
            }])
            .expect_err("a reserved name must be refused");
        match refusal {
            ProfileError::Credential {
                name: refused,
                reserved: Some(why),
            } => {
                assert_eq!(refused, name);
                assert!(
                    why.contains(expected),
                    "`{name}` was refused without saying why ({why:?} does not mention {expected})"
                );
            }
            other => panic!("`{name}` was refused for the wrong reason: {other:?}"),
        }
    }

    // The same surface still takes a provider key, so what is refused is the name and not the call.
    profile
        .apply_credentials(&[CredentialChange::Set {
            name: "ANTHROPIC_API_KEY".to_string(),
            value: Secret::new("sk-alpha-0123456789abcdef"),
        }])
        .expect("a provider key is what this surface is for");
}
