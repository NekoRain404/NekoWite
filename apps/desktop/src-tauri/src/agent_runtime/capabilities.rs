//! The capability join: what an installation claims, what the engine reported, and which of the
//! two is an answer.
//!
//! §3.4's capability row is the whole design, in one line: 「安装声明仅用于启动提示；初始化/会话协商和实测决定
//! 运行期可用功能，重连和版本变化后重新检测」. Each clause is a shape here rather than a rule someone
//! has to remember:
//!
//! - **A declaration is not an answer.** [`Capability`] describes the pinned version, and
//!   [`CapabilityReport`] carries it in its own field beside the finding — never folded into it,
//!   and never a route to `available`. A page that shows both can show the disagreement.
//! - **The negotiation decides, and only the negotiation.** [`SessionCapabilities`] holds what the
//!   engine reported: the `initialize` handshake, the `session/new` response, and the command list
//!   the engine publishes afterwards. `available` has exactly one source — one of those said so —
//!   and a feature nothing has reported is `unverified` while one the engine reported *absent* is
//!   `unavailable`. The two are different claims and neither may stand in for the other.
//! - **It is re-derived, not cached.** The facts live on one runtime incarnation ([`super::session`]
//!   owns one engine process under one `runtimeEpoch`), and a caller that has lost that incarnation
//!   passes `None`: a negotiation from a runtime that is over is not an answer, which is why
//!   [`report`] answers `unverified` for it rather than keeping the last thing it saw.
//!
//! The derivations are Zed's, ported from `SessionCapabilities`
//! (`zed-main/crates/agent_ui/src/message_editor.rs:49-53` for the struct, `:68-73` for building it
//! from what the handshake reported, `:75-81` for the two prompt predicates, `:91-93` for
//! `has_slash_completions`, and `:128-138` for the setters). The idea taken from it is that a
//! capability is not a flag anyone sets: it is a fact read off what the session actually reported —
//! `supports_images()` *is* `prompt_capabilities.image`, and slash completions exist when the
//! published command list is not empty. Zed's `bool` becomes `Option<bool>` here because §3.4's row
//! keeps 「未测量」 apart from 「不支持」, and Zed's `Default` handshake cannot carry that distinction.
//!
//! The fourth rule is this app's addition, and it is the one a report can break silently: **a
//! capability that is not available is reported as unavailable rather than omitted.** The rows are
//! driven by [`HostFeature::ALL`], so a feature cannot fall out of the report without failing to
//! exist, and every non-available arm *requires* a detail — the shape D3's
//! `linux_capabilities::Finding` uses, for its reason (§7.2 「不宣称…」: a host may not report a
//! capability as missing and leave the user to guess, nor report one as present while quietly
//! substituting something).
//!
//! The fifth is the same rule seen from the other side, and it is [`HostOffer`]'s whole reason: two
//! of those rules are about the engine, and neither is about the program the reader is holding. A
//! row may therefore be honest about the engine and still mislead about this app — 「the engine can
//! fork」 is true of the pinned engine and reads as 「you can fork」, which is false here. The third
//! subject is carried beside the other two rather than folded into either.

use agent_client_protocol::schema::v1::{
    AuthMethod, Implementation, InitializeResponse, LoadSessionResponse, NewSessionResponse,
    PromptCapabilities, SessionCapabilities as WireSessionCapabilities, SessionConfigOption,
};
use serde::Serialize;

use super::adapters::{Capability, HostFeature};

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
/// the predicates on [`SessionCapabilities`] answer `None` when no handshake has been read and
/// `Some(this)` afterwards, which is the distinction [`Finding`] exists to keep.
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

/// What a session response said, as far as capabilities are concerned.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionFacts {
    /// The option ids `session/new` returned. The ids are the engine's to define (§6.3), so these
    /// are what a caller may offer and all it may offer.
    pub config_option_ids: Vec<String>,
}

impl SessionFacts {
    /// Read the session response. An engine that returned no list said it has no options: the
    /// schema makes the field optional and 「not supported」 is what absent means, which is a
    /// measurement rather than a silence.
    pub fn of(response: &NewSessionResponse) -> Self {
        Self::from_options(response.config_options.as_ref())
    }

    /// The same reading of a *load* response, which answers with the option list under the same
    /// name and the same type — a reopened session has the same options a new one does.
    pub fn of_loaded(response: &LoadSessionResponse) -> Self {
        Self::from_options(response.config_options.as_ref())
    }

    fn from_options(options: Option<&Vec<SessionConfigOption>>) -> Self {
        Self {
            config_option_ids: options
                .map(|options| options.iter().map(|option| option.id.to_string()).collect())
                .unwrap_or_default(),
        }
    }
}

