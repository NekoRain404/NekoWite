//! The two engines this app knows, and the seam that keeps their differences out
//! of everything else.
//!
//! §3.4's last line is a rule about the shape of the code: components must not
//! branch on an agent id, they consume capabilities and structured state, and
//! each engine's quirks live in exactly one named file. This module is that seam
//! — the lookup that turns a registration's `adapter_id` into behaviour, and the
//! trait that behaviour implements. The spoken vocabulary lives here too, because
//! a caller asking "what can this engine do" must not have to know an engine's
//! name to ask it.

pub mod generic_acp;
pub mod opencode;

/// One engine's differences.
///
/// Deliberately small: a method belongs here only when a caller must *ask the
/// engine something* rather than compare its id. Every answer must be measured —
/// against the pinned version's handshake, a session negotiation, or a
/// limitation someone wrote down — because §3.4 requires a specific limitation
/// to be shown where one exists, and forbids advertising "follows ACP" as
/// "supports the same things".
pub trait AgentAdapter: Sync {
    /// The id a registration names. Stable: registrations store it.
    fn id(&self) -> &'static str;

    /// What this engine advertises about `feature`.
    fn declared_capability(&self, feature: HostFeature) -> Capability;

    /// Which configuration format this adapter may write, if any.
    fn config_authoring(&self) -> ConfigAuthoring;

    /// The session config option that selects a model, when the engine has one.
    fn model_option_id(&self) -> Option<&'static str>;
}

/// A capability the host may have to gate on.
///
/// This is §3.4.6's list — the things an ACP engine may or may not provide, and
/// which the host must therefore show as a *specific limitation* rather than
/// assume. It is not a feature wishlist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostFeature {
    /// Continuing a session the engine still has (§6.2).
    SessionResume,
    /// An engine-provided command list for `/` (§4.1).
    SlashCommands,
    /// Choosing a model inside or before a session (§4.2).
    ModelSelection,
    /// Image attachments in a prompt (the handshake's `promptCapabilities`).
    ImageAttachments,
    /// Audio attachments. The pinned OpenCode does not advertise this one, which
    /// is why it is here: a list where every answer is "yes" cannot express the
    /// degradation this host has to render.
    AudioAttachments,
    /// The engine's own session config options (§6.3: the option ids are the
    /// engine's, and a host that assumes they exist invents them).
    SessionConfigOptions,
}

impl HostFeature {
    /// Every feature, so a caller can render a complete limitation list instead
    /// of the ones it happened to remember.
    pub const ALL: [HostFeature; 6] = [
        HostFeature::SessionResume,
        HostFeature::SlashCommands,
        HostFeature::ModelSelection,
        HostFeature::ImageAttachments,
        HostFeature::AudioAttachments,
        HostFeature::SessionConfigOptions,
    ];
}

/// What an adapter declares about a feature.
///
/// The names carry the point: this is a *declaration*, and §3.4's capability row
/// says the install declaration is only a start-time hint — the handshake and
/// the session negotiation decide what works, and both are re-read after a
/// reconnect. Nothing here may be renamed into "supported now", and the third
/// state exists so that "we have not measured this engine" cannot be mistaken
/// for either of the other two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    /// The pinned engine version advertises this (see each adapter's source).
    Advertised,
    /// The pinned engine version is known *not* to advertise this. §3.4.6: show
    /// the specific limitation, do not offer the button.
    NotAdvertised,
    /// Nothing is known. The answer for an engine with no verified adapter, and
    /// the answer for an instance that has stopped — it cannot offer a feature
    /// that nothing is left to serve.
    Unverified,
}

/// Which engine's configuration format an adapter is allowed to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigAuthoring {
    /// A verified adapter, which owns one named format. Naming it is the point:
    /// two engines' configuration files are different documents even when both
    /// are JSON, and a caller that writes one must be able to say which it wrote.
    Verified { format: &'static str },
    /// No verified adapter exists for this engine (§3.4.5). The host offers a
    /// path, a diagnostic and a native entry point into the engine's own
    /// configuration, and writes nothing — which is also why this variant carries
    /// no format name at all. A caller wanting to write OpenCode's format under
    /// another engine's name has nothing here to name.
    NativeOnly,
}

/// The adapter that answers to `adapter_id`, if one does.
pub fn lookup(adapter_id: &str) -> Option<&'static dyn AgentAdapter> {
    let adapters: [&'static dyn AgentAdapter; 2] = [&opencode::OPENCODE, &generic_acp::GENERIC_ACP];
    adapters
        .into_iter()
        .find(|adapter| adapter.id() == adapter_id)
}
