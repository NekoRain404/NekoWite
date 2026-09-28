use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::super::launch::start_refusal;
use super::super::registry_access::{edit_registry, registry_for};
use super::AgentRuntimeState;
use crate::agent_runtime::registry::{AgentRegistry, DEFAULT_PROFILE};

fn selection(
    registry: &AgentRegistry,
    agent_id: Option<&str>,
    profile_id: Option<&str>,
) -> Result<(String, String), String> {
    let agent_id = agent_id.unwrap_or_else(|| registry.default_agent_id());
    let profile_id = profile_id.map(str::to_string).unwrap_or_else(|| {
        if registry
            .profile_owners()
            .get(DEFAULT_PROFILE)
            .is_some_and(|owner| owner == agent_id)
        {
            DEFAULT_PROFILE.to_string()
        } else {
            // A full digest is a stable, valid 64-byte component even for maximum-length IDs.
            format!("{:x}", Sha256::digest(agent_id.as_bytes()))
        }
    });
    // Validate before opening any profile files: ownership protects stored credentials.
    let mut checked = registry.clone();
    checked
        .bind_profile(&profile_id, agent_id)
        .map_err(|error| start_refusal(&error))?;
    Ok((agent_id.to_string(), profile_id))
}

pub(super) fn selected_registry(
    state: &AgentRuntimeState,
    managed: &Path,
    agent_id: Option<&str>,
    profile_id: Option<&str>,
) -> Result<(Arc<AgentRegistry>, String, String), String> {
    let registry = registry_for(state, managed)?;
    let (agent_id, profile_id) = selection(&registry, agent_id, profile_id)?;
    if registry.profile_owners().contains_key(&profile_id) {
        return Ok((registry, agent_id, profile_id));
    }
    drop(registry);
    edit_registry(state, managed, |registry| {
        registry.bind_profile(&profile_id, &agent_id)
    })?
    .map_err(|error| start_refusal(&error))?;
    Ok((registry_for(state, managed)?, agent_id, profile_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::registry::AgentRegistry;

    #[test]
    fn fallback_default_uses_its_own_profile_after_deletion() {
        let mut registry = AgentRegistry::without_bundled();
        for id in ["first", "second"] {
            let mut entry = AgentRegistry::with_bundled("/bin/true")
                .get("opencode")
                .unwrap()
                .clone();
            entry.agent_id = id.into();
            entry.source = crate::agent_runtime::registry::InstallSource::External;
            registry.register(entry).unwrap();
        }
        registry.set_default_if_unregistered("first");
        registry.remove("first").unwrap();
        let (agent, profile) = selection(&registry, None, None).unwrap();
        assert_eq!(agent, "second");
        assert_ne!(profile, "default");
        registry.bind_profile(&profile, &agent).unwrap();
        assert_eq!(registry.profile_owners()["default"], "first");
    }

    fn registry() -> AgentRegistry {
        let mut registry = AgentRegistry::with_bundled("/bin/true");
        let mut external = registry.get(registry.default_agent_id()).unwrap().clone();
        external.agent_id = "external".into();
        registry.register(external).unwrap();
        registry
    }

    #[test]
    fn selected_agent_keeps_default_and_external_profiles_separate() {
        let registry = registry();
        let default = selection(&registry, None, None).unwrap();
        assert_eq!(
            default,
            (registry.default_agent_id().into(), "default".into())
        );
        let external = selection(&registry, Some("external"), None).unwrap();
        assert_eq!(external.0, "external");
        assert_ne!(external.1, default.1);
        assert!(external.1.len() <= 64);
        assert_eq!(
            external,
            selection(&registry, Some("external"), None).unwrap()
        );
    }

    #[test]
    fn selected_agent_cannot_borrow_another_agents_profile() {
        let registry = registry();
        assert!(selection(&registry, Some("external"), Some("default")).is_err());
        assert!(selection(&registry, Some("missing"), None).is_err());
        assert!(selection(&registry, Some("external"), Some("../escape")).is_err());
    }

    #[test]
    fn selected_agent_binds_once_and_refuses_edits_during_a_start() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "selected-agent-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        std::fs::create_dir_all(&directory).unwrap();
        let state = AgentRuntimeState::default();
        *state.registry.lock().unwrap() = Some(Arc::new(registry()));
        let shared = registry_for(&state, &directory).unwrap();
        assert!(selected_registry(&state, &directory, Some("external"), None).is_err());
        drop(shared);
        let (registry, agent, profile) =
            selected_registry(&state, &directory, Some("external"), None).unwrap();
        assert_eq!(registry.profile_owners().get(&profile), Some(&agent));
        let (_, repeated_agent, repeated_profile) =
            selected_registry(&state, &directory, Some("external"), None).unwrap();
        assert_eq!((agent, profile), (repeated_agent, repeated_profile));
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
