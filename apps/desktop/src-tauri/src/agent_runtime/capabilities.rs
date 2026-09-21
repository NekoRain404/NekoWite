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
//!
//! **Split by what makes each part change, not by arithmetic.** `docs/dev.md` §5.4.2 puts the
//! criterion on the number of reasons a file changes rather than on its line count, and this file
//! had four: the reading of the `initialize` reply, the session-scoped record and the predicates
//! asked of it, the vocabulary an answer is spelled in, and the join that turns one of those facts
//! into one of those answers. Each is now a child module whose header argues why it is the one that
//! moves when its subject does:
//!
//! - [`handshake`] — what the engine's `initialize` answer advertised, read once because the
//!   response is consumed once and a second handshake on one connection is a forbidden call.
//! - [`negotiated`] — what one runtime incarnation has been told about one session, and Zed's
//!   predicates read off those facts.
//! - [`finding`] — the three states an answer can be in, and how a refusal is spelled.
//! - [`verdict`] — the per-feature join from a wire fact to an answer, and the sentence each
//!   refusal uses.
//!
//! What is left here is what this module is named for from the outside: the row a window reads
//! ([`CapabilityReport`]), the join that fills it ([`report`]), and the half that is about *this
//! app* rather than the engine ([`HostOffer`], and the `host_offer` below it). That half stays in
//! this file deliberately: it is a fact about this build's own source rather than about any engine,
//! and `apps/desktop/src/platform/gateways/tauri-agent.test.ts` reads `fn host_offer` out of *this
//! path* to hold the window's copy of the table to it.
//!
//! Every name a caller outside this module reached before is re-exported below, so the split moved
//! no path: `commands/agent_capabilities.rs`, `commands/agent_runtime.rs`, `session`, `runs` and
//! `attachments` name the same symbols through `agent_runtime::capabilities` as they always did.

use serde::Serialize;

use super::adapters::{Capability, HostFeature};

// The four reasons-to-change this file had, each now a file that says why it is the one that moves
// when its subject does.
mod finding;
mod handshake;
mod negotiated;
mod verdict;

// The tests that hold the whole join — the report, all four modules above, and the two fields a
// window reads. Declared here because they test this module's contract rather than any one child's,
// and a file of their own because they are the largest single reason `capabilities.rs` was over
// budget.
#[cfg(test)]
mod tests;

pub use finding::Finding;
pub use handshake::{Handshake, SessionManagement};
pub use negotiated::SessionCapabilities;
// `SessionFacts` is re-exported although nothing in this crate names the type through this path: it
// was defined here before the split, and `SessionCapabilities::session` hands one out, so a caller
// may still say `capabilities::SessionFacts`. `unused_imports` reports it all the same in a test
// target that `#[path]`-includes this tree whole and never names it — `tests/agent_recovery_test.rs`
// and `tests/agent_settings_ipc_test.rs` both do — so the re-export is allowed rather than dropped,
// because dropping it would take away a path that existed before the split.
#[allow(unused_imports)]
pub use negotiated::SessionFacts;
use verdict::finding_for;

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
