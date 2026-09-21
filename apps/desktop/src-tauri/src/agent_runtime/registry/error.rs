//! The refusal vocabulary: why a registration, a start or a mutation was refused.
//!
//! A module of its own rather than a section of [`super`], and the split is by what makes each part
//! change. This file moves when the *set of reasons* to refuse something moves — a refusal a
//! settings form has to render, or a variant that has to carry one more fact for the frontend's
//! sentence. It decides nothing: the checks that produce a refusal are enforced where they belong
//! ([`super::validation`], [`super::registration`], [`super::table`]), so a change to *when*
//! something is refused does not touch what a refusal is.

use std::path::PathBuf;

use super::super::events::TransportError;
use super::taxonomy::ProgramState;

/// Why a registration, a start or a mutation was refused. Data only: the wording a user
/// reads belongs to the frontend (T13a's form, the settings list), and this is what it maps.
#[derive(Debug, Clone)]
pub enum RegistryError {
    /// An id that cannot be an identity or a path component: §3.2 puts profile and vault
    /// ids into directory names, so a `/` or a `..` here is a path traversal dressed as
    /// configuration.
    Id {
        field: &'static str,
        value: String,
    },
    /// The program path failed — kept apart from [`RegistryError::Argument`] because §3.4.3
    /// has the user supply a path *and* an argument list, and a diagnostic that cannot say
    /// which is wrong sends them to fix the wrong one.
    Program {
        program: PathBuf,
        state: ProgramState,
    },
    /// One argument is unusable, by its position in the array.
    Argument {
        index: usize,
    },
    /// A variable that cannot reach a process: an empty name, an `=` or a control character
    /// in the name, or a NUL in the value (`execve` takes NUL-terminated strings).
    Environment {
        name: String,
    },
    /// No verified adapter answers to that id, so the engine's differences have no owner.
    UnknownAdapter {
        adapter_id: String,
    },
    /// Already registered: replacing a definition while an instance may run on it is not an
    /// edit, it is a race.
    DuplicateAgent {
        agent_id: String,
    },
    UnknownAgent {
        agent_id: String,
    },
    /// The profile does not belong to this agent (`owner` is the agent it does belong to, if
    /// any). §3.4's Profile row forbids copying a profile between engines, which is what stops
    /// an external engine from being handed OpenCode's credentials.
    ProfileUnbound {
        profile_id: String,
        agent_id: String,
        owner: Option<String>,
    },
    /// The registration is switched off (§3.4.3's enable/disable column).
    Disabled {
        agent_id: String,
    },
    /// A runtime for this (agent, profile, vault) is already live. §3.4 forbids one global
    /// engine standing in for every agent, and two engines on one profile are two writers
    /// into one config and one session store.
    AlreadyRunning {
        agent_id: String,
        epoch: String,
    },
    /// §3.4.7: an active task is stopped before the registration it belongs to is switched
    /// off or removed.
    InstanceRunning {
        agent_id: String,
        epoch: String,
    },
    /// The default agent is the plan's fixed answer for a new session (§3.4.1). Removing or
    /// disabling it would leave the new-session menu with nothing to preselect and
    /// [`AgentRegistry::default_agent_id`](super::AgentRegistry::default_agent_id) naming an agent that is not registered, so the
    /// registry refuses to create that state instead of leaving it to a frontend to avoid.
    IsDefault {
        agent_id: String,
    },
    /// The engine could not be started, carrying the transport's own classification rather
    /// than a flattened string so a missing binary and a refused handshake stay
    /// distinguishable at the IPC boundary.
    LaunchFailed {
        agent_id: String,
        error: TransportError,
    },
}

impl RegistryError {
    pub(super) fn unknown(agent_id: &str) -> Self {
        RegistryError::UnknownAgent {
            agent_id: agent_id.to_string(),
        }
    }

    pub(super) fn unbound(profile_id: &str, agent_id: &str, owner: Option<&String>) -> Self {
        RegistryError::ProfileUnbound {
            profile_id: profile_id.to_string(),
            agent_id: agent_id.to_string(),
            owner: owner.cloned(),
        }
    }
}
