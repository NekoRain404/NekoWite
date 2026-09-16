//! Agent definitions: which engines this app may start, and what identity each launch
//! carries.
//!
//! §3.4 splits this in two: `registry.rs` owns the *definitions* — id, source, program,
//! arguments, environment policy, enabled flag, config adapter — while
//! `binary_registry.rs` (T14) owns version and path *selection*. Not one manager, because
//! merging them would make "update this engine" and "start the engine the user registered"
//! the same operation.
//!
//! Two rules shape the rest. **Identity is composite** (§6.1): agentId + profileId +
//! vaultId + runtimeEpoch, the epoch minted here and never supplied by a caller — two
//! engines issuing the same `sessionId` is normal (§3.4's session row), so §6.2's
//! stale-frame check needs two incarnations never to share a name. **Validation proves
//! launchability, nothing more** (§3.4.4): registration is not a sandbox, so
//! [`ProgramState::Launchable`] means a file existed and was executable when it was
//! checked, not that the program is safe.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::acp_transport::EngineConnection;
use super::adapters::{self, AgentAdapter, Capability, HostFeature};
use super::events::{AgentIdentity, TransportError};
use super::fs_capability::VaultFiles;
use super::process::{EngineLaunch, isolated_profile_env};
use super::session::{AgentRuntime, AgentRuntimeEvents};

/// The profile the first-run flow uses, before T12's settings pages exist (§8.1's
/// app-managed profile, under the name it has until a UI can choose another).
pub const DEFAULT_PROFILE: &str = "default";

const MAX_ID_BYTES: usize = 64;

/// Where a registration's program came from (§3.4's install-source row).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallSource {
    /// Shipped in the app package; the default engine's source.
    Bundled,
    /// Installed by this host into its own data directory (§3.2).
    Managed,
    /// The user's own installation; §3.4.6 leaves it alone.
    External,
}

/// Who may replace a program, decided by where it came from — a method, not a stored
/// field, so an `External` registration cannot claim a host-managed policy and describe
/// an app that swaps a binary out from under the user's own installation (§3.4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatePolicy {
    /// The host may fetch a new artifact and switch the pointer (T14).
    HostManaged,
    /// The host may report that a newer version exists, and nothing else.
    ReportedOnly,
}

impl InstallSource {
    pub fn update_policy(self) -> UpdatePolicy {
        match self {
            InstallSource::Bundled | InstallSource::Managed => UpdatePolicy::HostManaged,
            InstallSource::External => UpdatePolicy::ReportedOnly,
        }
    }
}

/// What an engine's environment is built from: the engine inherits this process's
/// environment (the SDK's `envs` adds to it; nothing clears it), so the policy is about
/// *roots*, which are what make an engine read and write the profile this app owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvPolicy {
    /// `HOME` and the XDG roots point into §3.2's `agent-profiles/<profile-id>/`, so
    /// config, credentials and sessions stay in a profile this app owns — and a second
    /// engine gets a different one.
    ProfileIsolated,
    /// Nothing is injected: an external installation keeps its own credentials (§3.1).
    UserEnvironment,
}

/// What a registration's program path is, as of the moment it was asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramState {
    /// A file with an executable bit, at one instant.
    Launchable,
    /// A relative path, refused rather than resolved against this process's working
    /// directory — the app's, not the user's — where a bare `opencode` would resolve to
    /// something nobody intended, or to nothing.
    NotAbsolute,
    /// No file there now. It may have been there when the registration was written, which
    /// is why deletion is not the answer — the definition stands, the diagnostic reports.
    Missing,
    /// Something is there and it is not a file (a directory, a device).
    NotAFile,
    /// A file with no executable bit for anyone.
    NotExecutable,
}

