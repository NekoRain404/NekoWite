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
use crate::agent_runtime::process::isolated_profile_env;
use crate::agent_runtime::profile::{
    ConfigMode, ConfigSource, CredentialStorage, DiscoverySurface, ProfileStore,
};
use crate::agent_runtime::skills::{
    opencode_scopes, DisableMechanism, ScopeOwner, SkillError, SkillLibrary, SkillSurface,
    DISABLE_CLAUDE_CODE_SKILLS, DISABLE_EXTERNAL_SKILLS,
};
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
    assert!(
        refused.contains("reuses the engine's own configuration"),
        "{refused}"
    );
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
    assert!(
        refused.contains("reuses the engine's own configuration"),
        "{refused}"
    );

    // And the readout says so, so a page can disable the form rather than let the user fill it in
    // and be refused at save time. The injected roots are gone with the mode, and the list still
    // names what this host does not control.
    let view = read_profile(&store, "engine-alpha", "alpha").unwrap();
    assert_eq!(view["editable"], false);
    assert_eq!(view["credentialStorage"]["kind"], "none");
    let sources = view["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["kind"], "engine-discovery");
    // One surface, and the one that says the narrowing is the *mode's*: a profile reusing the
    // user's own installation narrows nothing, so naming a merge or two would read as though the
    // rest had been closed by somebody.
    assert_eq!(sources[0]["what"], "reused");
}

#[test]
fn the_injected_roots_the_readout_reports_are_the_ones_the_launch_uses() {
    let managed = scratch("sources");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();

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
    //
    // The two are not the same vector, and the difference is a fact about the readout rather than
    // a gap in it: `isolated_profile_env` also carries one entry that is a *switch*, not a root —
    // the engine's own way of stopping its path-driven `.claude`/`.agents` scan — and a page
    // renders `ConfigSource::Injected` as a directory, so a source list that reported `1` as a
    // path would be the confident nonsense §8.1 is against. A root is an absolute path; the
    // filter below is that sentence, and it is the one thing this test states in two places.
    let expected: Vec<(String, String)> =
        crate::agent_runtime::process::isolated_profile_env(profile.root())
            .into_iter()
            .filter(|(_, value)| std::path::Path::new(value).is_absolute())
            .collect();
    assert_eq!(reported, expected);
    assert!(reported
        .iter()
        .all(|(_, path)| path.starts_with(&profile.root().to_string_lossy().to_string())));

    // And the honest half §8.1 requires: the list says what this host does *not* close — one
    // surface at a time, so a reader can count the merges that remain instead of taking a summary
    // for an answer. Both of these are measured open (`agent_profile_isolation_test.rs`), and the
    // managed root is the one no supported switch closes at all.
    let open: Vec<DiscoverySurface> = profile
        .sources()
        .into_iter()
        .filter_map(|source| match source {
            ConfigSource::EngineDiscovery { what } => Some(what),
            ConfigSource::Injected { .. } => None,
        })
        .collect();
    assert_eq!(
        open,
        vec![DiscoverySurface::Project, DiscoverySurface::Managed]
    );
}

