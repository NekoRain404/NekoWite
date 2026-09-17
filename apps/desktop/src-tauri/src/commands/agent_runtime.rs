//! The runtime readout: what this app's engine connection *is*, as one settings page reads it.
//!
//! §3.1.4 asks the settings surface to state 「当前版本、来源、实际路径、协议状态、更新状态」 and forbids the
//! one substitution that reads as a lie — 「不把"进程就绪"显示为"模型可用"」. The registry answers four of
//! those six facts already (`agent_registry_read`: version, source, path, and the engine's own words
//! about itself), and this file is the other two: **protocol state**, and the capability report the
//! handshake is the first half of. Before it existed, nothing answered either for a caller with no
//! session — which is exactly the caller a settings dialog is.
//!
//! ## Why this needs no session, and why that is not a shortcut
//!
//! `agent_session_capabilities` is the session-scoped read: it joins one session's negotiation with
//! the installation's declaration, and it refuses an id this host never opened. The handshake,
//! though, is not session-scoped at all — ACP makes `initialize` a connection's *first* request, so
//! one runtime incarnation reads it once and every session on that process shares the answer
//! ([`AgentRuntime::handshake`]). A caller that has the incarnation therefore has the handshake, and
//! the settings dialog has one: the instance slot is app state, not session state.
//!
//! So this command reads the same two things `agent_registry_read` reads — the registry, which owns
//! the definition, and the instance slot, which owns the process — and joins them. It adds no fact
//! of its own; the one decision it makes is which of the two answers the capability report's
//! declaration half and the negotiated half come from.
//!
//! ## What it deliberately does not answer
//!
//!  - **Whether the engine is authorized.** No ACP field carries it. The handshake's `auth_methods`
//!    is a list of ways the engine says it *could* be authenticated, and this host never calls
//!    `authenticate` at all (`grep -rn "AuthenticateRequest" src/` → nothing) — so "authenticated"
//!    is a state nothing here can be in, and a page that drew one would be inventing it. What is
//!    reported instead is the engine's own advertisement, labelled as one
//!    ([`AuthMethodReadout`]).
//!  - **Whether an update is available.** `update.rs` says so itself: it owns the gate a candidate
//!    must pass and not 「which of their releases a network should be asked about」. What this host
//!    can answer is the *policy* the provenance implies
//!    (`registry::InstallSource::update_policy`), which is the pair of answers the page draws.
//!
//! ## Two things the capability rows are read against, named here
//!
//! The rows are `report`'s own, not a second derivation: the declaration comes from the
//! registration's adapter (a fact about the pinned version, which is true whether or not anything
//! is running) and the negotiated half from this incarnation's handshake. Three of the eleven
//! (`HostFeature`'s session config options, model selection and the published command list) are
//! facts about a *session response*, so with no session they are `unverified` with the reason
//! `report` already writes for them. That is the honest arm, and it is not the same answer as
//! "unsupported".

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::agent_runtime::capabilities::{report, CapabilityReport, Handshake};
use crate::agent_runtime::registry::{AgentInstance, AgentRegistration, AgentRegistry};
use crate::state::{registry_of, AgentRuntimeState};

/// The engine's own name for itself, as its handshake reported it.
///
/// `id` and `name` only. The wire carries an optional description and a `_meta` bag beside them,
/// and neither is rendered anywhere: a page that drew the description would be showing prose the
/// engine wrote for a caller it has never met, and nothing in this app reads `_meta` at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodReadout {
    pub id: String,
    pub name: String,
}

/// What the handshake said, or why there is none.
///
/// A tagged union rather than an `Option`, and for the reason every other readout in this tree
/// draws one: "nothing has been negotiated" is a *state a page must render with its reason* (§5.2),
/// and `None` would leave the page composing a reason out of other fields — which is §3.2's
/// 「页面应被告知，而不是让它自己知道」 seen from the wrong side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum HandshakeReadout {
    /// This incarnation answered `initialize`, and these are the fields a page can draw.
    Read {
        /// The version the engine answered with. Kept because this host *has* it —
        /// `InitializeResponse::protocol_version` — and until this arm existed the whole response
        /// was discarded after [`Handshake::of`] read three of its fields. Zed drops this value on
        /// the floor (`agent_servers/src/acp.rs:1007`: a `< V1` check and nothing else), so there is
        /// no upstream surface to copy; §3.1.4's 「协议状态」 is this project's own requirement.
        protocol_version: u16,
        /// `agentInfo.name`, when the engine sent one. Absent is a fact about the engine, not a
        /// failure: ACP documents the field as optional and the schema notes it will become required
        /// in a later version.
        agent_name: Option<String>,
        /// `agentInfo.version`, under the same rule.
        agent_version: Option<String>,
        /// `authMethods`, verbatim. Reported, and acted on by nothing here — see the module note.
        auth_methods: Vec<AuthMethodReadout>,
    },
    /// Nothing has been negotiated in this runtime. `reason` says which of the two states this
    /// host is in, because they send a user to different places.
    NotRead { reason: HandshakeAbsent },
}