/// What one runtime incarnation learned about one session, from the engine itself.
///
/// Field for field the three groups Zed's `SessionCapabilities` holds
/// (`message_editor.rs:49-53`), with the one change §3.4's row forces: each group is optional,
/// because "the handshake has not been read" and "the handshake reported nothing" are different
/// facts, and a report that conflated them would be answering about an engine it never asked.
///
/// Nothing here is derived-and-stored. Every question below reads one of these facts, so the
/// answer cannot drift from what the engine said.
#[derive(Debug, Clone, Default)]
pub struct SessionCapabilities {
    /// The `initialize` answer, once one has been read.
    handshake: Option<Handshake>,
    /// The `session/new` answer, once one has been read.
    session: Option<SessionFacts>,
    /// How many commands the engine's last published list held.
    ///
    /// `None` is "no list has been published for this session"; `Some(0)` is a published list with
    /// nothing in it. The commands themselves are not kept: their journey to the `/` menu is the
    /// event stream's (T8's), and a second copy here would be a second truth about one wire value.
    /// A count is the whole of what a capability answer needs.
    commands: Option<usize>,
}

impl SessionCapabilities {
    /// The first negotiation: the handshake.
    pub fn negotiated(&mut self, handshake: Handshake) {
        self.handshake = Some(handshake);
    }

    /// The second: the session response.
    pub fn opened(&mut self, response: &NewSessionResponse) {
        self.session = Some(SessionFacts::of(response));
    }

    /// The second one more time, for a session that already existed: a load response answers the
    /// same question `session/new` does about the options this session now offers.
    pub fn reopened(&mut self, response: &LoadSessionResponse) {
        self.session = Some(SessionFacts::of_loaded(response));
    }

    /// The command list the engine published, replacing the previous one whole
    /// (§4.1: replace, never append).
    pub fn commands_published(&mut self, count: usize) {
        self.commands = Some(count);
    }

    /// The handshake, or `None` when none has been read.
    pub fn handshake(&self) -> Option<&Handshake> {
        self.handshake.as_ref()
    }

    /// The session response, or `None` when none has been read.
    pub fn session(&self) -> Option<&SessionFacts> {
        self.session.as_ref()
    }

    /// How many commands the published list holds, or `None` before one is published.
    pub fn command_count(&self) -> Option<usize> {
        self.commands
    }

    /// Zed's `supports_images` (`message_editor.rs:75-77`), with the state its `bool` cannot carry:
    /// `None` until the handshake has been read, and the wire's own answer after that.
    pub fn supports_images(&self) -> Option<bool> {
        self.prompt(|prompt| prompt.image)
    }

    /// Zed's `supports_embedded_context` (`message_editor.rs:79-81`), same shape.
    pub fn supports_embedded_context(&self) -> Option<bool> {
        self.prompt(|prompt| prompt.embedded_context)
    }

    /// `promptCapabilities.audio`, which Zed's editors do not gate on and this host does: §3.4.6
    /// wants the specific limitation shown, and audio is the arm the pinned engine answers no to.
    pub fn supports_audio(&self) -> Option<bool> {
        self.prompt(|prompt| prompt.audio)
    }

    /// `agentCapabilities.loadSession`.
    pub fn supports_session_resume(&self) -> Option<bool> {
        self.handshake
            .as_ref()
            .map(|handshake| handshake.load_session)
    }

    /// `sessionCapabilities.list`: may a session-history surface be offered at all.
    ///
    /// `None` is *no handshake has been read* — the one state in which nothing has said either
    /// way. Once one has, this wire answers: a handshake without the sub-object is the engine
    /// saying it does not serve `session/list`, which is `Some(false)` and not a silence.
    pub fn session_capability_list(&self) -> Option<bool> {
        self.session_capability(|session| session.list)
    }

    /// `sessionCapabilities.resume`: reopening a session **without** its previous messages.
    ///
    /// Deliberately not spelled `supports_session_resume`, which is the predicate above it: that
    /// one reads `agentCapabilities.loadSession`, and `load` and `resume` are different methods
    /// the schema separates in as many words. This group is named for its wire parent
    /// (`sessionCapabilities`) for the same reason — the four here are the sub-objects of one
    /// struct, and a reader can tell at a glance which of the two handshake fields an answer came
    /// from.
    pub fn session_capability_resume(&self) -> Option<bool> {
        self.session_capability(|session| session.resume)
    }

    /// `sessionCapabilities.close`.
    pub fn session_capability_close(&self) -> Option<bool> {
        self.session_capability(|session| session.close)
    }

    /// `sessionCapabilities.fork` — **UNSTABLE** in the pinned schema.
    pub fn session_capability_fork(&self) -> Option<bool> {
        self.session_capability(|session| session.fork)
    }

