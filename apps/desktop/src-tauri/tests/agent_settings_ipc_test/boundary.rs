//! The boundary the renderer is not trusted across, and the wiring the integrator still owes.
//!
//! §6.1: this layer validates and delegates, and §11.1 requires the checks to be *at the boundary*
//! rather than in a helper the boundary might forget to call. What is here is the set of requests a
//! settings page could make that must not be taken at face value — a mode string, a profile that is
//! not this host's to write, a credential name that cannot reach a process — together with the two
//! claims about configuration *sources* that §8.1 requires to be reported rather than implied.

use std::fs;

use serde_json::{json, Value};

use crate::agent_runtime::config_edit::{self, Revision};
use crate::agent_runtime::profile::{ConfigMode, ConfigSource, CredentialStorage, ProfileStore};
use crate::agent_settings::{
    read_profile, submit_credentials, submit_document, submit_profile, EditSubmission,
    ProfileSubmission,
};
use crate::support::{scratch, set, write_config, CONFIG, RELATIVE, SECRET_VALUE};

// ---------------------------------------------------------------------------
// The boundary the renderer is not trusted across
// ---------------------------------------------------------------------------

#[test]
fn a_mode_this_build_does_not_know_is_refused_rather_than_defaulted() {
    let managed = scratch("modes");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    let revision = profile.revision().as_str().to_string();

    let refused = submit_profile(
        &store,
        "engine-alpha",
        "alpha",
        &revision,
        &ProfileSubmission {
            mode: "ap-managed".to_string(), // a typo, and the direction that matters: it must not
            provider: None,                 // silently become app-managed
            model_id: None,
        },
    )
    .unwrap_err();
    assert!(refused.contains("configuration mode"), "{refused}");

    let accepted = submit_profile(
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
    assert_eq!(accepted["status"], "written");
    assert_eq!(accepted["current"], Value::Null);
}

#[test]
fn a_profile_that_reuses_the_users_own_configuration_refuses_writes() {
    let managed = scratch("user-config");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();
    write_config(profile.root(), RELATIVE, CONFIG);
    let document = config_edit::read(&profile.document_path(RELATIVE).unwrap())
        .unwrap()
        .unwrap();

    submit_profile(
        &store,
        "engine-alpha",
        "alpha",
        profile.revision().as_str(),
        &ProfileSubmission {
            mode: ConfigMode::UserConfig.id().to_string(),
            provider: None,
            model_id: None,
        },
    )
    .unwrap();

    // §8.1's mode switch 「不自动移动或覆盖旧文件」, made unwritable rather than merely discouraged:
    // the host writes only into a profile it owns.
    let refused = submit_document(
        &store,
        "engine-alpha",
        "alpha",
        RELATIVE,
        document.revision().as_str(),
        &[EditSubmission {
            path: vec!["model".to_string()],
            value: json!("nope"),
        }],
    )
    .unwrap_err();
    assert!(refused.contains("reuses the engine's own configuration"), "{refused}");
    assert_eq!(
        fs::read_to_string(profile.document_path(RELATIVE).unwrap()).unwrap(),
        CONFIG
    );

    let refused = submit_credentials(
        &store,
        "engine-alpha",
        "alpha",
        &[set("ANTHROPIC_API_KEY", SECRET_VALUE)],
    )
    .unwrap_err();
    assert!(refused.contains("reuses the engine's own configuration"), "{refused}");

    // And the readout says so, so a page can disable the form rather than let the user fill it in
    // and be refused at save time. The injected roots are gone with the mode, and the list still
    // names what this host does not control.
    let view = read_profile(&store, "engine-alpha", "alpha").unwrap();
    assert_eq!(view["editable"], false);
    assert_eq!(view["credentialStorage"]["kind"], "none");
    let sources = view["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["kind"], "engine-discovery");
}

#[test]
fn the_injected_roots_the_readout_reports_are_the_ones_the_launch_uses() {
    let managed = scratch("sources");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();

    let expected = crate::agent_runtime::process::isolated_profile_env(profile.root());
    let reported: Vec<(String, String)> = profile
        .sources()
        .into_iter()
        .filter_map(|source| match source {
            ConfigSource::Injected { variable, path } => {
                Some((variable, path.to_string_lossy().into_owned()))
            }
            ConfigSource::EngineDiscovery { .. } => None,
        })
        .collect();
    // Derived from the launch's own function, so a report that claimed isolation the launch does
    // not provide would be a compile-level difference rather than a documentation one.
    assert_eq!(reported, expected);
    assert!(reported.iter().all(|(_, path)| path.starts_with(&profile.root().to_string_lossy().to_string())));

    // And the honest half §8.1 requires: the list says what this host does *not* close.
    assert!(matches!(
        profile.sources().last(),
        Some(ConfigSource::EngineDiscovery { .. })
    ));
}

#[test]
fn a_credential_name_that_cannot_reach_a_process_is_refused() {
    let managed = scratch("credential-names");
    let store = ProfileStore::new(&managed);
    for name in ["", "A=B", "A\tB"] {
        let refused = submit_credentials(&store, "engine-alpha", "alpha", &[set(name, "value")])
            .unwrap_err();
        assert!(refused.contains("environment variable"), "{name}: {refused}");
    }
    // Nothing was written by any of the refusals, and the profile still describes where a
    // credential would live — the refusal is about the name, not about the profile.
    let profile = store.open("engine-alpha", "alpha").unwrap();
    assert!(profile.credentials().names().is_empty());
    assert!(matches!(
        profile.readout().credential_storage,
        CredentialStorage::HostFile { .. }
    ));
}

#[test]
fn every_profile_the_store_holds_reports_which_engine_owns_it() {
    let managed = scratch("bindings");
    let store = ProfileStore::new(&managed);
    store.open("engine-alpha", "alpha").unwrap();
    store.open("engine-beta", "beta").unwrap();

    // What the composition root hands `AgentRegistry::bind_profile` at startup: the on-disk answer,
    // which is the one that survives a restart and therefore the one that has to be replayed from
    // every record rather than remembered.
    assert_eq!(
        store.bindings().unwrap(),
        vec![
            ("alpha".to_string(), "engine-alpha".to_string()),
            ("beta".to_string(), "engine-beta".to_string()),
        ]
    );
    // An empty store is not an error: a first run has no profiles.
    assert!(ProfileStore::new(managed.join("elsewhere")).bindings().unwrap().is_empty());
}

#[test]
fn a_revision_that_is_not_the_shape_this_host_issues_never_reaches_a_comparison() {
    assert!(Revision::parse("").is_none());
    assert!(Revision::parse("1").is_none());
    assert!(Revision::parse(&"z".repeat(64)).is_none());
    let real = Revision::of("{}");
    assert!(Revision::parse(real.as_str()).is_some());
    // Length is not the check on its own: 64 characters of anything but hex is not a revision.
    assert!(Revision::parse(&"a".repeat(63)).is_none());
}

#[test]
fn the_command_names_the_composition_root_registers_are_the_ones_this_file_has() {
    // The wiring point, transcribed where it cannot rot: `lib.rs` and `commands/mod.rs` are T4's
    // files, so the registration is theirs to make — and a rename on this side has to break
    // something. Taking the functions as values is that something (and a Tauri command cannot be
    // *called* here: it needs a `State`, which needs an app).
    let _registered = (
        crate::agent_settings::agent_profile_read,
        crate::agent_settings::agent_profile_write,
        crate::agent_settings::agent_config_document,
        crate::agent_settings::agent_config_edit,
        crate::agent_settings::agent_credentials_write,
    );
    // And the state type the root has to build, from the managed directory §3.2 gives it: a fresh
    // app has no profiles, and asking is not an error.
    let state = crate::agent_settings::AgentSettingsState::new(scratch("state"));
    assert!(state.store.bindings().unwrap().is_empty());
}
