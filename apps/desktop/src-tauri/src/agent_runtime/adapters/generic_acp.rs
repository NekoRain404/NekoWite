//! Any other ACP engine: the path for an engine this app has not verified.
//!
//! The file is short, and what it *refuses* to do is the whole of its content.
//! §3.4.5: where no verified adapter exists, NekoWite offers the engine's path,
//! a diagnostic and an entry point into the engine's own configuration, and
//! writes nothing on its behalf. §2.2 adds the reason that is easy to get wrong:
//! the capability fallback must not be simplified into "OpenCode supports it, so
//! an ACP agent does".
//!
//! Not knowing is a state this module can express, and it is the correct
//! behaviour. Every method below answers with the state that offers nothing,
//! because the alternative — borrowing another engine's answers — is a claim
//! about a program nobody here has run.

use super::{AgentAdapter, Capability, ConfigAuthoring, HostFeature};

/// The adapter id a registration names to reach this file.
pub const ADAPTER_ID: &str = "generic-acp";

pub struct GenericAcp;

pub static GENERIC_ACP: GenericAcp = GenericAcp;

impl AgentAdapter for GenericAcp {
    fn id(&self) -> &'static str {
        ADAPTER_ID
    }

    /// Nothing is advertised, for every feature, and no feature is special-cased.
    ///
    /// This is not a placeholder waiting to be filled in: an engine registered
    /// here has not had its handshake, its session negotiation or its limits
    /// measured, and §3.4's capability row says the run-time answer comes from
    /// that negotiation — not from this declaration. `Unverified` is the only
    /// answer that neither offers a button nothing can serve nor claims a
    /// limitation nobody observed.
    fn declared_capability(&self, _: HostFeature) -> Capability {
        Capability::Unverified
    }

    /// Refuses to write configuration.
    ///
    /// §3.4.5's rule is that an unknown engine's configuration must not be
    /// written in OpenCode's format, and the way this file keeps it is that
    /// there is no format here to write: [`ConfigAuthoring::NativeOnly`] carries
    /// no name, so a caller cannot ask this adapter for a document to produce.
    /// What the host offers instead is the pair §3.4.5 lists — the path and the
    /// diagnostic — plus a way into the engine's own configuration tooling,
    /// which is the engine's business and not this app's.
    fn config_authoring(&self) -> ConfigAuthoring {
        ConfigAuthoring::NativeOnly
    }

    /// Refuses to guess which session config option selects a model.
    ///
    /// §6.3 gives option ids to the engine. OpenCode's happens to be `model`
    /// (see `opencode.rs`), and copying that fact here would be exactly the
    /// engine-specific assumption §3.4 forbids: an engine that names it
    /// `modelId`, or has no such option at all, would be handed a value the
    /// engine never offered.
    fn model_option_id(&self) -> Option<&'static str> {
        None
    }
}