/// Why a registration, a start or a mutation was refused. Data only: the wording a user
/// reads belongs to the frontend (T13a's form, the settings list), and this is what it maps.
#[derive(Debug, Clone)]
pub enum RegistryError {
    /// An id that cannot be an identity or a path component: §3.2 puts profile and vault
    /// ids into directory names, so a `/` or a `..` here is a path traversal dressed as
    /// configuration.
    Id { field: &'static str, value: String },
    /// The program path failed — kept apart from [`RegistryError::Argument`] because §3.4.3
    /// has the user supply a path *and* an argument list, and a diagnostic that cannot say
    /// which is wrong sends them to fix the wrong one.
    Program { program: PathBuf, state: ProgramState },
    /// One argument is unusable, by its position in the array.
    Argument { index: usize },
    /// A variable that cannot reach a process: an empty name, an `=` or a control character
    /// in the name, or a NUL in the value (`execve` takes NUL-terminated strings).
    Environment { name: String },
    /// No verified adapter answers to that id, so the engine's differences have no owner.
    UnknownAdapter { adapter_id: String },
    /// Already registered: replacing a definition while an instance may run on it is not an
    /// edit, it is a race.
    DuplicateAgent { agent_id: String },
    UnknownAgent { agent_id: String },
    /// The profile does not belong to this agent (`owner` is the agent it does belong to, if
    /// any). §3.4's Profile row forbids copying a profile between engines, which is what stops
    /// an external engine from being handed OpenCode's credentials.
    ProfileUnbound {
        profile_id: String,
        agent_id: String,
        owner: Option<String>,
    },
    /// The registration is switched off (§3.4.3's enable/disable column).
    Disabled { agent_id: String },
    /// A runtime for this (agent, profile, vault) is already live. §3.4 forbids one global
    /// engine standing in for every agent, and two engines on one profile are two writers
    /// into one config and one session store.
    AlreadyRunning { agent_id: String, epoch: String },
    /// §3.4.7: an active task is stopped before the registration it belongs to is switched
    /// off or removed.
    InstanceRunning { agent_id: String, epoch: String },
    /// The default agent is the plan's fixed answer for a new session (§3.4.1). Removing or
    /// disabling it would leave the new-session menu with nothing to preselect and
    /// [`AgentRegistry::default_agent_id`] naming an agent that is not registered, so the
    /// registry refuses to create that state instead of leaving it to a frontend to avoid.
    IsDefault { agent_id: String },
    /// The engine could not be started, carrying the transport's own classification rather
    /// than a flattened string so a missing binary and a refused handshake stay
    /// distinguishable at the IPC boundary.
    LaunchFailed { agent_id: String, error: TransportError },
}

impl RegistryError {
    fn unknown(agent_id: &str) -> Self {
        RegistryError::UnknownAgent {
            agent_id: agent_id.to_string(),
        }
    }

    fn unbound(profile_id: &str, agent_id: &str, owner: Option<&String>) -> Self {
        RegistryError::ProfileUnbound {
            profile_id: profile_id.to_string(),
            agent_id: agent_id.to_string(),
            owner: owner.cloned(),
        }
    }
}

/// One agent definition — §3.4's first row, field for field. Public fields, because this is
/// the shape the settings layer reads and writes; the rules live in
/// [`AgentRegistration::validate`], applied on the way in and again at
/// [`AgentRegistry::start`], since a definition can be edited at any moment and the machine
/// can change under it.
#[derive(Clone)]
pub struct AgentRegistration {
    /// The stable identity; it travels in every envelope (§6.2), so it outlives any name.
    pub agent_id: String,
    /// What the user sees; renameable without touching anything else.
    pub display_name: String,
    pub source: InstallSource,
    /// The executable. Never a command line: §3.4.3 forbids concatenating one.
    pub program: PathBuf,
    /// The arguments, as an array, in order. A space inside an argument belongs to that
    /// argument and is never a separator — see [`AgentRegistration::launch`].
    pub args: Vec<String>,
    pub env: EnvPolicy,
    /// Variables this registration adds on top of the policy. Credentials should not need to
    /// live here (P0 §3: the environment is the channel, `argv` is world-readable), but a user
    /// can put anything in it — which is why this is the field the type refuses to print.
    pub env_extra: Vec<(String, String)>,
    pub enabled: bool,
    /// Which adapter owns this engine's differences (§3.4's last line), validated against
    /// [`adapters::lookup`] so a typo fails at the form, not at launch.
    pub adapter_id: String,
    /// As the last diagnostic reported it. Reported, and nothing else: nothing here turns
    /// this value into a download, a swap, or an "update available" that acts.
    pub reported_version: Option<String>,
}

impl std::fmt::Debug for AgentRegistration {
    /// Hand-written, because a derived one would print `env_extra` verbatim and a value in
    /// there can be a credential. §2.1 names 「环境变量日志脱敏」 against this file, and this
    /// impl is where that lands. Arguments *are* printed: they are the user's own visible
    /// field in the settings form, and P0 §3 already rules credentials out of `argv` — the
    /// environment is the channel that carries them.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentRegistration")
            .field("agent_id", &self.agent_id)
            .field("display_name", &self.display_name)
            .field("source", &self.source)
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &self.env)
            .field("env_extra", &redacted_env(&self.env_extra))
            .field("enabled", &self.enabled)
            .field("adapter_id", &self.adapter_id)
            .field("reported_version", &self.reported_version)
            .finish()
    }
}

