//! The `initialize` answer, kept as the record of one negotiation.
//!
//! **Why it is a file of its own.** It was the top of `capabilities.rs`, which passed the 600-line
//! budget `docs/dev.md:286` puts on a business source file. The split is by *reason to change*,
//! which is the criterion that section states rather than the line count: this module moves when the
//! *wire's* initialize response moves — a field ACP adds to what an agent advertises, a capability
//! the pinned schema stops sending — while `capabilities.rs` moves when the *report* does: the row a
//! window reads and what this build offers for it. `super::negotiated` holds the session-scoped
//! facts, which are a different negotiation with a different shape.
//!
//! **Why the whole response is read at once, here.** `initialize` happens per connection and its
//! answer is consumed once, so the reading has to happen while `InitializeResponse` is in hand;
//! [`Handshake`] is what survives that moment. That is what [`Handshake::of`]'s totality is for, and
//! it is also why the four fields that are not capabilities are kept: they are the record of the one
//! moment this connection could be asked.
//!
//! Every `Handshake` path a caller named before the split still resolves — the parent re-exports
//! both types, so `agent_runtime::capabilities::Handshake` and `super::capabilities::Handshake` are
//! the same items as they were.

use agent_client_protocol::schema::v1::{
    AuthMethod, Implementation, InitializeResponse, PromptCapabilities,
    SessionCapabilities as WireSessionCapabilities,
};

/// The handshake's answer: everything `InitializeResponse` said that a caller may act on or draw.
///
/// One of the two negotiations §3.4 names, distilled out of `InitializeResponse` so the session
/// layer can keep it without keeping the whole response. Nothing here is inferred: `load_session`
/// is the wire's `agentCapabilities.loadSession`, and `prompt` is its `promptCapabilities` as it
/// arrived — ACP v1 defaults each missing field to `false`, which is the engine saying no.
///
/// **The four fields that are not capabilities are here for the same reason the rest are: the
/// response is consumed once and thrown away.** `initialize` happens per connection, so this value
/// *is* the record of it, and anything not kept here is gone — which is what had happened to the
/// negotiated protocol version, the engine's own `agentInfo` and its `authMethods`. Dropping them
/// was invisible while the only reader was a capability predicate; it stopped being invisible when
/// §3.1.4's runtime page needed the 「协议状态」 the settings surface is required to state, because
/// re-asking was never an option — a second `initialize` on one connection is the protocol's own
/// forbidden call, and a second process would be a different engine.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Handshake {
    /// `protocolVersion`: the version the engine answered with, which is the version this
    /// connection now speaks. Read as it arrived rather than compared against a constant: the host
    /// has no policy to apply here (the SDK owns version negotiation) and a page has a state to
    /// draw, so folding it into a pass/fail check would lose the only copy.
    pub protocol_version: u16,
    /// `agentInfo`: what the engine calls itself and the version it reports. Optional on the wire —
    /// the schema says as much and adds that it becomes required later — so `None` here is an
    /// engine that sent none, which is a fact about that engine and not a failure.
    pub agent: Option<Implementation>,
    /// `authMethods`: the ways the engine says it *can* be authenticated.
    ///
    /// Kept because the engine said it, and kept **as an advertisement**: ACP has no
    /// "is-authenticated" field, and this host never calls `authenticate`, so nothing anywhere may
    /// turn this list into an authorization *state*. Zed keeps the same list
    /// (`agent_servers/src/acp.rs:403`) and has the call that acts on it; we have the list and not
    /// the call, which is why it is reported and acted on by nothing.
    pub auth_methods: Vec<AuthMethod>,
    /// `agentCapabilities.loadSession`: the engine's own report that it serves `session/load`
    /// (§6.2's resume) — advertised rather than measured (P0 §4 lists `session/load` as never
    /// exercised).
    pub load_session: bool,
    /// `agentCapabilities.promptCapabilities`: the content a prompt may carry.
    pub prompt: PromptCapabilities,
    /// `agentCapabilities.sessionCapabilities`: the session-management methods this engine
    /// serves. Four of the five capabilities the scan report named as advertised-and-never-called
    /// live here — `fork`, `close`, `list` and `resume` — and until this field existed the host
    /// parsed none of them.
    pub session: SessionManagement,
}

/// The four session-management methods the handshake advertises, each read off the wire's
/// optional-presence sub-object.
///
/// **`bool`, not `Option<bool>`, and that is the schema's decision rather than a simplification.**
/// Each sub-object is documented as "Optional. Omitted or `null` both mean the agent does not
/// advertise support. Supplying `{}` means the agent supports …" — so absence on this wire is not
/// a silence, it is an answer, and the only fact that could be read any other way is whether the
/// handshake happened at all. That third state lives one level up, on [`Handshake`]'s presence:
/// the predicates on [`super::SessionCapabilities`] answer `None` when no handshake has been read and
/// `Some(this)` afterwards, which is the distinction [`super::Finding`] exists to keep.
///
/// The first version of this type held `Option<bool>` per field and was **wrong**, which its own
/// test caught: a handshake carrying only `list` answered `None` for `resume`, and `None` reads as
/// "nobody has established that it can" — an engine that had said no in the schema's own words
/// would have been reported as unmeasured. The reading is presence (`is_some`), never the
/// sub-object's contents: the schema defines support by `{}` existing and defines nothing about
/// what a non-empty sub-object would mean, so reading further would be inventing a field the
/// protocol does not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SessionManagement {
    /// `sessionCapabilities.list`: the engine serves `session/list`. The one that decides whether
    /// a session-history surface may be offered at all — a panel that drew one for an engine that
    /// did not advertise it would be offering a call the engine has said it does not answer.
    pub list: bool,
    /// `sessionCapabilities.resume`: reopening a session *without* its previous messages.
    pub resume: bool,
    /// `sessionCapabilities.close`: freeing a session on the engine.
    pub close: bool,
    /// `sessionCapabilities.fork`: **UNSTABLE** in the pinned schema — the capability is not part
    /// of the spec yet and may be removed or changed at any point, which is why it is read here
    /// rather than assumed present.
    pub fork: bool,
}

impl SessionManagement {
    /// Read the group out of the handshake.
    fn of(capabilities: &WireSessionCapabilities) -> Self {
        Self {
            list: capabilities.list.is_some(),
            resume: capabilities.resume.is_some(),
            close: capabilities.close.is_some(),
            fork: capabilities.fork.is_some(),
        }
    }
}

impl Handshake {
    /// Read the handshake out of the engine's answer.
    ///
    /// Total over the response on purpose: this is the one moment `InitializeResponse` is in hand,
    /// so every field a caller may later need is read here rather than re-derived from a connection
    /// that can no longer be asked.
    pub fn of(response: &InitializeResponse) -> Self {
        Self {
            protocol_version: response.protocol_version.as_u16(),
            agent: response.agent_info.clone(),
            auth_methods: response.auth_methods.clone(),
            load_session: response.agent_capabilities.load_session,
            prompt: response.agent_capabilities.prompt_capabilities.clone(),
            session: SessionManagement::of(&response.agent_capabilities.session_capabilities),
        }
    }
}
