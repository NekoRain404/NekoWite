//! The registry itself: the definitions this app holds, the profile bindings beside them, and the
//! sequence that turns one definition into a live instance.
//!
//! A module of its own rather than a section of [`super`], and the split is by what makes each part
//! change. This file moves when the *table* moves — which definitions exist, which profile belongs
//! to which agent, which of the two is §3.4.1's fixed default, and what §3.4.7's
//! 「停用/删除注册项前处理活跃任务」 refuses. The launch sequence is here for the one reason it
//! cannot be anywhere else: starting an engine is the single operation that needs the table, a
//! definition and the live-instance bookkeeping at once, and each of those answers for itself in
//! its own file.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::super::acp_transport::EngineConnection;
use super::super::adapters;
use super::super::events::AgentIdentity;
use super::super::fs_capability::VaultFiles;
use super::super::live_notes::LiveNotes;
use super::super::profile::Credentials;
use super::super::session::AgentRuntime;
use super::error::RegistryError;
use super::instances::{AgentInstance, LiveInstances};
use super::registration::AgentRegistration;
use super::taxonomy::ProgramState;
use super::validation::validate_id;
use super::DEFAULT_PROFILE;

/// The agent definitions this app has, and the runtimes started from them.
pub struct AgentRegistry {
    /// Keyed by id: the settings list renders in a stable order, and a collision is a refusal
    /// rather than a last-write-wins.
    registrations: BTreeMap<String, AgentRegistration>,
    /// Which agent each profile belongs to (§3.4's Profile row).
    profiles: BTreeMap<String, String>,
    live: Arc<Mutex<LiveInstances>>,
    default_agent: String,
}

impl AgentRegistry {
    /// A registry whose default agent is the bundled OpenCode at `program` — the packaged
    /// sidecar's resolved path, a packaging decision (T14) this module may not guess at (§3.2).
    pub fn with_bundled(program: impl Into<PathBuf>) -> Self {
        let bundled = adapters::opencode::bundled_registration(program.into());
        let agent_id = bundled.agent_id.clone();
        let mut registry = Self {
            registrations: BTreeMap::new(),
            profiles: BTreeMap::new(),
            live: Arc::new(Mutex::new(LiveInstances::new())),
            default_agent: agent_id.clone(),
        };
        // Inserted without the public validation path: the definition is constants plus a
        // caller-supplied path, so the only check that could fail is one this module owns — and
        // `bundled_registration` carries the test that runs it through `validate`.
        registry.registrations.insert(agent_id.clone(), bundled);
        registry
            .profiles
            .insert(DEFAULT_PROFILE.to_string(), agent_id);
        registry
    }

    /// Adds a definition.
    pub fn register(&mut self, registration: AgentRegistration) -> Result<(), RegistryError> {
        registration.validate()?;
        if self.registrations.contains_key(&registration.agent_id) {
            return Err(RegistryError::DuplicateAgent {
                agent_id: registration.agent_id,
            });
        }
        self.registrations
            .insert(registration.agent_id.clone(), registration);
        Ok(())
    }

    /// Every definition, in id order.
    pub fn registrations(&self) -> impl Iterator<Item = &AgentRegistration> {
        self.registrations.values()
    }

    pub fn get(&self, agent_id: &str) -> Option<&AgentRegistration> {
        self.registrations.get(agent_id)
    }

    /// The agent a new session starts on (§3.4.1). It is the bundled engine, not a user
    /// preference, so there is no setter: a default a renderer could set is a state the plan
    /// does not describe.
    pub fn default_agent_id(&self) -> &str {
        &self.default_agent
    }