impl AgentRegistration {
    /// Everything about a definition that can be judged without the machine: the ids, the shape
    /// of the path, the argument array, the environment names, the adapter.
    ///
    /// Whether the program is *there* is deliberately absent — a state of the filesystem
    /// ([`AgentRegistration::program_state`]), not a property of a definition: a bundled sidecar
    /// not built yet and a user path that was deleted are the same fact, and neither means the
    /// registration is malformed.
    pub fn validate(&self) -> Result<(), RegistryError> {
        validate_id("agent_id", &self.agent_id)?;
        // A path that could never work is a definition error, and saying so at the form is the
        // difference between "fix this path" and "your file vanished".
        if self.program_state() == ProgramState::NotAbsolute {
            return Err(RegistryError::Program {
                program: self.program.clone(),
                state: ProgramState::NotAbsolute,
            });
        }
        validate_args(&self.args)?;
        for (name, value) in &self.env_extra {
            if !is_valid_environment_name(name) || value.contains('\0') {
                return Err(RegistryError::Environment { name: name.clone() });
            }
        }
        if self.adapter().is_none() {
            return Err(RegistryError::UnknownAdapter {
                adapter_id: self.adapter_id.clone(),
            });
        }
        Ok(())
    }

    /// The program's state, re-read from the filesystem on every call. `fs::metadata` follows
    /// symlinks, so a link to an executable is launchable — what a user with a wrapper under
    /// `~/bin` expects.
    pub fn program_state(&self) -> ProgramState {
        if !self.program.is_absolute() {
            return ProgramState::NotAbsolute;
        }
        let Ok(metadata) = fs::metadata(&self.program) else {
            return ProgramState::Missing;
        };
        if !metadata.is_file() {
            return ProgramState::NotAFile;
        }
        if !is_executable(&metadata) {
            return ProgramState::NotExecutable;
        }
        ProgramState::Launchable
    }

    /// The adapter that knows this engine's differences, if one answers to `adapter_id`.
    ///
    /// This is how §3.4's last line is kept: a caller asks for what it needs instead of
    /// comparing an id against a literal, so an engine's quirks stay in one file per engine
    /// and no component learns an engine's name.
    pub fn adapter(&self) -> Option<&'static dyn AgentAdapter> {
        adapters::lookup(&self.adapter_id)
    }

    /// What this engine advertises, from the adapter's declaration.
    ///
    /// Not a runtime answer: §3.4's capability row makes the install declaration a start-time hint,
    /// the handshake and session negotiation deciding what works — so `Advertised` describes the
    /// pinned version, never the session in front of the user, and a registration whose adapter id
    /// resolved to nothing answers [`Capability::Unverified`], the answer that offers nothing.
    pub fn declared_capability(&self, feature: HostFeature) -> Capability {
        self.adapter()
            .map_or(Capability::Unverified, |adapter| {
                adapter.declared_capability(feature)
            })
    }

    /// The launch description this registration produces (§3.4.3: the path and the arguments
    /// stay separate all the way to `execve`).
    ///
    /// Also what a diagnostic prints — `env_extra`'s values are the one part that must not be
    /// printed, and [`redacted_env`] is how a caller that has to show them does it.
    pub fn launch(&self, managed_root: &Path) -> EngineLaunch {
        let mut env = match self.env {
            EnvPolicy::ProfileIsolated => isolated_profile_env(managed_root),
            EnvPolicy::UserEnvironment => Vec::new(),
        };
        // The registration's own variables go last, so an explicit setting wins over the
        // policy's default root.
        env.extend(self.env_extra.iter().cloned());
        EngineLaunch {
            program: self.program.clone(),
            args: self.args.clone(),
            env,
            ca_bundle: None,
        }
    }
}

/// Refuses what `execve` cannot carry, which is the *whole* of argument validation:
/// §3.4.3 forbids concatenating a command line, and this crate keeps that promise
/// structurally rather than textually — no function here takes a command line, so an argument
/// containing spaces has no path through this module that could split it on them. What is left
/// to reject is the NUL byte, the one thing a C string cannot hold.
pub fn validate_args(args: &[String]) -> Result<(), RegistryError> {
    match args.iter().position(|arg| arg.contains('\0')) {
        Some(index) => Err(RegistryError::Argument { index }),
        None => Ok(()),
    }
}