    fn session_capability(&self, read: impl FnOnce(&SessionManagement) -> bool) -> Option<bool> {
        self.handshake
            .as_ref()
            .map(|handshake| read(&handshake.session))
    }

    /// Zed's `has_slash_completions` (`message_editor.rs:91-93`): completions exist when the
    /// published list is not empty. `None` is the third state its `bool` folds away — the engine
    /// has published no list at all, so there is nothing to have an opinion about.
    pub fn has_slash_completions(&self) -> Option<bool> {
        self.commands.map(|published| published > 0)
    }

    fn prompt(&self, read: impl FnOnce(&PromptCapabilities) -> bool) -> Option<bool> {
        self.handshake
            .as_ref()
            .map(|handshake| read(&handshake.prompt))
    }
}

/// What was established about one feature.
///
/// Three arms, and the third is the one a two-armed version would lose: `available` is only ever
/// produced by a negotiation that said so, `unavailable` is a negotiation that said no, and
/// `unverified` is one that has not happened. [`super::linux_capabilities::Finding`] has a fourth,
/// `degraded`, for a capability that works in part; none of these features has a partial state —
/// an engine either reported image support or it did not — so inventing one here would be a status
/// a page had to explain and nothing could produce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Finding {
    /// The engine reported it. The only route to this arm is a report that said so.
    Available,
    /// The engine was asked, and its answer was no. The detail says what it said.
    Unavailable { detail: String },
    /// Nothing has been reported. Not a synonym for either of the other two: calling an
    /// unmeasured feature "unsupported" is as wrong as calling it "supported".
    Unverified { detail: String },
}

/// What **this app** offers for one feature — the third subject §3.4's row needs and neither of the
/// other two is about.
///
/// [`Finding`] answers *what the engine reported* and [`Capability`] answers *what the pinned
/// version was measured to do*. Neither is a statement about the program the user is holding, and a
/// page that drew only those two is a page on which `available` reads as 「you can do this」. On the
/// pinned engine that reading is wrong twice: the handshake advertises `session/fork` and
/// `session/resume` (P0 §2.1), both come out [`Finding::Available`], and neither has a call in this
/// crate (`grep -rn '"session/fork"' src/` → nothing; `acp_transport/calls.rs` names `session/load`
/// and not `session/resume`). A user reading those two rows is reading the engine's ability and
/// being told about this app's.
///
/// **So this is a third field rather than a fourth arm of [`Finding`].** Folding it in would make
/// the report lie about the engine in the one direction the module exists to prevent — the engine
/// *did* report it, and `Unavailable` would be this host answering for a process it just heard from
/// — and a report that simply dropped the row instead is what [`HostFeature::ALL`] forbids. The
/// three arrive side by side, and a page that shows all three can show the disagreement between
/// them.
///
/// The arms are ids, not sentences: the page's copy tree owns the words a user reads, the same
/// split [`super::commands`]' `HandshakeAbsent` makes and for the same reason — a prose field would
/// put an English sentence in the middle of a Chinese page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum HostOffer {
    /// **This app has a call**: `command`, a name in `build.rs`'s manifest, is the `agent_*` command
    /// a window invokes to do it. The name is carried rather than a `true`, so the claim is
    /// checkable against the surface it names instead of being an adjective — the test below holds
    /// every one of these to `build.rs`'s list, which is what makes "this app can do it" a fact
    /// about the shipped command surface rather than about this file.
    Command { command: &'static str },
    /// **The agent panel's own controls reach it** and no command of this app's is involved: the
    /// composer's attachment intakes, the configuration row, the command menu. These are drawn from
    /// this same report — `use-agent-composer-attachments` gates its intakes on the rows — so the
    /// control and the row are the same fact seen twice rather than two claims that could drift.
    Control,
    /// **Nothing in this build acts on the feature.** Whatever the engine advertised, there is no
    /// button, no command and no call: the row is a statement about the engine and there is nothing
    /// on this side of the window to press. This is the arm the field exists for.
    Nothing,
}