    /// The agents with a live runtime instance, in id order.
    ///
    /// The read side of §3.4.7's 「停用/删除注册项前处理活跃任务」: [`AgentRegistry::set_enabled`] and
    /// [`AgentRegistry::remove`] refuse while an engine is live, so a settings list that offers
    /// those controls has to be able to say which rows have one. Ids and not epochs — an epoch is
    /// this host's incarnation token (§6.1) and belongs in a runtime-status surface, not in a row a
    /// user reads; the refusal the backend returns names the id too.
    ///
    /// Read from the live table rather than from a flag on the definition, because "is it running"
    /// is a fact about this process's children and must not go stale behind a settings write.
    pub fn running_agent_ids(&self) -> Vec<String> {
        self.live
            .lock()
            .unwrap()
            .live
            .keys()
            .map(|(agent_id, _, _)| agent_id.clone())
            .collect::<BTreeSet<String>>()
            .into_iter()
            .collect()
    }

    /// Which agent each profile belongs to (§3.4's Profile row), in profile-id order.
    ///
    /// Read-only, and a copy rather than a view: the frontend's engine-switch plan asks "does this
    /// profile belong to the engine I am about to start" before it opens a session, which is the
    /// question `start` refuses on. `bind_profile` is the only way in, and it is not reachable from
    /// a renderer.
    pub fn profile_owners(&self) -> BTreeMap<String, String> {
        self.profiles.clone()
    }

    /// Binds a profile to an agent. Rebinding to the *same* one is a no-op, because settings forms
    /// resubmit unchanged values; to a different one it is refused (§3.4's Profile row), since
    /// credentials, model ids and config files are not copied between engines.
    pub fn bind_profile(&mut self, profile_id: &str, agent_id: &str) -> Result<(), RegistryError> {
        validate_id("profile_id", profile_id)?;
        if !self.registrations.contains_key(agent_id) {
            return Err(RegistryError::unknown(agent_id));
        }
        match self.profiles.get(profile_id) {
            Some(owner) if owner == agent_id => Ok(()),
            Some(owner) => Err(RegistryError::unbound(profile_id, agent_id, Some(owner))),
            None => {
                self.profiles
                    .insert(profile_id.to_string(), agent_id.to_string());
                Ok(())
            }
        }
    }

    /// Switches a registration on or off.
    pub fn set_enabled(&mut self, agent_id: &str, enabled: bool) -> Result<(), RegistryError> {
        // §3.4.7: an active task is handled first. A run mid-write does not stop being mid-write
        // because a settings form was submitted, and disabling would leave a live engine behind
        // a registration the host no longer offers.
        if !enabled {
            if agent_id == self.default_agent {
                return Err(RegistryError::IsDefault {
                    agent_id: agent_id.to_string(),
                });
            }
            if let Some(epoch) = self.live.lock().unwrap().epoch_of(agent_id) {
                return Err(RegistryError::InstanceRunning {
                    agent_id: agent_id.to_string(),
                    epoch,
                });
            }
        }
        self.registrations
            .get_mut(agent_id)
            .ok_or_else(|| RegistryError::unknown(agent_id))?
            .enabled = enabled;
        Ok(())
    }

    /// Removes a definition.
    ///
    /// §3.4.7: the app's registration and nothing else — no filesystem call here, so the user's
    /// program, the engine's own config and its session history are untouched, and the profile
    /// bindings stay so re-adding the agent keeps the authorization the user gave it.
    pub fn remove(&mut self, agent_id: &str) -> Result<AgentRegistration, RegistryError> {
        // The default is not a removable entry: §3.4.1 makes it the fixed answer for a new
        // session, and a new-session menu with nothing to preselect is not a state this app has.
        if agent_id == self.default_agent {
            return Err(RegistryError::IsDefault {
                agent_id: agent_id.to_string(),
            });
        }
        if let Some(epoch) = self.live.lock().unwrap().epoch_of(agent_id) {
            return Err(RegistryError::InstanceRunning {
                agent_id: agent_id.to_string(),
                epoch,
            });
        }
        self.registrations
            .remove(agent_id)
            .ok_or_else(|| RegistryError::unknown(agent_id))
    }

