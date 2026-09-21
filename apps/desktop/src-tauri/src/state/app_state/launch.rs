//! Where the program to launch comes from, and the sentences a refusal is written in.
//!
//! A module of its own because these two change for reasons of their own: which program is launched
//! moves with §3.2's managed layout and §3.3's promoted release, and the refusal text moves with
//! what the surface reading it needs to say. Neither knows how a session is composed.

use std::path::{Path, PathBuf};

use crate::agent_runtime::binary_registry::{self, BinaryRegistry};
use crate::agent_runtime::profile::ProfileError;
use crate::agent_runtime::registry::RegistryError;

/// The directory of the running executable, which is where a bundled engine sits
/// (§3.2). Empty when the platform will not say, which makes the lookup fail with
/// the sentence [`program_to_launch`] writes rather than with a guess.
/// `pub(super)` rather than private because the resolution moved to a sibling: the two build paths
/// in [`super::registry_access`] are its only callers, and `super` is the narrowest scope that
/// holds both of them.
pub(super) fn executable_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

/// The program this host launches, from the two places §3.2 allows.
///
/// A promoted release wins when the pointer names a launchable one — that is
/// what §3.3's update path is for — and anything else falls back to the sidecar
/// shipped beside the executable, which §3.1.1 makes this app's verified base.
/// A pointer that cannot be read is reported and *not* a refusal: the bundled
/// engine is what a start would have used anyway, and refusing to start over a
/// diagnostic would turn a settings-page symptom into a dead session.
///
/// Nothing is searched for on `PATH`: the engine this app runs is the one it
/// ships or installed itself, never one it found.
///
/// `beside` is the directory of the running executable, passed in rather than
/// derived so that the resolution can be exercised without an app bundle.
pub fn program_to_launch(managed: &Path, beside: &Path) -> Result<PathBuf, String> {
    let layout = BinaryRegistry::new(managed).map_err(|error| format!("{error:?}"))?;
    match layout.active_program() {
        Ok(Some(program)) => return Ok(program.path),
        Ok(None) => {}
        Err(error) => eprintln!("nekowite: could not read the agent release pointer: {error:?}"),
    }
    binary_registry::bundled_program(beside)
        .map(|program| program.path)
        .ok_or_else(|| {
            format!(
                "the bundled engine was not found beside {}. It is installed with the app, so \
                 this points at a build or a package that did not carry it.",
                beside.display()
            )
        })
}

/// Why a start was refused, in the words of the thing that refused it.
/// `pub(super)` rather than private because the reader is a sibling: the start path in
/// [`super::agent`] is the one place a start failure becomes a sentence, and `super` is the
/// narrowest scope that holds both ends of that.
pub(super) fn start_refusal(error: &RegistryError) -> String {
    match error {
        RegistryError::Program { program, state } => {
            format!(
                "the agent's program is not launchable: {} ({state:?})",
                program.display()
            )
        }
        RegistryError::Disabled { agent_id } => {
            format!("the agent {agent_id} is switched off in settings")
        }
        RegistryError::ProfileUnbound {
            profile_id,
            agent_id,
            owner,
        } => match owner {
            Some(owner) => {
                format!("the profile {profile_id} belongs to {owner}, not to {agent_id}")
            }
            None => format!("no profile {profile_id} is bound to {agent_id}"),
        },
        RegistryError::AlreadyRunning { agent_id, epoch } => {
            format!("an engine for {agent_id} is already running in this vault ({epoch})")
        }
        RegistryError::LaunchFailed { agent_id, error } => {
            format!(
                "{agent_id} could not be started: {}",
                error.failure_message()
            )
        }
        RegistryError::UnknownAgent { agent_id } => format!("no agent named {agent_id}"),
        RegistryError::Id { field, value } => {
            format!("{value} cannot be used as {field}: it is not a name this app accepts")
        }
        RegistryError::Argument { index } => {
            format!("argument {index} of the agent's command line cannot be passed to a process")
        }
        RegistryError::Environment { name } => {
            format!("the environment variable {name} cannot be passed to a process")
        }
        RegistryError::UnknownAdapter { adapter_id } => {
            format!("no verified adapter for the engine {adapter_id}")
        }
        RegistryError::DuplicateAgent { agent_id } => format!("{agent_id} is registered twice"),
        RegistryError::InstanceRunning { agent_id, epoch } => {
            format!("{agent_id} still has a running engine ({epoch})")
        }
        RegistryError::IsDefault { agent_id } => {
            format!("{agent_id} is the default agent and cannot be removed")
        }
    }
}

/// Why the profile could not be opened.
/// `pub(super)` for the same reason [`start_refusal`] is: the start path in [`super::agent`] is
/// the one reader, and `super` is the narrowest scope that holds both.
pub(super) fn profile_refusal(error: &ProfileError) -> String {
    match error {
        ProfileError::AgentMismatch {
            profile_id, bound, ..
        } => format!("the profile {profile_id} was created for {bound}, not for this agent"),
        ProfileError::Unreadable { path, message } => {
            format!(
                "the profile record {} cannot be read: {message}",
                path.display()
            )
        }
        ProfileError::ReadOnly => {
            "this profile follows the user's own configuration and is not written by the app"
                .to_string()
        }
        other => format!("the agent profile could not be opened: {other:?}"),
    }
}