/// Whether a variable can be handed to a process at all (ported from Zed's
/// `util::redact::is_valid_environment_name`).
fn is_valid_environment_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('=') && !name.chars().any(char::is_control)
}

/// Whether a value must never be printed — ported from Zed's `util::redact::should_redact`,
/// with the name upper-cased first: `ANTHROPIC_API_KEY` and `anthropic_api_key` are the same
/// variable to the kernel while only one is the conventional spelling, and under-redacting is
/// the dangerous direction (the cost is that a name like `MONKEY` is masked too).
fn is_credential_name(name: &str) -> bool {
    const SUFFIXES: [&str; 7] = [
        "KEY",
        "TOKEN",
        "PASSWORD",
        "SECRET",
        "PASS",
        "CREDENTIALS",
        "LICENSE",
    ];
    let upper = name.to_ascii_uppercase();
    SUFFIXES.iter().any(|suffix| upper.ends_with(suffix))
}

/// An environment with credential-bearing values replaced by `<redacted>`: the one form of
/// `env_extra` that may be printed.
///
/// By *name* here and by *value* in `process::redact` (which scrubs the engine's stderr of the
/// strings this host injected) — not redundant, since this side knows only what a variable is
/// called and that side only what was sent.
pub fn redacted_env(env: &[(String, String)]) -> Vec<(String, String)> {
    env.iter()
        .map(|(name, value)| {
            let value = if is_credential_name(name) {
                "<redacted>".to_string()
            } else {
                value.clone()
            };
            (name.clone(), value)
        })
        .collect()
}

/// Whether an id can be an identity and a path component.
///
/// §3.2's layout puts a profile id and a vault id into directory names
/// (`agent-profiles/<profile-id>/`), so the charset is the path-component charset: nothing that
/// could leave the managed root, nothing that would hide the directory, nothing a log line
/// would read as syntax.
fn validate_id(field: &'static str, value: &str) -> Result<(), RegistryError> {
    let usable = !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value != "."
        && value != ".."
        && !value.starts_with('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if usable {
        Ok(())
    } else {
        Err(RegistryError::Id {
            field,
            value: value.to_string(),
        })
    }
}

fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

/// The runtimes this registry has started and not yet seen end: (agent, profile, vault) -> the
/// epoch of the instance holding it. Shared with the instances themselves ([`AgentInstance`]),
/// because "am I still the live incarnation" is a question only this table can answer.
struct LiveInstances {
    counter: u64,
    live: BTreeMap<(String, String, String), String>,
}

impl LiveInstances {
    fn new() -> Self {
        Self {
            counter: 0,
            live: BTreeMap::new(),
        }
    }

    /// Mints an epoch for one (agent, profile, vault), or refuses.
    ///
    /// The triple is the unit of deduplication: §3.4 rules out one global engine standing in for
    /// every agent, and two engines on one profile would be two writers into one config and one
    /// session store. A different profile or vault is a different instance and is allowed — which
    /// is what makes "multiple agents" a boundary rather than a word in the plan.
    fn claim(
        &mut self,
        agent_id: &str,
        profile_id: &str,
        vault_id: &str,
    ) -> Result<String, RegistryError> {
        let key = (
            agent_id.to_string(),
            profile_id.to_string(),
            vault_id.to_string(),
        );
        // Claimed before the process exists, so two concurrent starts of the same runtime cannot
        // both spawn and only then discover each other.
        if let Some(epoch) = self.live.get(&key) {
            return Err(RegistryError::AlreadyRunning {
                agent_id: agent_id.to_string(),
                epoch: epoch.clone(),
            });
        }
        self.counter += 1;
        // The process id is what makes an epoch unique across *runs*: §6.1's composite identity
        // exists so a frame from a previous incarnation is recognizable as stale, and a name
        // restarting at one would hand the new process the names the old one's persisted
        // envelopes carry.
        let epoch = format!("epoch-{}-{}", std::process::id(), self.counter);
        self.live.insert(key, epoch.clone());
        Ok(epoch)
    }

    fn release(&mut self, epoch: &str) {
        self.live.retain(|_, held| held != epoch);
    }

