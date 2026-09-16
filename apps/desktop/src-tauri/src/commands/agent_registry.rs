//! The registry's IPC surface: what engines this app knows, and the two changes a window may make.
//!
//! §6.1 draws this file's boundary as "validates and delegates": the definitions, their validation
//! and the live-instance table all belong to `agent_runtime::registry`, and what is here is the
//! renderer's half of it — the shape a settings page reads, and the two mutations §3.4.3 puts on
//! that page (add a local executable; switch a registration on or off). §3.4 keeps this apart from
//! `binary_registry`, which owns versions and paths: nothing here can download, promote or replace
//! a program, and the page that reads this surface has no such action to offer.
//!
//! **Two failure channels, and they are two types.** A *refusal* is a value that comes back from a
//! call that completed (`Ok(Some(…))`): the backend considered the request and said no, with the
//! facts — the path is not executable, the id is taken, the engine is still running. An `Err` is an
//! exception: the call did not complete at all (no engine on disk to build the registry from, a
//! start in flight, a poisoned lock). §10.2's T13a row asks for them apart because they send a user
//! to different places — "fix this path" versus "try again" — and collapsing them would put "the
//! engine refused this path" and "this page could not reach the backend" behind one sentence. The
//! service layer (`agent-registry-policy.ts`) renders a refusal; a rejected promise is the page's
//! own "the registry could not be read from the backend".
//!
//! **Registration is not a sandbox** (§3.4.4). What this surface checks is what `registry.rs`
//! checks: an id that can be an identity and a path component, an absolute program path, arguments
//! as an *array* with no NUL in them, and an adapter id this build answers to. It never checks that
//! the program is safe, and it never builds a command line — §3.4.3 keeps the path and the argument
//! array separate all the way to `execve`, and no function here takes a string that could be split
//! on spaces. Whether a file is *there* is deliberately not a registration rule: that is a state of
//! the filesystem (`programState`), re-read on every read, and a bundled sidecar that has not been
//! built yet is normal to report rather than a reason to refuse a form.
//!
//! **Nothing here can print a credential.** The readout carries `env_extra` through
//! `registry::redacted_env` — names always, values masked by name — and the page masks again on its
//! render path. Two locks, and the cheap one is here.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::agent_runtime::adapters;
use crate::agent_runtime::events::AgentFailureCode;
use crate::agent_runtime::registry::{
    self, AgentRegistration, AgentRegistry, EnvPolicy, InstallSource, RegistryError,
};
use crate::state::{edit_registry, registry_of, AgentRuntimeState};

/// What an add form sends: §3.4.3's 「添加本地可执行文件、启动参数」, field for field.
///
/// Three things a registration has that this deliberately does not: `source`, `env` and `enabled`.
/// A draft cannot claim the host manages a program (`External` is the only source a form can
/// produce), cannot choose an environment policy (a program the user installed keeps its own
/// credentials, §3.1), and cannot arrive switched off (§3.4.1's 安装并启用 is one intention). Those
/// are decisions this layer makes, in [`registration_from`], so no request can ask for a state the
/// plan does not describe.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDraft {
    pub agent_id: String,
    pub display_name: String,
    pub program: String,
    /// The arguments, as an array, in order. A space inside one belongs to it: §3.4.3 forbids
    /// concatenating a command line, and there is no field here that could hold one.
    pub args: Vec<String>,
    pub adapter_id: String,
}

/// One environment variable as a settings row draws it: the name, and the masked value.
#[derive(Debug, Clone, Serialize)]
pub struct EnvVarView {
    pub name: String,
    pub value: String,
}

/// One registration, as the settings list reads it — §3.4's registration row, field for field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub agent_id: String,
    pub display_name: String,
    /// `bundled` / `managed` / `external`. Provenance decides two things the page surfaces: who may
    /// replace the program (`InstallSource::update_policy`) and what the environment is built from.
    pub source: &'static str,
    pub program: String,
    pub args: Vec<String>,
    pub env: &'static str,
    /// The registration's own variables, values masked.
    pub env_extra: Vec<EnvVarView>,
    pub enabled: bool,
    pub adapter_id: String,
    /// As the last diagnostic reported it. Reported, and nothing else: nothing on this surface
    /// turns it into a download, a swap or an "update available" that acts (§3.4.6).
    pub reported_version: Option<String>,
    /// A fact about the filesystem, re-read now — not a property of the definition, which is why it
    /// is one of five answers rather than a flag.
    pub program_state: &'static str,
}

