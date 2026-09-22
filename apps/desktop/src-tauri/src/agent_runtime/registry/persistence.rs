//! Credential-free registry snapshots and the injected storage transaction boundary.

use super::{AgentRegistration, AgentRegistry, EnvPolicy, InstallSource};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

pub trait RegistryStorage {
    fn read(&self) -> Result<Option<String>, String>;
    /// An error must leave the previously committed document intact.
    fn write(&self, document: &str) -> Result<(), String>;
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    version: u32,
    registrations: Vec<ExternalDefinition>,
    profile_owners: BTreeMap<String, String>,
}

// Environment values and credentials have no representation in the persistent schema.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExternalDefinition {
    agent_id: String,
    display_name: String,
    program: PathBuf,
    args: Vec<String>,
    enabled: bool,
    adapter_id: String,
}

impl AgentRegistry {
    pub fn load_persisted(&mut self, storage: &dyn RegistryStorage) -> Result<(), String> {
        let Some(document) = storage.read()? else {
            return Ok(());
        };
        let document: RegistryDocument = serde_json::from_str(&document)
            .map_err(|error| format!("cannot read agent registry: {error}"))?;
        if document.version != 1 {
            return Err("unsupported agent registry version".into());
        }
        let mut candidate = self.clone();
        for entry in document.registrations {
            candidate
                .register(AgentRegistration {
                    agent_id: entry.agent_id,
                    display_name: entry.display_name,
                    program: entry.program,
                    args: entry.args,
                    enabled: entry.enabled,
                    adapter_id: entry.adapter_id,
                    source: InstallSource::External,
                    env: EnvPolicy::UserEnvironment,
                    env_extra: Vec::new(),
                    reported_version: None,
                })
                .map_err(|error| format!("invalid saved agent registration: {error:?}"))?;
        }
        for (profile, owner) in document.profile_owners {
            super::validation::validate_id("profile_id", &profile)
                .and_then(|()| super::validation::validate_id("agent_id", &owner))
                .map_err(|error| format!("invalid saved profile owner: {error:?}"))?;
            if candidate
                .profiles
                .get(&profile)
                .is_some_and(|existing| existing != &owner)
            {
                return Err("saved profile ownership conflicts with the bundled profile".into());
            }
            // Orphan bindings intentionally survive deletion so another agent cannot claim
            // the deleted engine's credentials or history on a later launch.
            candidate.profiles.insert(profile, owner);
        }
        *self = candidate;
        Ok(())
    }

    pub fn persisted_document(&self) -> Result<String, String> {
        let registrations = self
            .registrations()
            .filter(|entry| entry.source == InstallSource::External)
            .map(|entry| ExternalDefinition {
                agent_id: entry.agent_id.clone(),
                display_name: entry.display_name.clone(),
                program: entry.program.clone(),
                args: entry.args.clone(),
                enabled: entry.enabled,
                adapter_id: entry.adapter_id.clone(),
            })
            .collect();
        serde_json::to_string_pretty(&RegistryDocument {
            version: 1,
            registrations,
            profile_owners: self.profile_owners(),
        })
        .map_err(|error| format!("cannot encode agent registry: {error}"))
    }

    pub fn edit_persisted<T>(
        &mut self,
        storage: &dyn RegistryStorage,
        change: impl FnOnce(&mut Self) -> T,
    ) -> Result<T, String> {
        let before = self.persisted_document()?;
        let mut candidate = self.clone();
        let answer = change(&mut candidate);
        let after = candidate.persisted_document()?;
        // Publish to disk before replacing memory. The shared live-instance table is kept,
        // but definitions and profile ownership cannot leak out of a failed transaction.
        if after != before {
            storage.write(&after)?;
        }
        *self = candidate;
        Ok(answer)
    }
}
