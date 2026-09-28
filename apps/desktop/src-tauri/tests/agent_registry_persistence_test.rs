use nekowite_lib::agent_runtime::registry::persistence::RegistryStorage;
use nekowite_lib::commands::agent_registry::delete_agent;
use nekowite_lib::{
    agent_runtime::registry::AgentRegistry,
    commands::agent_registry::{add_agent, AgentDraft},
    state::{edit_registry, AgentRuntimeState},
};
use std::{fs, sync::Arc};

struct MemoryStorage(std::sync::Mutex<Option<String>>);

#[test]
fn bundled_snapshot_can_open_in_an_empty_acp_edition_then_add_an_agent() {
    let full = AgentRegistry::with_bundled("/opt/bundled/opencode");
    let storage = MemoryStorage(std::sync::Mutex::new(Some(full.persisted_document().unwrap())));
    let mut lean = AgentRegistry::without_bundled();
    lean.load_persisted(&storage).unwrap();
    assert!(add_agent(&mut lean, draft()).is_none());
    assert_eq!(lean.default_agent_id(), "external");
    assert_eq!(lean.profile_owners()["default"], "opencode");
}

#[test]
fn external_launch_includes_the_discovery_directories() {
    let mut registry = AgentRegistry::without_bundled();
    assert!(add_agent(&mut registry, draft()).is_none());
    let launch = registry
        .get("external")
        .unwrap()
        .launch(std::path::Path::new("/unused"), &Default::default());
    let path = launch
        .env
        .iter()
        .find(|(name, _)| name == "PATH")
        .expect("external launch needs the GUI search path");
    assert!(std::env::split_paths(path.1.expose()).any(|dir| dir.ends_with(".local/bin")));
}