/// Everything the registry page reads, in one answer.
///
/// One call rather than five, because the page draws all of it together: which engines exist, which
/// adapters a form may name, which rows have a running engine, and which engine owns the profile a
/// new session would use. A second call would be a second stale read of the same registry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryReadout {
    /// §3.4.1: the fixed engine a new session starts on. Not a preference, so there is no setter.
    pub default_agent_id: String,
    pub entries: Vec<RegistryEntry>,
    /// The adapter ids this build answers to (`adapters::all`), so the form offers the ones that
    /// exist instead of a list maintained on the page.
    pub adapter_ids: Vec<&'static str>,
    /// The agents with a live engine. The page uses it to avoid offering a switch-off that can only
    /// be refused (§3.4.7); the backend refuses it anyway, with the same fact.
    pub running_agent_ids: Vec<String>,
    /// Which agent each profile belongs to (§3.4's Profile row).
    pub profile_owners: BTreeMap<String, String>,
}

/// Why a change was refused — `registry.rs`'s vocabulary, in the shape the page maps.
///
/// Data only, exactly as the Rust error is: the sentence a user reads belongs to the page's copy
/// tree, keyed by `kind`. Two arms deliberately drop a fact their Rust counterpart carries:
/// `already-running` and `instance-running` carry no epoch, because an epoch is this host's
/// incarnation token (§6.1) and the row identifies the engine by id — a page that printed one would
/// be showing a value nothing on screen can act on.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RegistryRefusal {
    Id {
        field: &'static str,
        value: String,
    },
    /// The path problem, named `path` rather than `program` on the wire: the field a form points at
    /// is the one the user typed a path into.
    Program {
        path: String,
        state: &'static str,
    },
    Argument {
        index: usize,
    },
    Environment {
        name: String,
    },
    UnknownAdapter {
        adapter_id: String,
    },
    DuplicateAgent {
        agent_id: String,
    },
    UnknownAgent {
        agent_id: String,
    },
    ProfileUnbound {
        profile_id: String,
        agent_id: String,
        owner: Option<String>,
    },
    Disabled {
        agent_id: String,
    },
    AlreadyRunning {
        agent_id: String,
    },
    InstanceRunning {
        agent_id: String,
    },
    IsDefault {
        agent_id: String,
    },
    /// A refused start. Not reachable from the two mutations on this surface — they never spawn
    /// anything — and carried anyway: this enum is the whole vocabulary of `RegistryError`, the
    /// page's copy tree has one sentence per arm, and a mapper that covered only the arms of today
    /// would be the place a later caller's refusal reached the page as a blank row.
    LaunchFailed {
        agent_id: String,
        code: AgentFailureCode,
        message: String,
    },
}

/// The registry as the page reads it.
pub fn read_registry(registry: &AgentRegistry) -> RegistryReadout {
    RegistryReadout {
        default_agent_id: registry.default_agent_id().to_string(),
        entries: registry.registrations().map(entry_view).collect(),
        adapter_ids: adapters::all()
            .into_iter()
            .map(|adapter| adapter.id())
            .collect(),
        running_agent_ids: registry.running_agent_ids(),
        profile_owners: registry.profile_owners(),
    }
}

/// Adds a definition, or answers why it was refused.
pub fn add_agent(registry: &mut AgentRegistry, draft: AgentDraft) -> Option<RegistryRefusal> {
    match registry.register(registration_from(draft)) {
        Ok(()) => None,
        Err(error) => Some(refusal_view(error)),
    }
}

/// Switches a registration on or off, or answers why it was refused.
pub fn set_enabled(
    registry: &mut AgentRegistry,
    agent_id: &str,
    enabled: bool,
) -> Option<RegistryRefusal> {
    match registry.set_enabled(agent_id, enabled) {
        Ok(()) => None,
        Err(error) => Some(refusal_view(error)),
    }
}

/// The definition an add form becomes — §3.4's registration row with the three fields a form may
/// not choose filled in.
///
/// `External`, because the program is the user's own: §3.4.6 makes a host-managed policy something
/// only this app's own packaging may claim, and a draft with no `source` field cannot ask for one.
/// `UserEnvironment`, because an installation the user made keeps its own credentials (§3.1) — the
/// app's profile roots are for engines it installed itself. `enabled`, because adding an engine is
/// 「安装并启用」 in one act (§3.4.1), and the switch that turns it off is on the row it just
/// created.
fn registration_from(draft: AgentDraft) -> AgentRegistration {
    AgentRegistration {
        agent_id: draft.agent_id,
        display_name: draft.display_name,
        source: InstallSource::External,
        program: draft.program.into(),
        args: draft.args,
        env: EnvPolicy::UserEnvironment,
        // A form on this surface cannot set variables (§3.4.5 keeps an engine's environment with the
        // engine and its own tooling), so an added registration has none. The *display* half still
        // holds for entries that carry them: `redacted_env` masks them on the way out.
        env_extra: Vec::new(),
        enabled: true,
        adapter_id: draft.adapter_id,
        reported_version: None,
    }
}