/// The other half of the same claim: what a Skills page would list is built from the launch the
/// profile really gets, so a directory the launch has stopped reading cannot arrive there as a
/// live source.
///
/// It is a test rather than a comment because the two facts live in two files: the launch
/// environment is `process::isolated_profile_env`, and the scopes §8.2's page renders are
/// `skills::opencode_scopes`. A scope list taking a hand-kept list of "switches we believe are
/// set" is exactly how the page came to name `.claude` and `.agents` as sources of skills after
/// the app-managed launch had stopped scanning them; feeding it the launch's own vector is the
/// fix, and this is where the two are held together.
#[test]
fn the_scope_readout_reads_the_launch_the_profile_gets() {
    let managed = scratch("scope-readout");
    let store = ProfileStore::new(&managed);
    let profile = store.open("engine-alpha", "alpha").unwrap();

    // Laid out the way the launch's own environment says: `HOME` inside the profile root, one
    // skill in each compatible-tool directory under it, and one the engine could not use — the row
    // whose surface says the least about the scope.
    let home = profile.root().join("HOME");
    let project = managed.join("vault");
    for (directory, body) in [
        (
            ".claude/skills/planted",
            "---\nname: planted\ndescription: d\n---\n",
        ),
        (".claude/skills/broken", "no frontmatter at all\n"),
        (
            ".agents/skills/planted",
            "---\nname: planted\ndescription: d\n---\n",
        ),
    ] {
        let skill = home.join(directory);
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), body).unwrap();
    }
    let in_project = project.join(".opencode/skills/mine");
    fs::create_dir_all(&in_project).unwrap();
    fs::write(
        in_project.join("SKILL.md"),
        "---\nname: mine\ndescription: d\n---\n",
    )
    .unwrap();

    let scopes = opencode_scopes(
        Some(&profile.root().join("XDG_CONFIG_HOME/opencode")),
        &home,
        &project,
        &[],
        &isolated_profile_env(profile.root()),
    );
    let library =
        SkillLibrary::new(scopes, managed.join("skill-store")).expect("library outside the scopes");
    let found = library.discover().expect("discover");

    // Configured, and not contributing. Both foreign directories are *listed* — §8.2 asks for the
    // 来源目录 and the 实际权限状态, not for a shorter list — and neither contributes anything to
    // this launch.
    let foreign: Vec<_> = found
        .iter()
        .filter(|view| view.owner == ScopeOwner::Foreign)
        .collect();
    assert_eq!(foreign.len(), 3, "{found:?}");
    for view in &foreign {
        assert_eq!(
            view.suppressed_by,
            Some(DISABLE_EXTERNAL_SKILLS),
            "{} is configured but must not be described as contributing",
            view.directory.display()
        );
        // And the switch that *would* close it, kept apart from the one that has: a page draws the
        // second as "why there is no control here" and the first as "why the engine is not reading
        // it", and a scope reporting neither would be the one §8.2 refuses.
        let would_close = if view.scope == "claude-code" {
            DISABLE_CLAUDE_CODE_SKILLS
        } else {
            DISABLE_EXTERNAL_SKILLS
        };
        assert_eq!(
            view.disable,
            DisableMechanism::EngineSwitch {
                variable: would_close
            },
            "{}",
            view.scope
        );
    }
    // The row's own surface is a different fact, and it is why `suppressed_by` is a field of its
    // own: this skill's frontmatter is unusable, so a page reading suppression out of the surface
    // would find `Unusable` and have nothing to say about the directory.
    let broken = foreign
        .iter()
        .find(|view| view.name == "broken")
        .expect("the unreadable row is kept rather than dropped");
    assert!(
        matches!(broken.surface, SkillSurface::Unusable { .. }),
        "{:?}",
        broken.surface
    );

    // The engine's own project directory is a different scope and is still read: the switch that
    // closed the two compatible-tool scans does not touch a vault's `.opencode`.
    let mine = found
        .iter()
        .find(|view| view.name == "mine")
        .expect("project row");
    assert_eq!(mine.suppressed_by, None);
    assert_eq!(mine.surface, SkillSurface::Offered);
    assert_eq!(
        library
            .set_enabled(mine, false)
            .expect_err("a vault is not this host's to move"),
        SkillError::NoSwitch {
            scope: "engine-project".to_string(),
            variable: None,
        }
    );
}

#[test]
fn a_credential_name_that_cannot_reach_a_process_is_refused() {
    let managed = scratch("credential-names");
    let store = ProfileStore::new(&managed);
    for name in ["", "A=B", "A\tB"] {
        let refused =
            submit_credentials(&store, "engine-alpha", "alpha", &[set(name, "value")]).unwrap_err();
        assert!(
            refused.contains("environment variable"),
            "{name}: {refused}"
        );
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
    assert!(ProfileStore::new(managed.join("elsewhere"))
        .bindings()
        .unwrap()
        .is_empty());
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

/// The document the editor opens, named by the backend rather than spelled by a window.
///
/// `configDocument` is the one fact the configuration editor cannot derive: the relative path
/// inside the profile root that `agent_config_document` and `agent_config_edit` take. Which file an
/// engine reads under its own root is that engine's layout (§3.4.5), so a component holding a
/// literal path would be the engine known by name in a window — the thing §3.4's last line forbids.
/// Two arms, and each is a different sentence on the page: the profile this host writes in has a
/// document, and the profile that reuses the user's own installation has one this host does not own.
#[test]
fn the_readout_names_the_document_the_editor_may_open() {
    let store = ProfileStore::new(scratch("config-document"));
    let profile = store.open("engine-alpha", "alpha").unwrap();

    let view = read_profile(&store, "engine-alpha", "alpha").unwrap();
    let relative = view["configDocument"]
        .as_str()
        .expect("an app-managed profile names its engine's configuration document");
    // The name is usable, which is the whole point of reporting it: the confinement check every
    // document read goes through accepts it, the path it resolves to is inside this root, and the
    // read the editor's page makes answers rather than refusing.
    let path = profile.document_path(relative).unwrap();
    assert!(path.starts_with(profile.root()), "{path:?}");
    // And the command the editor's page calls accepts it: this is the pair of facts that has to
    // hold together — the name the readout reports and the name `agent_config_document` opens.
    let opened = crate::agent_settings::read_document(&store, "engine-alpha", "alpha", relative)
        .expect("the document the readout named is one the editor may open");
    assert_eq!(opened["path"], path.to_string_lossy().as_ref());
    assert_eq!(opened["editable"], true);

    // The other mode: the engine reads the user's own installation, and this host writes nothing
    // there. `null` is that fact — never a path this app would be claiming to own. The mode switch
    // is the same call the profile page makes.
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
    let reused = read_profile(&store, "engine-alpha", "alpha").unwrap();
    assert!(reused["configDocument"].is_null(), "{reused}");
    // And the two fields agree about it, which is what lets the page choose its arm from either:
    // no document named, no document this host may write.
    assert_eq!(reused["editable"], false);
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