/// Why nothing has been negotiated — **an id, not a sentence**.
///
/// The page's copy tree owns the sentences a user reads (`RegistryRefusal` and `SkillRefusal` are
/// the same shape, and both say why), and this one matters here more than on most wires: the whole
/// point of the arm is that a page must not *derive* the reason from `process`, so the host has to
/// name it — and the name it can honestly give is one of exactly two states of its own lifecycle.
/// A prose field would have put an English sentence in the middle of a Chinese page for no gain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandshakeAbsent {
    /// No engine has been started for a folder, so nothing has answered anything.
    NoEngine,
    /// The engine is running and has not been asked yet: this app performs `initialize` when it
    /// opens a session, and no session has been opened in this runtime. Reachable, and reachable
    /// *before* the first session in every run — which is exactly the state the old page drew a
    /// protocol line for.
    NotYet,
}

/// Everything the runtime page draws, in one answer.
///
/// One call rather than three, for the reason `RegistryReadout` is one: the page draws all of it
/// together, and a second call would be a second read of one runtime's state that could disagree
/// with the first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReadout {
    pub agent_id: String,
    pub display_name: String,
    /// `bundled` / `managed` / `external` — the spelling `RegistryEntry` uses, from
    /// [`InstallSource::id`], so the two pages name one provenance one way.
    pub source: &'static str,
    /// The absolute path the process was or would be started from.
    pub program: String,
    /// What the program reported about itself, as the last diagnostic left it. `None` is "nothing
    /// has asked it", which is what the page draws as such.
    pub reported_version: Option<String>,
    pub adapter_id: String,
    /// **`ready` or `stopped`, and those are the only two.**
    ///
    /// The page's readout used to carry four arms — `stopped | starting | ready | failed` — of
    /// which this host can answer two. A start in flight is not a state anything can be read in
    /// (the slot is filled only once `Registry::start` has returned, and a start that fails returns
    /// its refusal to the caller rather than leaving a state behind), so `starting` and `failed`
    /// were two arms no code path could produce: a fixed shape asserting fields that do not exist,
    /// which is the defect this readout was rebuilt to remove.
    pub process: &'static str,
    /// `host-managed` / `reported-only`, from the registration's provenance. Not "an update is
    /// available" — see the module note.
    pub update_policy: &'static str,
    pub handshake: HandshakeReadout,
    /// One row per `HostFeature`, or empty when there is no handshake to read them off — in which
    /// case `handshake`'s own `NotRead` arm says why, and the page draws that sentence in their
    /// place rather than an empty list.
    pub capabilities: Vec<CapabilityReport>,
}

/// The definitions, the live process, and the join between them.
///
/// The gates are the same three `agent_registry_read` sits behind, and for the same reason: the
/// registry is built lazily from the app's own data directory, so a settings page that could not
/// read before a session started would be a page that only worked in one order.
#[tauri::command]
pub fn agent_runtime_read(
    app: AppHandle,
    runtime_state: State<'_, AgentRuntimeState>,
) -> Result<RuntimeReadout, String> {
    let managed = crate::storage::key_store::data_dir(&app)?;
    let registry = registry_of(&runtime_state, &managed)?;
    let instance = runtime_state
        .instance
        .lock()
        .map_err(|_| "the agent runtime state was poisoned by a panic".to_string())?;
    readout_of(&registry, instance.as_ref())
}