/// Which of the three things this app does about one feature.
///
/// A pure function of the feature, and that is a claim in itself: what this build offers is a fact
/// about this build's source, so unlike the engine's answer it does not have to arrive from
/// anywhere. Nothing here reads the negotiation, and a feature whose engine said no can still come
/// out [`HostOffer::Command`] — the two are different questions and the arms must not be made to
/// look like one.
fn host_offer(feature: HostFeature) -> HostOffer {
    match feature {
        // `session/load` — reopening a session *with* its conversation — has a command of its own
        // (`commands/agent_sessions.rs`), which is why this row and
        // `SessionResumeWithoutHistory` below it do not share an answer: they are two wire methods
        // and this build calls one of them.
        HostFeature::SessionResume => HostOffer::Command {
            command: "agent_load_session",
        },
        HostFeature::SessionList => HostOffer::Command {
            command: "agent_list_sessions",
        },
        HostFeature::SessionClose => HostOffer::Command {
            command: "agent_close_session",
        },
        // `session/resume` is **not** `session/load` despite the handshake advertising both in one
        // group: the schema documents resume as the one that returns no previous messages, and no
        // call in this crate names it. The app reopens sessions through `load`, which is the method
        // whose answer a window can draw a conversation from.
        HostFeature::SessionResumeWithoutHistory => HostOffer::Nothing,
        // `session/fork`, and the row this field was added for: the pinned engine serves it (the
        // lifecycle probe measures a fork being handed back and then served), the handshake
        // advertises it, and this build has no call, no command and no control for it.
        HostFeature::SessionFork => HostOffer::Nothing,
        // The engine's own option list, set through `session/set_config_option` — one command, and
        // it is what both of these rows are about: a session that offers options, and the model one
        // among them.
        HostFeature::SessionConfigOptions | HostFeature::ModelSelection => HostOffer::Command {
            command: "agent_set_config_option",
        },
        HostFeature::SlashCommands
        | HostFeature::ImageAttachments
        | HostFeature::EmbeddedContext => HostOffer::Control,
        // The engine said no to `promptCapabilities.audio` (P0 §2.1, and this build's own fixture
        // reproduces it), and this app's composer has no audio intake either — `intake` handles two
        // kinds, neither of them this one. Both halves are absent, which is not the row's defect
        // but is worth the arm being explicit about.
        HostFeature::AudioAttachments => HostOffer::Nothing,
    }
}

/// One feature, with all three of §3.4's row's subjects kept apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    /// The host's own name for the feature ([`HostFeature::as_str`]). Data: a page renders it as it
    /// arrived rather than mapping it onto a second name of its own.
    pub feature: &'static str,
    /// The installation's claim — §3.4: a start-time hint, never the answer. Reported **beside**
    /// the finding, deliberately: a page that showed only this would be showing what the pinned
    /// version was measured to do rather than what the engine in front of the user reported.
    pub declared: Capability,
    /// What the negotiation established.
    pub finding: Finding,
    /// What this app does about it — see [`HostOffer`]. **Not** folded into either of the two
    /// above, and the one member of this struct that does not depend on the engine at all: it is
    /// reported for every row whether or not a handshake happened, because the reader of a row that
    /// says the engine can fork is owed the fact that nothing here can ask it to.
    pub host: HostOffer,
}

/// Why a feature nothing reported is not available.
const NO_NEGOTIATION: &str =
    "nothing has been negotiated for this session yet: there is no answer \
                              to report, only a claim";

/// Why a feature the handshake would have answered is not available.
const NO_HANDSHAKE: &str =
    "this runtime has not read the engine's handshake, so nothing has said either way";

/// Why a feature the session response would have answered is not available.
const NO_SESSION: &str =
    "no session response has been read: the engine has not yet been asked what it offers here";

/// The join: one row per feature, each with both halves.
///
/// `declared` is called once per feature rather than taking a prepared list, because the
/// declaration lives with the engine's adapter (`AgentInstance::declared_capability`) and asking
/// there is what keeps a stopped incarnation from repeating what its process once advertised.
/// `negotiated` is the engine's own report for the session, or `None` when there is none — a
/// runtime that is gone, a session this host never opened, a handshake that has not happened.
pub fn report(
    declared: impl Fn(HostFeature) -> Capability,
    negotiated: Option<&SessionCapabilities>,
    model_option_id: Option<&str>,
) -> Vec<CapabilityReport> {
    HostFeature::ALL
        .into_iter()
        .map(|feature| CapabilityReport {
            feature: feature.as_str(),
            declared: declared(feature),
            finding: match negotiated {
                Some(facts) => finding_for(feature, facts, model_option_id),
                None => Finding::Unverified {
                    detail: NO_NEGOTIATION.to_string(),
                },
            },
            // Outside the `match` above on purpose: the host's own half does not depend on the
            // negotiation, and a caller that has no facts is the caller that most needs it.
            // `readout_of` is that caller — the settings page before the first session.
            host: host_offer(feature),
        })
        .collect()
}

