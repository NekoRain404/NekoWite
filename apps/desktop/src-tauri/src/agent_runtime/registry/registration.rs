//! One registration: §3.4's first row, field for field, with the rules that judge a draft and the
//! launch description it produces.
//!
//! A module of its own rather than a section of [`super`], and the split is by what makes each part
//! change. This file moves when *what a definition is* moves: a field §3.4's row gains, the
//! redaction its `Debug` owes §2.1's 「环境变量日志脱敏」, the checks that decide a draft is
//! acceptable, or the way a definition becomes a launch (§3.4.3's array, P0 §3's environment
//! channel). The registry that holds definitions ([`super::table`]) and the refusals a bad one
//! produces ([`super::error`]) answer different questions and change for their own reasons.

use std::fs;
use std::path::{Path, PathBuf};

use super::super::adapters::{self, AgentAdapter, Capability, HostFeature};
use super::super::process::{env_pairs, isolated_profile_env, EngineLaunch};
use super::super::profile::Credentials;
use super::super::secret::Secret;
use super::error::RegistryError;
use super::taxonomy::{EnvPolicy, InstallSource, ProgramState};
use super::validation::{
    is_executable, is_valid_environment_name, redacted_env, validate_args, validate_id,
};

/// One agent definition — §3.4's first row, field for field. Public fields, because this is
/// the shape the settings layer reads and writes; the rules live in
/// [`AgentRegistration::validate`], applied on the way in and again at
/// [`AgentRegistry::start`](super::AgentRegistry::start), since a definition can be edited at any moment and the machine
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
        self.adapter().map_or(Capability::Unverified, |adapter| {
            adapter.declared_capability(feature)
        })
    }

    /// The launch description this registration produces (§3.4.3: the path and the arguments
    /// stay separate all the way to `execve`).
    ///
    /// `credentials` is the profile's set — §3.4's Profile row makes the profile the place an
    /// engine's authorization lives, and the caller has already established that this profile
    /// belongs to this agent ([`AgentRegistry::start`](super::AgentRegistry::start) is the caller, and it refuses the pair
    /// otherwise), which is what makes injecting them *this* engine's credentials rather than a
    /// copy between engines.
    ///
    /// **The order of the three groups is the guarantee, and it used to be wrong.** A credential
    /// went last, so the value a user typed for this profile beat everything — including the roots
    /// the host isolates the engine into. `environment.rs` records as *measured* that a mis-set
    /// `OPENCODE_CONFIG_DIR` stops this app's shipped permission block from being applied: the
    /// consent gate, turned off from a text field the renderer can write (finding S5 in
    /// `docs/audits/2026-09-21-code-review.md`). The order is now:
    ///
    /// 1. the definition's own variables (`env_extra`),
    /// 2. the profile's credentials — the intent the old order was for, and it still holds: the
    ///    definition is shared by every profile of one agent, and the profile is not,
    /// 3. the isolation roots, applied **last**, so nothing reachable from the credentials surface
    ///    can move the engine's `HOME`, its `XDG_*` roots or the names in its own namespace.
    ///
    /// Step 3 is the half that does not depend on knowing every name; `credentials::reserved_name`
    /// is the half that refuses the ones that are not about the engine's identity at all, and it is
    /// where the user is told why.
    ///
    /// Also what a diagnostic prints — and now that is safe: every value is a [`Secret`], so this
    /// struct's derived `Debug` prints names and `<redacted>`, while a caller that has to show a
    /// variable's value does it through [`redacted_env`].
    pub fn launch(&self, managed_root: &Path, credentials: &Credentials) -> EngineLaunch {
        let mut env: Vec<(String, Secret)> = env_pairs(self.env_extra.iter().cloned());
        env.extend(credentials.launch_pairs());
        if let EnvPolicy::ProfileIsolated = self.env {
            env.extend(env_pairs(isolated_profile_env(managed_root)));
        }
        EngineLaunch {
            program: self.program.clone(),
            args: self.args.clone(),
            env,
            ca_bundle: None,
        }
    }
}
