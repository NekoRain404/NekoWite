//! OpenCode: the engine this app ships and starts by default.
//!
//! Every fact in this file is about one pinned engine version, and each one
//! names where it was measured. §3.4 forbids the rest of the app from branching
//! on the name `opencode`; this file is the one place where the name is allowed
//! to appear, together with `generic_acp.rs`, and a caller that needs to know
//! something asks through [`AgentAdapter`] instead.

use std::path::PathBuf;

use super::super::registry::{AgentRegistration, EnvPolicy, InstallSource};
use super::{AgentAdapter, Capability, ConfigAuthoring, HostFeature};

/// The adapter id a registration names to reach this file.
pub const ADAPTER_ID: &str = "opencode";

/// The identity of the bundled engine.
///
/// A different namespace from [`ADAPTER_ID`] even though the two strings
/// coincide for the bundled engine: an agent id is an identity that travels in
/// every envelope (§6.2), while an adapter id names code. They will come apart
/// the moment a second engine gets a verified adapter, or a user registers a
/// *different* engine under an id of their own.
pub const AGENT_ID: &str = "opencode";

/// What the user sees before they rename it.
pub const DISPLAY_NAME: &str = "OpenCode";

/// The invocation that puts this engine into ACP mode (§3.1: Rust starts
/// `opencode acp` on demand).
///
/// Only a verified adapter knows this. A generic ACP engine is started with
/// whatever its own installation needs, so its arguments are typed in by the
/// user rather than looked up — which is exactly the difference this constant
/// records.
pub const LAUNCH_ARGS: [&str; 1] = ["acp"];

/// The configuration format this adapter owns (§3.4.5).
///
/// Named rather than implied: an engine with no verified adapter must not have
/// its configuration written in this format, and the only way to state that in
/// code is for the format to have a name that a caller has to produce.
pub const CONFIG_FORMAT: &str = "opencode-jsonc";

/// The session config option that selects the model.
///
/// Measured in P0 §2.3, which switched models mid-session through an option with
/// this id. It is a *hint* for a UI that must say something before the engine's
/// own list arrives: the authoritative list comes back with `session/new` and
/// again with every `session/set_config_option`, and §6.3 is explicit that the
/// option ids are the engine's to define.
pub const MODEL_OPTION_ID: &str = "model";

pub struct OpenCode;

pub static OPENCODE: OpenCode = OpenCode;

impl AgentAdapter for OpenCode {
    fn id(&self) -> &'static str {
        ADAPTER_ID
    }

    /// The claims below are read off P0's measurements of the pinned artifact.
    /// The handshake ones are the response the fixture carries verbatim (P0
    /// §2.1, `tests/fixtures/agent/fake_agent.sh`); the rest name their own
    /// section. The match is exhaustive on purpose: adding a feature to
    /// [`HostFeature`] fails to compile until someone decides what this engine
    /// does about it, which is the only reliable way to keep a capability list
    /// from silently defaulting to "yes".
    fn declared_capability(&self, feature: HostFeature) -> Capability {
        match feature {
            // `agentCapabilities.loadSession` and `sessionCapabilities.resume`,
            // both advertised in the measured handshake.
            HostFeature::SessionResume => Capability::Advertised,
            // `available_commands_update`, measured arriving unasked on
            // `session/new` (P0 §2.2).
            HostFeature::SlashCommands => Capability::Advertised,
            // P0 §2.3: switching by option id works mid-session.
            HostFeature::ModelSelection => Capability::Advertised,
            // `promptCapabilities.image`, advertised in the measured handshake.
            HostFeature::ImageAttachments => Capability::Advertised,
            // `configOptions` measured in the `session/new` response.
            HostFeature::SessionConfigOptions => Capability::Advertised,
            // The same handshake advertises `promptCapabilities` with
            // `embeddedContext` and `image` — and no `audio`. §3.4.6 asks for the
            // specific limitation, so this is the state that renders one instead
            // of offering an attachment the engine will refuse.
            HostFeature::AudioAttachments => Capability::NotAdvertised,
        }
    }

    fn config_authoring(&self) -> ConfigAuthoring {
        ConfigAuthoring::Verified {
            format: CONFIG_FORMAT,
        }
    }

    fn model_option_id(&self) -> Option<&'static str> {
        Some(MODEL_OPTION_ID)
    }
}

/// The bundled default registration (§3.4.1: OpenCode is bundled, and a new
/// session starts on it).
///
/// `program` is the packaged sidecar's path, resolved by whoever knows where the
/// app's resources are (§3.2) — this function does not look for it, does not
/// guess a development path, and does not care whether the file is there yet.
/// That last part is deliberate: a bundled artifact that has not been built is a
/// state the settings page should report, not a reason for the registry to exist
/// without its default.
pub fn bundled_registration(program: PathBuf) -> AgentRegistration {
    AgentRegistration {
        agent_id: AGENT_ID.to_string(),
        display_name: DISPLAY_NAME.to_string(),
        source: InstallSource::Bundled,
        program,
        args: LAUNCH_ARGS.iter().map(|arg| arg.to_string()).collect(),
        env: EnvPolicy::ProfileIsolated,
        env_extra: Vec::new(),
        enabled: true,
        adapter_id: ADAPTER_ID.to_string(),
        reported_version: None,
    }
}