/// What the negotiation said about one feature — the only place [`Finding::Available`] is built.
///
/// A missing fact is `unverified` and a fact that says no is `unavailable`, at every arm: the two
/// are the difference between "this engine cannot" and "nobody has established that it can", which
/// is the distinction the whole module exists to keep.
fn finding_for(
    feature: HostFeature,
    facts: &SessionCapabilities,
    model_option_id: Option<&str>,
) -> Finding {
    match feature {
        HostFeature::SessionResume => answered(
            facts.supports_session_resume(),
            "the engine's handshake does not advertise `loadSession`, so this engine cannot load a \
             session it still has",
            NO_HANDSHAKE,
        ),
        // The four `sessionCapabilities` sub-objects. Each names the wire field it read, because
        // the specific limitation is what §3.4.6 asks a page to be able to show — and because
        // "list" and "resume" name one method each while `SessionResume` above names a *different*
        // one, so a detail that said only "resume" would be ambiguous about which field said no.
        HostFeature::SessionList => answered(
            facts.session_capability_list(),
            "the engine's handshake carries no `sessionCapabilities.list`, so it has said it does \
             not answer `session/list` and there is no session history to show",
            NO_HANDSHAKE,
        ),
        HostFeature::SessionResumeWithoutHistory => answered(
            facts.session_capability_resume(),
            "the engine's handshake carries no `sessionCapabilities.resume`, so this engine cannot \
             reopen a session without its previous messages",
            NO_HANDSHAKE,
        ),
        HostFeature::SessionClose => answered(
            facts.session_capability_close(),
            "the engine's handshake carries no `sessionCapabilities.close`, so this engine cannot \
             be asked to free a session it holds",
            NO_HANDSHAKE,
        ),
        HostFeature::SessionFork => answered(
            facts.session_capability_fork(),
            "the engine's handshake carries no `sessionCapabilities.fork` — and the pinned schema \
             marks that capability unstable, so an engine may have removed it",
            NO_HANDSHAKE,
        ),
        HostFeature::ImageAttachments => answered(
            facts.supports_images(),
            "the engine's handshake does not advertise `promptCapabilities.image`, so an image \
             sent in a prompt is not something it has said it would read",
            NO_HANDSHAKE,
        ),
        HostFeature::AudioAttachments => answered(
            facts.supports_audio(),
            "the engine's handshake does not advertise `promptCapabilities.audio`, so an audio \
             attachment is not something it has said it would read",
            NO_HANDSHAKE,
        ),
        HostFeature::EmbeddedContext => answered(
            facts.supports_embedded_context(),
            "the engine's handshake does not advertise `promptCapabilities.embeddedContext`, so a \
             note or a selection cannot be sent inside the prompt as a resource block",
            NO_HANDSHAKE,
        ),
        HostFeature::SlashCommands => answered(
            facts.has_slash_completions(),
            // A published list with nothing in it is a measurement, not a gap: the engine answered
            // the question by publishing it (P0 §2.2 measured the list arriving after `session/new`,
            // always as a full replacement). What has *not* arrived is neither answer.
            "the engine published a command list and it was empty",
            "the engine has published no command list for this session, so there is no evidence \
             either way yet",
        ),
        HostFeature::SessionConfigOptions => match facts.session() {
            None => unverified(NO_SESSION),
            Some(session) if session.config_option_ids.is_empty() => unavailable(
                "`session/new` returned no configuration options, so this engine has nothing of \
                 its own here to set",
            ),
            Some(_) => Finding::Available,
        },
        HostFeature::ModelSelection => {
            // The adapter's answer for which option selects the model is the engine's-own-id
            // knowledge §3.4 forbids anyone else from guessing; without it there is nothing to look
            // for, and `unverified` is the honest state rather than a hunt through the options.
            let Some(option_id) = model_option_id else {
                return unverified(
                    "this engine's adapter names no configuration option as the model selector, so \
                     no session fact could confirm one",
                );
            };
            match facts.session() {
                None => unverified(NO_SESSION),
                Some(session) if session.config_option_ids.iter().any(|id| id == option_id) => {
                    Finding::Available
                }
                Some(_) => unavailable(&format!(
                    "`session/new` returned no option with the id `{option_id}` that this engine's \
                     adapter names as the model selector"
                )),
            }
        }
    }
}

/// One derived answer, as a finding: the third state a two-armed predicate cannot carry.
///
/// Every arm above goes through here, so "nobody has reported" and "the report said no" cannot be
/// confused at one arm and kept apart at another.
fn answered(reported: Option<bool>, absent: &str, missing: &str) -> Finding {
    match reported {
        None => unverified(missing),
        Some(true) => Finding::Available,
        Some(false) => unavailable(absent),
    }
}

fn unavailable(detail: &str) -> Finding {
    Finding::Unavailable {
        detail: detail.to_string(),
    }
}