/// The join, split from the command so its rules can be driven without a Tauri app.
///
/// Two resolutions and no third:
///
/// 1. **The engine this page is about is the one a new session would start on.** §3.4.1 fixes that
///    as the registry's default, and `start_session` is the only production caller of a start — it
///    reads `default_agent_id` too, so the page and the process are about the same engine by
///    construction rather than by convention.
/// 2. **The process is the slot, not the registry's live list.** They are claimed and released by
///    the same two events, and reading the slot is what keeps `process` and `handshake` from ever
///    disagreeing: both come from the one value that holds the runtime. An instance started for
///    another agent is not this page's, and is not reported as this engine's process.
///
/// A registry whose default names no registration is a refusal rather than a readout with blanks in
/// it: that state cannot be drawn honestly, and the page's answer to a rejection is its own
/// unreadable state with a retry.
pub fn readout_of(
    registry: &AgentRegistry,
    instance: Option<&AgentInstance>,
) -> Result<RuntimeReadout, String> {
    let agent_id = registry.default_agent_id().to_string();
    let registration = registry.get(&agent_id).ok_or_else(|| {
        format!("the engine this app starts, `{agent_id}`, has no registration to read")
    })?;
    let live = instance.filter(|instance| instance.identity().agent_id == agent_id);
    let handshake = live.and_then(|instance| instance.runtime().handshake());
    Ok(RuntimeReadout {
        agent_id: agent_id.clone(),
        display_name: registration.display_name.clone(),
        source: registration.source.id(),
        program: registration.program.to_string_lossy().into_owned(),
        reported_version: registration.reported_version.clone(),
        adapter_id: registration.adapter_id.clone(),
        process: if live.is_some() { "ready" } else { "stopped" },
        update_policy: match registration.source.update_policy() {
            crate::agent_runtime::registry::UpdatePolicy::HostManaged => "host-managed",
            crate::agent_runtime::registry::UpdatePolicy::ReportedOnly => "reported-only",
        },
        capabilities: match &handshake {
            Some(handshake) => capability_rows(registration, handshake),
            None => Vec::new(),
        },
        handshake: handshake_readout(live.is_some(), handshake),
    })
}

/// The handshake's arm, and the only place the two absences are told apart.
///
/// `running` is "this engine is the one in the instance slot", which is what separates the two
/// absences: a live process that has not been asked yet, and no process at all.
fn handshake_readout(running: bool, handshake: Option<Handshake>) -> HandshakeReadout {
    match handshake {
        Some(handshake) => HandshakeReadout::Read {
            protocol_version: handshake.protocol_version,
            agent_name: handshake
                .agent
                .as_ref()
                .map(|implementation| implementation.name.clone()),
            agent_version: handshake
                .agent
                .as_ref()
                .map(|implementation| implementation.version.clone()),
            auth_methods: handshake
                .auth_methods
                .iter()
                .map(|method| AuthMethodReadout {
                    id: method.id().to_string(),
                    name: method.name().to_string(),
                })
                .collect(),
        },
        None if running => HandshakeReadout::NotRead {
            reason: HandshakeAbsent::NotYet,
        },
        None => HandshakeReadout::NotRead {
            reason: HandshakeAbsent::NoEngine,
        },
    }
}