/// The readout's row for one definition.
fn entry_view(registration: &AgentRegistration) -> RegistryEntry {
    RegistryEntry {
        agent_id: registration.agent_id.clone(),
        display_name: registration.display_name.clone(),
        source: registration.source.id(),
        program: registration.program.to_string_lossy().into_owned(),
        args: registration.args.clone(),
        env: registration.env.id(),
        env_extra: registry::redacted_env(&registration.env_extra)
            .into_iter()
            .map(|(name, value)| EnvVarView { name, value })
            .collect(),
        enabled: registration.enabled,
        adapter_id: registration.adapter_id.clone(),
        reported_version: registration.reported_version.clone(),
        program_state: registration.program_state().id(),
    }
}

/// `RegistryError` as the page's vocabulary.
///
/// Total over the error, so an arm added to `registry.rs` is a compile error here rather than a
/// refusal that reaches the page with nothing to say about it. Public for that totality's sake: the
/// page's copy tree has one sentence per arm, and a mapping testable only through the two mutations
/// on this surface could not check the arms they cannot produce — which is the shape a renamed
/// field keeps looking right in.
pub fn refusal_view(error: RegistryError) -> RegistryRefusal {
    match error {
        RegistryError::Id { field, value } => RegistryRefusal::Id { field, value },
        RegistryError::Program { program, state } => RegistryRefusal::Program {
            path: program.to_string_lossy().into_owned(),
            state: state.id(),
        },
        RegistryError::Argument { index } => RegistryRefusal::Argument { index },
        RegistryError::Environment { name } => RegistryRefusal::Environment { name },
        RegistryError::UnknownAdapter { adapter_id } => {
            RegistryRefusal::UnknownAdapter { adapter_id }
        }
        RegistryError::DuplicateAgent { agent_id } => RegistryRefusal::DuplicateAgent { agent_id },
        RegistryError::UnknownAgent { agent_id } => RegistryRefusal::UnknownAgent { agent_id },
        RegistryError::ProfileUnbound {
            profile_id,
            agent_id,
            owner,
        } => RegistryRefusal::ProfileUnbound {
            profile_id,
            agent_id,
            owner,
        },
        RegistryError::Disabled { agent_id } => RegistryRefusal::Disabled { agent_id },
        // The epoch is dropped here, by name, so the wire shape is a decision rather than an
        // accident of the Rust type.
        RegistryError::AlreadyRunning { agent_id, .. } => {
            RegistryRefusal::AlreadyRunning { agent_id }
        }
        RegistryError::InstanceRunning { agent_id, .. } => {
            RegistryRefusal::InstanceRunning { agent_id }
        }
        RegistryError::IsDefault { agent_id } => RegistryRefusal::IsDefault { agent_id },
        RegistryError::LaunchFailed { agent_id, error } => RegistryRefusal::LaunchFailed {
            agent_id,
            code: error.failure_code(),
            // The engine's own words, passed through: `TransportError::failure_message` already
            // rewords the certificate case (P0 §2.4 requires it), and this layer must not invent a
            // second wording for a failure it did not classify.
            message: error.failure_message(),
        },
    }
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// The definitions, the adapter ids and the live-instance table, in one answer.
#[tauri::command]
pub fn agent_registry_read(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeState>,
) -> Result<RegistryReadout, String> {
    let managed = managed_dir(&app)?;
    let registry = registry_of(&runtime, &managed)?;
    Ok(read_registry(&registry))
}
/// Adds a local executable as an engine.
///
/// `Ok(None)` is an accepted registration, `Ok(Some(refusal))` is the backend saying no with the
/// facts, and `Err` is this call not completing — the three outcomes a page must be able to tell
/// apart.
#[tauri::command]
pub fn agent_registry_add(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeState>,
    draft: AgentDraft,
) -> Result<Option<RegistryRefusal>, String> {
    let managed = managed_dir(&app)?;
    edit_registry(&runtime, &managed, |registry| add_agent(registry, draft))
}

/// Switches a registration on or off. Same three outcomes as [`agent_registry_add`].
#[tauri::command]
pub fn agent_registry_set_enabled(
    app: AppHandle,
    runtime: State<'_, AgentRuntimeState>,
    agent_id: String,
    enabled: bool,
) -> Result<Option<RegistryRefusal>, String> {
    let managed = managed_dir(&app)?;
    edit_registry(&runtime, &managed, |registry| {
        set_enabled(registry, &agent_id, enabled)
    })
}

/// Where this app's own files live (§3.2). Resolved here rather than kept in the state, for the
/// reason `setup` resolves it: the data directory is Tauri's answer, and the registry's lazy build
/// is the only thing that needs it on this surface.
fn managed_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::storage::key_store::data_dir(app)
}