fn unverified(detail: &str) -> Finding {
    Finding::Unverified {
        detail: detail.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        AuthMethodAgent, NewSessionResponse, SessionConfigOption, SessionConfigSelectOption,
    };

    /// A handshake that says the three prompt capabilities and resume, spelled the way the wire
    /// spells them — the values P0 §2.1 measured the pinned OpenCode answering with.
    fn measured_handshake() -> Handshake {
        Handshake {
            // The fixture's own values, read off the same line as the group below: `"protocolVersion":1`,
            // `"authMethods":[{"id":"fake-login","name":"Fake login"}]`,
            // `"agentInfo":{"name":"FakeAgent","version":"0.0.1"}`.
            protocol_version: 1,
            agent: Some(Implementation::new("FakeAgent", "0.0.1")),
            auth_methods: vec![AuthMethod::Agent(AuthMethodAgent::new(
                "fake-login",
                "Fake login",
            ))],
            load_session: true,
            prompt: PromptCapabilities::new()
                .image(true)
                .audio(false)
                .embedded_context(true),
            // The pinned engine's own group, verbatim from the measured handshake the fixture
            // carries (`tests/fixtures/agent/fake_agent.sh:22`):
            // `"sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}`. All four
            // present, which is the schema's way of saying yes to each — and the fact the scan
            // report's §1 table recorded this host as never reading.
            session: SessionManagement {
                list: true,
                resume: true,
                close: true,
                fork: true,
            },
        }
    }

    /// A session response with the options named, shaped like the one option the pinned engine
    /// returns (`configOptions[0].id == "model"`, P0 §2.2).
    fn session_response(option_ids: &[&str]) -> NewSessionResponse {
        let mut response = NewSessionResponse::new("ses-1");
        response.config_options = Some(
            option_ids
                .iter()
                .map(|id| {
                    SessionConfigOption::select(
                        (*id).to_string(),
                        "Model",
                        "fake/model-a",
                        Vec::<SessionConfigSelectOption>::new(),
                    )
                })
                .collect(),
        );
        response
    }

    /// Everything the engine reported, as the session layer composes it.
    fn negotiated(option_ids: &[&str], commands: Option<usize>) -> SessionCapabilities {
        let mut facts = SessionCapabilities::default();
        facts.negotiated(measured_handshake());
        facts.opened(&session_response(option_ids));
        if let Some(count) = commands {
            facts.commands_published(count);
        }
        facts
    }

    fn row(rows: &[CapabilityReport], feature: HostFeature) -> &CapabilityReport {
        rows.iter()
            .find(|row| row.feature == feature.as_str())
            .expect("every feature has a row")
    }

    #[test]
    fn a_declaration_is_never_the_answer() {
        // §3.4: 「安装声明仅用于启动提示…决定运行期可用功能」. The declaration is reported, and it is
        // reported *beside* a finding that nothing negotiated can make available.
        let rows = report(|_| Capability::Advertised, None, Some("model"));
        assert_eq!(rows.len(), HostFeature::ALL.len());
        for row in &rows {
            assert_eq!(row.declared, Capability::Advertised, "{}", row.feature);
            assert!(
                matches!(row.finding, Finding::Unverified { .. }),
                "{} was declared available without a negotiation: {:?}",
                row.feature,
                row.finding
            );
        }
    }

    #[test]
    fn every_feature_is_reported_in_one_order() {
        // The fourth rule, as a property: a feature cannot go missing without failing to exist,
        // because the list of rows *is* `HostFeature::ALL`.
        let rows = report(|_| Capability::Unverified, None, None);
        let features: Vec<&str> = rows.iter().map(|row| row.feature).collect();
        assert_eq!(
            features,
            HostFeature::ALL.map(|feature| feature.as_str()),
            "the report is the feature list, spelled the same way"
        );
    }

    #[test]
    fn the_handshake_decides_the_prompt_capabilities() {
        let facts = negotiated(&["model"], Some(2));
        let rows = report(|_| Capability::Advertised, Some(&facts), Some("model"));
        // Reported, so available.
        assert_eq!(
            row(&rows, HostFeature::ImageAttachments).finding,
            Finding::Available
        );
        assert_eq!(
            row(&rows, HostFeature::EmbeddedContext).finding,
            Finding::Available
        );
        assert_eq!(
            row(&rows, HostFeature::SessionResume).finding,
            Finding::Available
        );
        // Reported absent, so unavailable — with the engine's own fact named. The declaration
        // still says what the pinned version does, which is the disagreement the two fields exist
        // to show: this engine was declared to take images and did not report that it does.
        let audio = row(&rows, HostFeature::AudioAttachments);
        assert_eq!(audio.declared, Capability::Advertised);
        assert!(
            matches!(&audio.finding, Finding::Unavailable { detail } if detail.contains("audio")),
            "{:?}",
            audio.finding
        );
    }

    #[test]
    fn a_published_empty_list_is_a_measurement_and_silence_is_not() {
        let before = report(
            |_| Capability::Advertised,
            Some(&SessionCapabilities::default()),
            None,
        );
        let slash = row(&before, HostFeature::SlashCommands);
        assert!(
            matches!(&slash.finding, Finding::Unverified { detail } if detail.contains("no command list")),
            "{:?}",
            slash.finding
        );

        let empty = negotiated(&["model"], Some(0));
        let after = report(|_| Capability::Advertised, Some(&empty), None);
        assert_eq!(
            row(&after, HostFeature::SlashCommands).finding,
            unavailable("the engine published a command list and it was empty")
        );

        let published = negotiated(&["model"], Some(1));
        let with_commands = report(|_| Capability::Advertised, Some(&published), None);
        assert_eq!(
            row(&with_commands, HostFeature::SlashCommands).finding,
            Finding::Available
        );
    }

    #[test]
    fn the_session_response_decides_the_options_and_the_model() {
        let named = negotiated(&["model", "mode"], None);
        let rows = report(|_| Capability::Advertised, Some(&named), Some("model"));
        assert_eq!(
            row(&rows, HostFeature::SessionConfigOptions).finding,
            Finding::Available
        );
        assert_eq!(
            row(&rows, HostFeature::ModelSelection).finding,
            Finding::Available
        );

        // The session answered, and the option the adapter names is not among them.
        let missing = negotiated(&["mode"], None);
        let rows = report(|_| Capability::Advertised, Some(&missing), Some("model"));
        let model = row(&rows, HostFeature::ModelSelection);
        assert!(
            matches!(&model.finding, Finding::Unavailable { detail } if detail.contains("`model`")),
            "{:?}",
            model.finding
        );

        // No option list at all: the session answered with nothing.
        let none = negotiated(&[], None);
        let rows = report(|_| Capability::Advertised, Some(&none), Some("model"));
        assert!(matches!(
            row(&rows, HostFeature::SessionConfigOptions).finding,
            Finding::Unavailable { .. }
        ));

        // Nothing named the model option, so nothing could confirm one — even though the session
        // did return options.
        let unnamed = negotiated(&["model"], None);
        let rows = report(|_| Capability::Advertised, Some(&unnamed), None);
        assert!(matches!(
            row(&rows, HostFeature::ModelSelection).finding,
            Finding::Unverified { .. }
        ));
        assert_eq!(
            row(&rows, HostFeature::SessionConfigOptions).finding,
            Finding::Available
        );
    }

    #[test]
    fn the_predicates_are_readings_of_the_facts_and_not_flags() {
        // The Zed-shaped surface (`message_editor.rs:75-93`), asserted against the facts one by
        // one: each predicate is a read of a field the engine sent, and `None` — not `false` — is
        // what it answers before that field exists.
        let mut facts = SessionCapabilities::default();
        assert_eq!(facts.supports_images(), None);
        assert_eq!(facts.supports_audio(), None);
        assert_eq!(facts.supports_embedded_context(), None);
        assert_eq!(facts.supports_session_resume(), None);
        assert_eq!(facts.session_capability_list(), None);
        assert_eq!(facts.session_capability_resume(), None);
        assert_eq!(facts.session_capability_close(), None);
        assert_eq!(facts.session_capability_fork(), None);
        assert_eq!(facts.has_slash_completions(), None);

        facts.negotiated(measured_handshake());
        assert_eq!(facts.supports_images(), Some(true));
        assert_eq!(facts.supports_audio(), Some(false));
        assert_eq!(facts.supports_embedded_context(), Some(true));
        assert_eq!(facts.supports_session_resume(), Some(true));
        assert_eq!(facts.session_capability_list(), Some(true));
        assert_eq!(facts.session_capability_resume(), Some(true));
        assert_eq!(facts.session_capability_close(), Some(true));
        assert_eq!(facts.session_capability_fork(), Some(true));
        assert_eq!(
            facts.has_slash_completions(),
            None,
            "no list has been published yet"
        );

        facts.commands_published(0);
        assert_eq!(
            facts.has_slash_completions(),
            Some(false),
            "an empty list is an answer"
        );
        facts.commands_published(2);
        assert_eq!(facts.has_slash_completions(), Some(true));
    }

    /// Every command name `build.rs`'s manifest declares.
    ///
    /// Read out of the source rather than restated, for the reason `tests/command_surface_test.rs`
    /// gives about the same list: a second copy would compare the manifest with itself. What this
    /// file needs from it is not the whole surface but the *names*, so that a row claiming this app
    /// can do something can be held to the list of things a window can actually reach.
    fn declared_commands() -> Vec<String> {
        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs"),
        )
        .expect("build.rs declares the surface");
        manifest
            .split("const COMMANDS: &[&str] = &[")
            .nth(1)
            .and_then(|rest| rest.split("];").next())
            .expect("build.rs's command list")
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let name = line.strip_prefix('"')?.split('"').next()?;
                (!name.is_empty()).then(|| name.to_string())
            })
            .collect()
    }

    /// The three rows where the engine and this app disagree, and the only test that fails when
    /// [`HostOffer`] is not carried.
    ///
    /// These are the case the field exists for: the pinned engine's handshake advertises
    /// `sessionCapabilities.fork` and `sessionCapabilities.resume` (P0 §2.1 measured both present),
    /// so both rows come out [`Finding::Available`] — correctly, because that arm is about the
    /// engine — and this build cannot fork a session or resume one without its messages. A report
    /// that stopped at the finding would tell a user those two things work.
    ///
    /// The assertion is deliberately `== Finding::Available` **and** `== HostOffer::Nothing` on one
    /// row: either half alone is defensible and the pair is the lie, so a test that checked the arm
    /// without checking the finding would keep passing on the day the engine stopped advertising it
    /// — at which point the row would be honest and this field would be saying nothing.
    #[test]
    fn the_rows_the_engine_offers_and_this_app_does_not_say_both() {
        let facts = negotiated(&["model"], Some(2));
        let rows = report(|_| Capability::Advertised, Some(&facts), Some("model"));
        for feature in [
            HostFeature::SessionFork,
            HostFeature::SessionResumeWithoutHistory,
        ] {
            let row = row(&rows, feature);
            assert_eq!(
                row.finding,
                Finding::Available,
                "{} is no longer a row the engine advertises, so this test has stopped being the \
                 case it was written for",
                feature.as_str()
            );
            assert_eq!(
                row.host,
                HostOffer::Nothing,
                "{}: the engine advertises it and nothing in this build acts on it, which is what \
                 a reader of this row has to be told",
                feature.as_str()
            );
        }
        // And the other side of the same rule: a row this app *does* have a call for says so, so
        // the arms above are a reading of the feature rather than an arm nothing can leave.
        assert_eq!(
            row(&rows, HostFeature::SessionClose).host,
            HostOffer::Command {
                command: "agent_close_session"
            }
        );
        // The host's half does not depend on the negotiation, and the caller with no facts —
        // `readout_of`, the settings page before the first session — is the one that most needs it.
        let unnegotiated = report(|_| Capability::Advertised, None, None);
        assert_eq!(
            row(&unnegotiated, HostFeature::SessionFork).host,
            HostOffer::Nothing
        );
    }

    /// Every command a row claims is one the manifest declares, so 「this app can do it」 is a fact
    /// about the shipped command surface rather than an adjective in this file.
    ///
    /// This is the direction the project has been bitten in five times — a thing built with no
    /// caller — read from the report's side: a row that named a command nobody can reach would be
    /// the same defect with a user in front of it, because the row is what tells them so. Renaming
    /// or removing `agent_close_session` therefore fails here rather than leaving a claim the
    /// window cannot satisfy.
    #[test]
    fn every_command_a_row_claims_is_one_the_manifest_declares() {
        let declared = declared_commands();
        assert!(
            declared.iter().any(|name| name == "agent_list_sessions"),
            "the manifest was read as {declared:?}, which does not look like the command list — \
             a parse that found nothing would make every assertion below vacuous"
        );
        let rows = report(|_| Capability::Unverified, None, None);
        let mut claimed = Vec::new();
        for row in &rows {
            if let HostOffer::Command { command } = row.host {
                assert!(
                    declared.iter().any(|name| name == command),
                    "{} claims this build calls `{command}`, which the manifest does not declare — \
                     a window cannot reach it",
                    row.feature
                );
                claimed.push(command);
            }
        }
        // The list is not empty, which is the other way this test could pass without saying
        // anything: a `host_offer` that answered `Nothing` everywhere would satisfy the loop above.
        assert_eq!(
            claimed.len(),
            5,
            "five rows name a command; the arm they are on is what the loop above checks, so a \
             sixth has to be added here deliberately: {claimed:?}"
        );
    }

    #[test]
    fn facts_are_composed_from_what_arrived_and_nothing_else() {
        // The three setter groups are independent: a command list that arrived before the session
        // was registered is still a fact about that session, and the handshake's absence is
        // visible rather than defaulted away.
        let mut facts = SessionCapabilities::default();
        facts.commands_published(3);
        assert!(facts.handshake().is_none());
        assert!(facts.session().is_none());
        assert_eq!(facts.command_count(), Some(3));

        // And the wire's own answer is read as it is: `image` true, `audio` false, `embeddedContext`
        // true — no arm of this file invents one of the three.
        let measured = measured_handshake();
        assert!(measured.prompt.image);
        assert!(!measured.prompt.audio);
        assert!(measured.prompt.embedded_context);
    }
}