/// The capability report, read against what this host actually holds.
///
/// The negotiated half is a [`SessionCapabilities`] with the handshake in it and nothing else — no
/// session response, no published command list — which is precisely this caller's situation. It is
/// built rather than looked up because there is no session to look one up by, and it is not a
/// forgery: every predicate on the type answers `None` for a fact that has not arrived, so the three
/// session-scoped features come out `unverified` with `report`'s own sentence for it while the eight
/// the handshake answers come out as what the engine said.
fn capability_rows(
    registration: &AgentRegistration,
    handshake: &Handshake,
) -> Vec<CapabilityReport> {
    let mut facts = crate::agent_runtime::capabilities::SessionCapabilities::default();
    facts.negotiated(handshake.clone());
    let adapter = registration.adapter();
    report(
        |feature| registration.declared_capability(feature),
        Some(&facts),
        adapter.and_then(|adapter| adapter.model_option_id()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::adapters::{Capability, HostFeature};
    use crate::agent_runtime::capabilities::{Finding, SessionManagement};
    use crate::agent_runtime::registry::{EnvPolicy, InstallSource};
    use agent_client_protocol::schema::v1::{
        AuthMethod, AuthMethodAgent, Implementation, PromptCapabilities,
    };
    use std::path::PathBuf;

    /// The handshake the pinned engine's fixture carries, field for field
    /// (`tests/fixtures/agent/fake_agent.sh:25`): `protocolVersion` 1, one auth method, an
    /// `agentInfo`, and all four `sessionCapabilities` sub-objects present.
    fn measured() -> Handshake {
        Handshake {
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
            session: SessionManagement {
                list: true,
                resume: true,
                close: true,
                fork: true,
            },
        }
    }

    fn registration() -> AgentRegistration {
        AgentRegistration {
            agent_id: "bundled-engine".to_string(),
            display_name: "NekoWite's engine".to_string(),
            source: InstallSource::Bundled,
            program: PathBuf::from("/opt/nekowite/binaries/opencode"),
            args: vec!["acp".to_string()],
            env: EnvPolicy::ProfileIsolated,
            env_extra: Vec::new(),
            enabled: true,
            adapter_id: "opencode".to_string(),
            reported_version: Some("1.18.29".to_string()),
        }
    }

    fn row(rows: &[CapabilityReport], feature: HostFeature) -> &CapabilityReport {
        rows.iter()
            .find(|row| row.feature == feature.as_str())
            .expect("every feature has a row")
    }

    #[test]
    fn the_two_reasons_a_handshake_is_missing_are_told_apart() {
        // The whole point of the `NotRead` arm: a page is *told* which state this is, rather than
        // deciding from `process` — which is derived from the same slot and could not tell these
        // two apart anyway if it wanted to, because an engine running before its first session is
        // `ready`. The two are different sentences in the page's catalogue, reached by these ids.
        assert_eq!(
            handshake_readout(false, None),
            HandshakeReadout::NotRead {
                reason: HandshakeAbsent::NoEngine
            }
        );
        assert_eq!(
            handshake_readout(true, None),
            HandshakeReadout::NotRead {
                reason: HandshakeAbsent::NotYet
            }
        );
        // And the wire spells them the way the page's catalogue keys them: an id, never prose.
        assert_eq!(
            serde_json::to_value(HandshakeAbsent::NoEngine).unwrap(),
            serde_json::json!("no-engine")
        );
        assert_eq!(
            serde_json::to_value(HandshakeAbsent::NotYet).unwrap(),
            serde_json::json!("not-yet")
        );
    }

    #[test]
    fn a_read_handshake_carries_the_fields_the_page_draws() {
        let read = handshake_readout(true, Some(measured()));
        let HandshakeReadout::Read {
            protocol_version,
            agent_name,
            agent_version,
            auth_methods,
        } = read
        else {
            panic!("a handshake that was read is the Read arm: {read:?}");
        };
        // The version the whole arm exists for: `Handshake::of` used to discard it.
        assert_eq!(protocol_version, 1);
        assert_eq!(agent_name.as_deref(), Some("FakeAgent"));
        assert_eq!(agent_version.as_deref(), Some("0.0.1"));
        assert_eq!(
            auth_methods,
            vec![AuthMethodReadout {
                id: "fake-login".to_string(),
                name: "Fake login".to_string(),
            }],
            "the engine's advertisement, verbatim"
        );
    }

    #[test]
    fn a_handshake_without_an_agent_info_is_not_a_failure() {
        // ACP documents `agentInfo` as optional and says it becomes required later, so an engine
        // that omits it is answering, not failing — the two fields are `None` and the arm is still
        // `Read`. Folding that into `NotRead` would tell a user nothing was negotiated when the
        // protocol version right beside it says otherwise.
        let mut handshake = measured();
        handshake.agent = None;
        let read = handshake_readout(true, Some(handshake));
        let HandshakeReadout::Read {
            agent_name,
            agent_version,
            protocol_version,
            ..
        } = read
        else {
            panic!("a handshake without agentInfo was still read");
        };
        assert_eq!(protocol_version, 1);
        assert_eq!(agent_name, None);
        assert_eq!(agent_version, None);
    }

    #[test]
    fn the_capability_rows_are_the_handshakes_half_plus_the_reason_for_the_rest() {
        let rows = capability_rows(&registration(), &measured());
        assert_eq!(
            rows.len(),
            HostFeature::ALL.len(),
            "the report is the feature list rather than the features that happened to answer"
        );

        // Eight come off the handshake, which this caller *has*.
        for feature in [
            HostFeature::SessionResume,
            HostFeature::SessionList,
            HostFeature::SessionResumeWithoutHistory,
            HostFeature::SessionClose,
            HostFeature::SessionFork,
            HostFeature::ImageAttachments,
            HostFeature::EmbeddedContext,
        ] {
            assert_eq!(
                row(&rows, feature).finding,
                Finding::Available,
                "{}",
                feature.as_str()
            );
        }
        // `audio` is the one the engine said no to, and the detail says so rather than the host
        // guessing.
        assert!(matches!(
            &row(&rows, HostFeature::AudioAttachments).finding,
            Finding::Unavailable { detail } if detail.contains("audio")
        ));

        // Three are facts about a *session response*, and this caller has no session. They are
        // `unverified` — not `unavailable`, which would be this page claiming the engine cannot.
        for feature in [
            HostFeature::SessionConfigOptions,
            HostFeature::ModelSelection,
            HostFeature::SlashCommands,
        ] {
            assert!(
                matches!(
                    &row(&rows, feature).finding,
                    Finding::Unverified { detail } if !detail.is_empty()
                ),
                "{} came out as something other than unverified: {:?}",
                feature.as_str(),
                row(&rows, feature).finding
            );
        }

        // The declaration half is still the adapter's, reported beside the finding and never
        // folded into it — the pinned OpenCode advertises audio and did not report supporting it.
        assert_eq!(
            row(&rows, HostFeature::AudioAttachments).declared,
            Capability::NotAdvertised
        );
    }
}
