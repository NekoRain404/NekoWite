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

use agent_client_protocol::schema::v1::{InitializeResponse, NewSessionResponse, PromptCapabilities};
use serde::Serialize;

use super::adapters::{Capability, HostFeature};

/// The handshake's answer, as far as capabilities are concerned.
///
/// One of the two negotiations §3.4 names, distilled out of `InitializeResponse` so the session
/// layer can keep it without keeping the whole response. Nothing here is inferred: `load_session`
/// is the wire's `agentCapabilities.loadSession`, and `prompt` is its `promptCapabilities` as it
/// arrived — ACP v1 defaults each missing field to `false`, which is the engine saying no.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Handshake {
    /// `agentCapabilities.loadSession`: the engine serves `session/load` (§6.2's resume).
    pub load_session: bool,
    /// `agentCapabilities.promptCapabilities`: the content a prompt may carry.
    pub prompt: PromptCapabilities,
}

impl Handshake {
    /// Read the handshake out of the engine's answer.
    pub fn of(response: &InitializeResponse) -> Self {
        Self {
            load_session: response.agent_capabilities.load_session,
            prompt: response.agent_capabilities.prompt_capabilities.clone(),
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
        Self {
            config_option_ids: response
                .config_options
                .iter()
                .flatten()
                .map(|option| option.id.to_string())
                .collect(),
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
        self.handshake.as_ref().map(|handshake| handshake.load_session)
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

/// One feature, with both halves of §3.4's row kept apart.
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
}

/// Why a feature nothing reported is not available.
const NO_NEGOTIATION: &str = "nothing has been negotiated for this session yet: there is no answer \
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
        NewSessionResponse, SessionConfigOption, SessionConfigSelectOption,
    };

    /// A handshake that says the three prompt capabilities and resume, spelled the way the wire
    /// spells them — the values P0 §2.1 measured the pinned OpenCode answering with.
    fn measured_handshake() -> Handshake {
        Handshake {
            load_session: true,
            prompt: PromptCapabilities::new()
                .image(true)
                .audio(false)
                .embedded_context(true),
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
        assert_eq!(row(&rows, HostFeature::ImageAttachments).finding, Finding::Available);
        assert_eq!(row(&rows, HostFeature::EmbeddedContext).finding, Finding::Available);
        assert_eq!(row(&rows, HostFeature::SessionResume).finding, Finding::Available);
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
        let before = report(|_| Capability::Advertised, Some(&SessionCapabilities::default()), None);
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
        assert_eq!(row(&with_commands, HostFeature::SlashCommands).finding, Finding::Available);
    }

    #[test]
    fn the_session_response_decides_the_options_and_the_model() {
        let named = negotiated(&["model", "mode"], None);
        let rows = report(|_| Capability::Advertised, Some(&named), Some("model"));
        assert_eq!(row(&rows, HostFeature::SessionConfigOptions).finding, Finding::Available);
        assert_eq!(row(&rows, HostFeature::ModelSelection).finding, Finding::Available);

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
        assert_eq!(row(&rows, HostFeature::SessionConfigOptions).finding, Finding::Available);
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
        assert_eq!(facts.has_slash_completions(), None);

        facts.negotiated(measured_handshake());
        assert_eq!(facts.supports_images(), Some(true));
        assert_eq!(facts.supports_audio(), Some(false));
        assert_eq!(facts.supports_embedded_context(), Some(true));
        assert_eq!(facts.supports_session_resume(), Some(true));
        assert_eq!(facts.has_slash_completions(), None, "no list has been published yet");

        facts.commands_published(0);
        assert_eq!(facts.has_slash_completions(), Some(false), "an empty list is an answer");
        facts.commands_published(2);
        assert_eq!(facts.has_slash_completions(), Some(true));
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