    /// Starts one engine and returns the instance that owns it. `managed_root` is the app's
    /// managed directory for this profile (§3.2); a registration whose policy is
    /// [`EnvPolicy::UserEnvironment`](super::taxonomy::EnvPolicy::UserEnvironment) ignores it, because an external engine's profile is the
    /// user's own. `credentials` is what that profile authenticates with (§8.1), and it reaches the
    /// engine through the environment — the channel P0 §3 names — by way of
    /// [`AgentRegistration::launch`].
    ///
    /// `files` and `live_notes` are the two ports the runtime cannot build for itself: where a
    /// delegated write goes, and how a window is asked what a note holds. Both arrive from the
    /// app, for the same reason the registry does not read a file of its own — this module
    /// knows about engines, not about the surfaces that answer for them.
    pub async fn start(
        &self,
        agent_id: &str,
        profile_id: &str,
        vault_id: &str,
        managed_root: &Path,
        credentials: &Credentials,
        files: Arc<dyn VaultFiles>,
        live_notes: LiveNotes,
    ) -> Result<AgentInstance, RegistryError> {
        let registration = self
            .get(agent_id)
            .ok_or_else(|| RegistryError::unknown(agent_id))?;
        // Identity first, refused before anything is spawned: §6.1's rule is that the renderer
        // names an agent and a profile and the backend decides whether that pair exists. A
        // profile belonging to another engine is a request for that engine's credentials (§3.4's
        // Profile row).
        match self.profiles.get(profile_id) {
            Some(owner) if owner == agent_id => {}
            owner => return Err(RegistryError::unbound(profile_id, agent_id, owner)),
        }
        if !registration.enabled {
            return Err(RegistryError::Disabled {
                agent_id: agent_id.to_string(),
            });
        }
        // Re-validated here and not only at registration: the definition can have been edited
        // since, and the user's file can have been deleted, moved or chmod'ed while the app was
        // running.
        registration.validate()?;
        let state = registration.program_state();
        if state != ProgramState::Launchable {
            return Err(RegistryError::Program {
                program: registration.program.clone(),
                state,
            });
        }
        let adapter = registration
            .adapter()
            .ok_or_else(|| RegistryError::UnknownAdapter {
                adapter_id: registration.adapter_id.clone(),
            })?;
        // The engine's own HTTP surface, when its adapter has one: the port is chosen here and
        // the flag appended to the launch, so the routes in [`super::super::permission_grants`] address
        // the process this session is about to talk to over ACP. `None` means this engine has no
        // such surface, which the grants readout reports as its own state rather than as an empty
        // list.
        let mut launch = registration.launch(managed_root, credentials);
        let http = super::super::permission_grants::pin_http(&mut launch, adapter.http_api());
        let epoch = self
            .live
            .lock()
            .unwrap()
            .claim(agent_id, profile_id, vault_id)?;

        let (connection, events) = match EngineConnection::connect(&launch).await {
            Ok(pair) => pair,
            Err(error) => {
                // The claim goes back: a start that never produced a runtime must not make the
                // next attempt look like a second engine for a triple that has none running.
                self.live.lock().unwrap().release(&epoch);
                return Err(RegistryError::LaunchFailed {
                    agent_id: agent_id.to_string(),
                    error,
                });
            }
        };
        let identity = AgentIdentity {
            agent_id: agent_id.to_string(),
            profile_id: profile_id.to_string(),
            runtime_epoch: epoch,
            vault_id: vault_id.to_string(),
        };
        let (runtime, events) =
            AgentRuntime::new(identity.clone(), connection, events, files, live_notes);
        Ok(AgentInstance {
            identity,
            adapter,
            http,
            // `Arc` rather than a value, and only because of what the IPC layer has to do with
            // it: the commands that answer a session take the runtime out of a managed state on
            // another task, so they must hold a share of it rather than the thing itself. The
            // instance stays the owner of the *incarnation* — the epoch claim below — and
            // [`AgentInstance::shutdown`] (and [`Drop`]) still tear the process down.
            runtime: Arc::new(runtime),
            events: Some(events),
            live: Arc::clone(&self.live),
        })
    }
}
