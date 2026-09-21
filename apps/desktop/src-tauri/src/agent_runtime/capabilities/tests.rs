//! `capabilities`' own tests: the join, the predicates, and the host's half of the row.
//!
//! **Why it is a file of its own.** It was the bottom of `capabilities.rs`, which passed the
//! 600-line budget `docs/dev.md:286` puts on a business source file, and it is the largest reason
//! that file was over it: the report, the four modules it now draws on and the tests that hold all
//! of them were one file. Nothing here changed but the module it is declared in — every test body is
//! the one that was there.
//!
//! **The imports whose paths moved.** `AuthMethod`, `Implementation` and `PromptCapabilities` used
//! to arrive through the parent's `use super::*` from the parent's own wire import, and `unavailable`
//! was a private function of the parent that the `*` found. Both moved one module down when the code
//! under test was split, so this file names them where they live now. No assertion, message or
//! ordering moved with them.

use super::finding::unavailable;
use super::*;
use agent_client_protocol::schema::v1::{
    AuthMethod, AuthMethodAgent, Implementation, NewSessionResponse, PromptCapabilities,
    SessionConfigOption, SessionConfigSelectOption,
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
    let manifest =
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs"))
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