    fn is_live(&self, epoch: &str) -> bool {
        self.live.values().any(|held| held == epoch)
    }

    /// The epoch of the instance running for `agent_id`, if there is one.
    fn epoch_of(&self, agent_id: &str) -> Option<String> {
        self.live
            .iter()
            .find(|((agent, _, _), _)| agent == agent_id)
            .map(|(_, epoch)| epoch.clone())
    }
}

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
        registry.profiles.insert(DEFAULT_PROFILE.to_string(), agent_id);
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
    /// [`EnvPolicy::UserEnvironment`] ignores it, because an external engine's profile is the
    /// user's own.
    pub async fn start(
        &self,
        agent_id: &str,
        profile_id: &str,
        vault_id: &str,
        managed_root: &Path,
        files: Arc<dyn VaultFiles>,
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
        let launch = registration.launch(managed_root);
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
        let (runtime, events) = AgentRuntime::new(identity.clone(), connection, events, files);
        Ok(AgentInstance {
            identity,
            adapter,
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

/// One running engine, as this host knows it. Dropping one tears its engine down — the epoch is
/// released *and* the engine is asked to exit — so an instance the Rust side no longer holds is
/// exactly the case where nobody else could stop it, and §6.2's rule is that this host cleans up
/// the processes it started, and only those.
///
/// The runtime inside is shared with the IPC layer, so the engine has two owners while a session
/// is live. That is why the teardown hangs off this type's [`Drop`] as well as off `shutdown`:
/// dropping the instance cannot rely on the last `Arc` going with it.
pub struct AgentInstance {
    identity: AgentIdentity,
    adapter: &'static dyn AgentAdapter,
    runtime: Arc<AgentRuntime>,
    /// The reading half, until the driver takes it. `None` afterwards — see
    /// [`AgentInstance::take_events`].
    events: Option<AgentRuntimeEvents>,
    live: Arc<Mutex<LiveInstances>>,
}

impl AgentInstance {
    /// The composite identity (§6.1) every envelope from this instance carries.
    pub fn identity(&self) -> &AgentIdentity {
        &self.identity
    }

    /// The asking half: every call that issues a request takes `&self`, so this is all a command
    /// needs, and it is a share rather than a borrow because the command runs on another task.
    pub fn runtime(&self) -> &Arc<AgentRuntime> {
        &self.runtime
    }

    /// The reading half, taken once, by whoever drives this runtime.
    ///
    /// `None` means it was taken already. Nothing hands it back, deliberately: two readers of one
    /// engine would each see half the stream — and the whole point of moving the receivers out of
    /// [`AgentRuntime`] is that the reading half has exactly one owner.
    pub fn take_events(&mut self) -> Option<AgentRuntimeEvents> {
        self.events.take()
    }

    /// The same half, borrowed rather than taken, for a caller that reads it in place and never
    /// hands the ownership on (a test, in practice). `None` means the driver has it.
    pub fn events_mut(&mut self) -> Option<&mut AgentRuntimeEvents> {
        self.events.as_mut()
    }

    /// What this engine advertises — and only while this instance is the live one.
    ///
    /// §3.4 requires capabilities to be re-detected after a reconnect or a version change rather than
    /// carried over, so a stopped instance answers [`Capability::Unverified`] instead of repeating what
    /// its process advertised: the answer that cannot put a button in front of a user for a feature
    /// nothing can serve.
    pub fn declared_capability(&self, feature: HostFeature) -> Capability {
        if !self.live.lock().unwrap().is_live(&self.identity.runtime_epoch) {
            return Capability::Unverified;
        }
        self.adapter.declared_capability(feature)
    }

    /// Stops this instance: the registration is free again, and the engine is asked to exit before
    /// it is signalled (§6.2's sequence, in `EngineConnection::shutdown`).
    pub fn shutdown(&self) {
        self.live
            .lock()
            .unwrap()
            .release(&self.identity.runtime_epoch);
        self.runtime.shutdown();
    }
}

impl Drop for AgentInstance {
    /// The same two steps as [`AgentInstance::shutdown`], because an instance the host has let go
    /// of must not leave a process behind: releasing the epoch alone would free the registration
    /// while the engine was still running, which is two engines for one (agent, profile, vault)
    /// the moment a start takes the freed slot. Both steps are idempotent — the epoch is a map
    /// entry, and the connection's stop senders are taken once.
    fn drop(&mut self) {
        self.shutdown();
    }
}