#[test]
fn saved_external_default_survives_adding_opencode_and_switching_editions() {
    let mut lean = AgentRegistry::without_bundled();
    assert!(add_agent(&mut lean, draft()).is_none());
    assert_eq!(lean.default_agent_id(), "external");
    let mut opencode = draft();
    opencode.agent_id = "opencode".into();
    assert!(add_agent(&mut lean, opencode).is_none());
    let storage = MemoryStorage(std::sync::Mutex::new(Some(
        lean.persisted_document().unwrap(),
    )));
    for mut restarted in [
        AgentRegistry::without_bundled(),
        AgentRegistry::with_bundled("/opt/bundled/opencode"),
    ] {
        restarted.load_persisted(&storage).unwrap();
        assert_eq!(restarted.default_agent_id(), "external");
        assert_eq!(
            restarted.get("opencode").unwrap().program,
            std::path::Path::new("/bin/true")
        );
        assert_eq!(restarted.profile_owners()["default"], "external");
    }
}
impl RegistryStorage for MemoryStorage {
    fn read(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn write(&self, document: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(document.into());
        Ok(())
    }
}

struct TestRoot(std::path::PathBuf);
impl TestRoot {
    fn new(label: &str) -> Self {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("registry-{label}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn state() -> AgentRuntimeState {
    let state = AgentRuntimeState::default();
    *state.registry.lock().unwrap() = Some(Arc::new(AgentRegistry::with_bundled("/bin/true")));
    state
}

fn draft() -> AgentDraft {
    AgentDraft {
        agent_id: "external".into(),
        display_name: "External".into(),
        program: "/bin/true".into(),
        args: vec![],
        adapter_id: "generic-acp".into(),
    }
}

#[test]
fn agent_registry_add_persists_definition() {
    let root = TestRoot::new("persist");
    let runtime = state();
    assert!(edit_registry(&runtime, root.path(), |registry| add_agent(
        registry,
        draft()
    ))
    .unwrap()
    .is_none());
    let saved = fs::read_to_string(root.path().join("agent-registry.json"))
        .expect("registration must survive restart");
    assert!(saved.contains("external"));
}

#[test]
fn agent_registry_disk_failure_rolls_back_memory() {
    let root = TestRoot::new("failure");
    fs::create_dir(root.path().join("agent-registry.json")).unwrap();
    let runtime = state();
    assert!(edit_registry(&runtime, root.path(), |registry| add_agent(
        registry,
        draft()
    ))
    .is_err());
    assert!(runtime
        .registry
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .get("external")
        .is_none());
}

#[test]
fn agent_registry_reload_preserves_disabled_agents_and_deleted_profile_ownership() {
    let storage = MemoryStorage(std::sync::Mutex::new(None));
    let mut registry = AgentRegistry::with_bundled("/bin/true");
    registry
        .edit_persisted(&storage, |registry| {
            assert!(add_agent(registry, draft()).is_none());
            registry
                .bind_profile("external-profile", "external")
                .unwrap();
            registry.set_enabled("external", false).unwrap();
        })
        .unwrap();
    let mut reloaded = AgentRegistry::with_bundled("/bin/true");
    reloaded.load_persisted(&storage).unwrap();
    assert!(!reloaded.get("external").unwrap().enabled);
    reloaded
        .edit_persisted(&storage, |registry| {
            assert!(delete_agent(registry, "external").is_none());
        })
        .unwrap();
    let mut deleted = AgentRegistry::with_bundled("/bin/true");
    deleted.load_persisted(&storage).unwrap();
    assert!(deleted.get("external").is_none());
    assert_eq!(deleted.profile_owners()["external-profile"], "external");
    assert!(deleted
        .bind_profile("external-profile", "opencode")
        .is_err());
}

#[test]
fn agent_registry_snapshot_never_contains_environment_credentials() {
    let mut registry = AgentRegistry::with_bundled("/bin/true");
    assert!(add_agent(&mut registry, draft()).is_none());
    let mut external = registry.remove("external").unwrap();
    external
        .env_extra
        .push(("TOKEN".into(), "fake-secret-do-not-persist".into()));
    registry.register(external).unwrap();
    let document = registry.persisted_document().unwrap();
    assert!(!document.contains("fake-secret"));
    assert!(!document.contains("TOKEN"));
}

#[test]
fn agent_registry_invalid_storage_does_not_install_partial_records() {
    let storage = MemoryStorage(std::sync::Mutex::new(Some("{invalid".into())));
    let mut registry = AgentRegistry::with_bundled("/bin/true");
    assert!(registry.load_persisted(&storage).is_err());
    assert_eq!(registry.registrations().count(), 1);
    let storage = MemoryStorage(std::sync::Mutex::new(Some(
        r#"{"version":2,"registrations":[],"profileOwners":{}}"#.into(),
    )));
    assert!(registry.load_persisted(&storage).is_err());
}

#[test]
fn agent_registry_failed_delete_keeps_registration_and_external_files() {
    let root = TestRoot::new("delete-failure");
    let runtime = state();
    edit_registry(&runtime, root.path(), |registry| {
        add_agent(registry, draft())
    })
    .unwrap();
    let file = root.path().join("agent-registry.json");
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    fs::write(root.path().join("user-config"), "preserve").unwrap();
    assert!(
        edit_registry(&runtime, root.path(), |registry| delete_agent(
            registry, "external"
        ))
        .is_err()
    );
    assert!(runtime
        .registry
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .get("external")
        .is_some());
    assert_eq!(
        fs::read_to_string(root.path().join("user-config")).unwrap(),
        "preserve"
    );
}

#[test]
fn agent_registry_first_read_and_first_edit_reload_the_saved_file() {
    use nekowite_lib::agent_runtime::binary_registry::BinaryRegistry;
    use nekowite_lib::state::registry_of;
    use std::os::unix::fs::PermissionsExt;
    let root = TestRoot::new("lazy-reload");
    let layout = BinaryRegistry::new(root.path()).unwrap();
    let program = layout.program_of("1.0.0");
    fs::create_dir_all(program.parent().unwrap()).unwrap();
    fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    layout.set_active("1.0.0").unwrap();
    let runtime = AgentRuntimeState::default();
    edit_registry(&runtime, root.path(), |registry| {
        add_agent(registry, draft())
    })
    .unwrap();
    drop(runtime);

    let restarted = AgentRuntimeState::default();
    assert!(registry_of(&restarted, root.path())
        .unwrap()
        .get("external")
        .is_some());
    drop(restarted);
    let restarted = AgentRuntimeState::default();
    assert!(
        edit_registry(&restarted, root.path(), |registry| delete_agent(
            registry, "external"
        ))
        .unwrap()
        .is_none()
    );
    drop(restarted);
    assert!(registry_of(&AgentRuntimeState::default(), root.path())
        .unwrap()
        .get("external")
        .is_none());
    assert!(
        program.exists(),
        "deleting a registration preserves the executable"
    );
}
