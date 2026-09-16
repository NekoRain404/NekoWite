//! §3.4's capability row, end to end: what an installation declares, what the engine negotiated,
//! and which of the two the window is answered with.
//!
//! Everything but the window is real here, the way `agent_session_ipc_test.rs` has it: the engine is
//! the fixture, the runtime is the crate's, and the command is the `#[tauri::command]` function
//! `generate_handler!` names, called with the states a real app manages. Three fixture behaviours
//! are what make the interesting states reachable rather than imagined:
//!
//! - **`good`** answers the handshake P0 §2.1 measured, so every prompt fact is *reported* and the
//!   report has to say `available`.
//! - **`modest-handshake`** answers a handshake that reports none of them, while the registration
//!   still declares what the pinned version does. That is the disagreement §3.4's row is about, and
//!   the one a report must not resolve in the declaration's favour.
//! - **`two-in-one`** writes the `session/new` response and the command-list notification in a
//!   single read, which is the harshest ordering for the fact that arrives before the host has
//!   registered the session.
//!
//! The four claims this file exists for are the four the task states: a declaration is not an
//! answer, the negotiation is, nothing reported is not "unsupported", and an answer from an
//! incarnation that is over is not an answer at all.

use nekowite_lib::agent_runtime;
use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::commands;
use nekowite_lib::state;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

use agent_runtime::adapters::{Capability, HostFeature};
use agent_runtime::capabilities::{CapabilityReport, Finding};
use agent_runtime::driver;
use agent_runtime::events::AgentEventEnvelope;
use agent_runtime::registry::{AgentRegistration, AgentRegistry, EnvPolicy, InstallSource};
use agent_runtime::VaultFiles;
use commands::agent::{agent_open_session, AgentIpcState};
use commands::agent_capabilities::agent_session_capabilities;
use state::AgentRuntimeState;

/// No test here reads or writes a vault: the runtime's file capability is never exercised.
struct NoVault;

impl VaultFiles for NoVault {
    fn frontend_path(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("this test must not ask a window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("this test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("this test must not write a vault")
    }
}

/// The window side, for a test that never reads a note: no window is registered for any vault,
/// so a read would be refused rather than served from disk — the direction the seam is built to
/// fail in, which keeps a test that does not exercise reads honest about it.
struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

/// Generous enough that a slow machine does not flake, short enough that a genuine hang fails.
const PATIENCE: Duration = Duration::from_secs(10);

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-capabilities-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// A registration for the fixture engine, written the way §3.4.3 has a user write one: an absolute
/// path to a program, and the arguments as an array.
///
/// `adapter_id` is a parameter because it is what the *declaration* comes from: `opencode` is the
/// verified adapter (so its claims describe the pinned version), and `generic_acp` is the adapter
/// that answers `Unverified` to every feature by design.
fn fixture_agent(agent_id: &str, behaviour: &str, adapter_id: &str) -> AgentRegistration {
    AgentRegistration {
        agent_id: agent_id.to_string(),
        display_name: format!("Fake {agent_id}"),
        source: InstallSource::External,
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            behaviour.to_string(),
        ],
        env: EnvPolicy::UserEnvironment,
        env_extra: Vec::new(),
        enabled: true,
        adapter_id: adapter_id.to_string(),
        reported_version: None,
    }
}

/// One started engine, wired the way `agent_start` wires it.
struct Wired {
    app: tauri::App<tauri::test::MockRuntime>,
    /// The engine's own frames, collected. Nothing here asserts on them; the sink exists because
    /// `install` requires one — a runtime with no reader would drop what the engine sends.
    _received: Arc<Mutex<Vec<AgentEventEnvelope>>>,
    /// Kept so a test can start a *second* incarnation of the same engine after the first ends. The
    /// fixture answers the same session id every time, which is what gives "re-derived" something to
    /// fail against.
    registry: AgentRegistry,
    managed_root: PathBuf,
    vault_root: PathBuf,
}

impl Wired {
    fn ipc(&self) -> tauri::State<'_, AgentIpcState> {
        self.app.state::<AgentIpcState>()
    }

    fn runtime(&self) -> tauri::State<'_, AgentRuntimeState> {
        self.app.state::<AgentRuntimeState>()
    }

    fn vaults(&self) -> tauri::State<'_, state::VaultRegistry> {
        self.app.state::<state::VaultRegistry>()
    }

    /// The session the commands address.
    fn session(&self) -> driver::Session {
        self.ipc().session().expect("a session is installed")
    }
}

/// Starts one fixture engine and installs the session the commands address.
///
/// The engine is deliberately *not* initialized here: `open_session` is what negotiates the
/// handshake on the app's path (`AgentRuntime::open_session` → `negotiate`), so a test that
/// initialized in advance would be asserting about a route no window takes.
async fn wired(label: &str, behaviour: &str, adapter_id: &str) -> Wired {
    let dir = temp_dir(label);
    let vault_root = dir.join("vault");
    fs::create_dir_all(&vault_root).expect("the vault directory");

    let app = tauri::test::mock_app();
    app.manage(AgentIpcState::default());
    app.manage(AgentRuntimeState::default());
    app.manage(state::VaultRegistry::default());
    let vaults = app.state::<state::VaultRegistry>();
    vaults
        .approve_pick(&vault_root.to_string_lossy())
        .expect("the user picked this folder");
    vaults
        .register(&vault_root.to_string_lossy(), None)
        .expect("and it is now the open vault");

    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    registry
        .register(fixture_agent("fake", behaviour, adapter_id))
        .expect("registers");
    registry.bind_profile("prof", "fake").expect("binds");

    let mut instance = registry
        .start(
            "fake",
            "prof",
            "vault-1",
            &dir,
            &agent_runtime::profile::Credentials::default(),
            Arc::new(NoVault),
            LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
        )
        .await
        .expect("the fixture engine starts");

    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    // The model option id is the adapter's answer, read the way `agent_start` reads it: `None` for
    // an engine with no verified adapter, which is what makes ModelSelection unverifiable there
    // rather than unavailable.
    let model_option_id = registry
        .get("fake")
        .and_then(|registration| registration.adapter())
        .and_then(|adapter| adapter.model_option_id())
        .map(str::to_string);
    let session = driver::install(&mut instance, model_option_id, move |envelope| {
        sink.lock().unwrap().push(envelope);
    })
    .expect("the session installs");
    app.state::<AgentIpcState>().install(session);
    *app.state::<AgentRuntimeState>().instance.lock().unwrap() = Some(instance);

    Wired {
        app,
        _received: received,
        registry,
        managed_root: dir,
        vault_root,
    }
}

async fn open(wired: &Wired) -> String {
    agent_open_session(
        wired.vaults(),
        wired.ipc(),
        "vault-1".to_string(),
        wired.vault_root.to_string_lossy().into_owned(),
    )
    .await
    .expect("the fixture engine opens a session")
    .session_id
}

/// The report for `session_id`, as the window asks for it.
fn report(wired: &Wired, session_id: &str) -> Vec<CapabilityReport> {
    agent_session_capabilities(wired.runtime(), wired.ipc(), session_id.to_string())
        .expect("a session this host opened has a capability report")
}

/// The report, retried until it says what the test is waiting for.
///
/// The command list is published as a notification *after* `session/new` answers, and it is the
/// driver's other task that records it — so a test that read once would be racing the very thing it
/// asserts, the reason `agent_session_ipc_test.rs` waits for its states too.
async fn settled(
    wired: &Wired,
    session_id: &str,
    until: impl Fn(&[CapabilityReport]) -> bool,
) -> Vec<CapabilityReport> {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let rows = report(wired, session_id);
        if until(&rows) {
            return rows;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the engine's facts never arrived: {rows:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn row<'a>(rows: &'a [CapabilityReport], feature: HostFeature) -> &'a CapabilityReport {
    rows.iter()
        .find(|entry| entry.feature == feature.as_str())
        .unwrap_or_else(|| panic!("{} has no row", feature.as_str()))
}

fn takes_commands(rows: &[CapabilityReport]) -> bool {
    row(rows, HostFeature::SlashCommands).finding == Finding::Available
}

// --- The report, from the window's side ---

#[tokio::test]
async fn the_report_has_a_row_for_every_feature_and_keeps_the_two_halves_apart() {
    // The measured handshake reports `image`, `embeddedContext` and `loadSession`; the session
    // response returns the `model` option; the engine publishes two commands. Every one of those is
    // a row, and every row carries the declaration *beside* the finding rather than folded into it.
    let wired = wired(
        "declared",
        "good",
        agent_runtime::adapters::opencode::ADAPTER_ID,
    )
    .await;
    let session_id = open(&wired).await;
    let rows = settled(&wired, &session_id, takes_commands).await;

    let features: Vec<&str> = rows.iter().map(|entry| entry.feature).collect();
    assert_eq!(
        features,
        HostFeature::ALL.map(|feature| feature.as_str()),
        "one row per feature, in the host's own order, and none invented"
    );

    // Reported by the engine's handshake, so available — and the declaration is a separate field
    // that happens to agree here.
    for feature in [
        HostFeature::ImageAttachments,
        HostFeature::EmbeddedContext,
        HostFeature::SessionResume,
    ] {
        let entry = row(&rows, feature);
        assert_eq!(entry.finding, Finding::Available, "{}", entry.feature);
        assert_eq!(entry.declared, Capability::Advertised, "{}", entry.feature);
    }

    // What the pinned engine was declared *not* to do, and what the handshake then confirmed: both
    // fields say no, each for its own reason. The declaration is a claim about the pinned version;
    // the finding is this engine's own answer.
    let audio = row(&rows, HostFeature::AudioAttachments);
    assert_eq!(audio.declared, Capability::NotAdvertised);
    assert!(
        matches!(&audio.finding, Finding::Unavailable { detail } if detail.contains("promptCapabilities.audio")),
        "the finding names the fact the engine did not report: {:?}",
        audio.finding
    );
}

#[tokio::test]
async fn a_declared_capability_the_engine_did_not_negotiate_is_not_available() {
    // The point of §3.4's row: 「安装声明仅用于启动提示」. The registration is the OpenCode adapter — so
    // the declaration says `Advertised` for images, embedded context and resume — while the engine's
    // own handshake reports none of them. The declaration is reported as what it is, and the finding
    // is the engine's answer, which is no.
    let wired = wired(
        "modest",
        "modest-handshake",
        agent_runtime::adapters::opencode::ADAPTER_ID,
    )
    .await;
    let session_id = open(&wired).await;
    let rows = settled(&wired, &session_id, takes_commands).await;

    for feature in [
        HostFeature::ImageAttachments,
        HostFeature::EmbeddedContext,
        HostFeature::SessionResume,
    ] {
        let entry = row(&rows, feature);
        assert_eq!(
            entry.declared,
            Capability::Advertised,
            "{}: the declaration describes the pinned version",
            entry.feature
        );
        assert!(
            matches!(&entry.finding, Finding::Unavailable { detail } if detail.contains("handshake")),
            "{}: declared, but nothing negotiated it — so it is unavailable, not available: {:?}",
            entry.feature,
            entry.finding
        );
    }

    // The same engine's session *did* answer the rest of what it offers, so the two halves disagree
    // feature by feature rather than wholesale: the join is per feature, not a mood.
    assert_eq!(
        row(&rows, HostFeature::SessionConfigOptions).finding,
        Finding::Available
    );
}

#[tokio::test]
async fn the_session_response_and_the_published_list_are_what_make_the_rest_available() {
    // `two-in-one` writes the `session/new` response and the command notification in one read: the
    // list is therefore dispatched while the session is still unregistered, which is the ordering P0
    // §2.2 measured and the one a capability answer has to survive. `model` is both the option the
    // adapter names and the one the fixture returns, so ModelSelection is confirmed by the session
    // itself rather than by the adapter's guess.
    let wired = wired(
        "session",
        "two-in-one",
        agent_runtime::adapters::opencode::ADAPTER_ID,
    )
    .await;
    let session_id = open(&wired).await;
    let rows = settled(&wired, &session_id, takes_commands).await;

    assert_eq!(
        row(&rows, HostFeature::SessionConfigOptions).finding,
        Finding::Available,
        "`session/new` returned an option list"
    );
    assert_eq!(
        row(&rows, HostFeature::ModelSelection).finding,
        Finding::Available,
        "the option the adapter names is one the session returned"
    );
    assert_eq!(
        row(&rows, HostFeature::SlashCommands).finding,
        Finding::Available,
        "the published list held two commands, even though it arrived before the session was \
         registered"
    );
}

#[tokio::test]
async fn an_engine_with_no_verified_adapter_is_unverified_rather_than_unsupported() {
    // §3.4.6's third state, from the other side: `generic_acp` declares nothing and names no model
    // option, so none of this may be called unsupported — including the model selector, whose option
    // id no adapter claimed to know. "We have not measured this engine" must not reach a page as
    // "this engine cannot".
    let wired = wired(
        "generic",
        "good",
        agent_runtime::adapters::generic_acp::ADAPTER_ID,
    )
    .await;
    let session_id = open(&wired).await;
    let rows = settled(&wired, &session_id, takes_commands).await;

    for entry in &rows {
        assert_eq!(entry.declared, Capability::Unverified, "{}", entry.feature);
    }
    let model = row(&rows, HostFeature::ModelSelection);
    assert!(
        matches!(&model.finding, Finding::Unverified { detail } if detail.contains("names no configuration option")),
        "{:?}",
        model.finding
    );
    // And what the engine *did* report is still reported: an unknown adapter is not a reason to throw
    // away the handshake's own answer.
    assert_eq!(
        row(&rows, HostFeature::ImageAttachments).finding,
        Finding::Available
    );
}

#[tokio::test]
async fn a_session_this_host_never_opened_has_no_capability_answer() {
    // §6.1: an id the host did not receive is not one it answers about. The capability report is one
    // more surface a forged id would otherwise read state out of.
    let wired = wired(
        "unknown",
        "good",
        agent_runtime::adapters::opencode::ADAPTER_ID,
    )
    .await;
    let refusal = agent_session_capabilities(
        wired.runtime(),
        wired.ipc(),
        "ses_somebody_elses".to_string(),
    )
    .expect_err("this host never opened that session");
    assert!(refusal.contains("not one this app opened"), "{refusal}");
}

#[tokio::test]
async fn an_answer_from_an_incarnation_that_is_over_is_not_an_answer() {
    // §3.4's 「重连和版本变化后重新检测」, at the boundary that enforces it. The instance slot is emptied
    // the way `agent_stop` empties it — the session handle is still installed, and the runtime still
    // holds everything the engine reported — and the report must nonetheless answer `unverified`: a
    // fact from a runtime that is over is not a fact about the one in front of the user, and
    // repeating it would be the claim §3.4 forbids.
    let wired = wired(
        "superseded",
        "good",
        agent_runtime::adapters::opencode::ADAPTER_ID,
    )
    .await;
    let session_id = open(&wired).await;
    let live = settled(&wired, &session_id, takes_commands).await;
    assert_eq!(
        row(&live, HostFeature::ImageAttachments).finding,
        Finding::Available,
        "while this incarnation is the live one, the engine's own answer is reported"
    );

    let session = wired.session();
    let facts = session
        .runtime
        .capabilities(&session_id)
        .expect("the session is one this runtime opened")
        .expect("the runtime still holds what the engine reported");
    assert_eq!(
        facts.command_count(),
        Some(2),
        "and the published list is among them"
    );

    let ended = wired.runtime().instance.lock().unwrap().take();
    assert!(ended.is_some(), "the incarnation is the app's to end");
    drop(ended);

    let rows = report(&wired, &session_id);
    assert_eq!(
        rows.len(),
        HostFeature::ALL.len(),
        "still a row for every feature"
    );
    for entry in &rows {
        assert_eq!(entry.declared, Capability::Unverified, "{}", entry.feature);
        assert!(
            matches!(&entry.finding, Finding::Unverified { detail } if detail.contains("no answer to report")),
            "{} still answered from a runtime that is over: {:?}",
            entry.feature,
            entry.finding
        );
    }
}

#[tokio::test]
async fn a_new_incarnation_rediscovers_rather_than_inheriting() {
    // The fixture answers `ses_fake_1` for every process it runs, which is what makes this testable:
    // a session id is not what the facts are keyed to across incarnations. A second engine is a new
    // `runtimeEpoch` and a new runtime, with nothing to say about a session it was never asked
    // about — even though the incarnation before it reported a great deal about that same id.
    let wired = wired(
        "rederived",
        "good",
        agent_runtime::adapters::opencode::ADAPTER_ID,
    )
    .await;
    let session_id = open(&wired).await;
    let first_epoch = wired.session().identity.runtime_epoch.clone();
    settled(&wired, &session_id, takes_commands).await;
    assert!(wired
        .session()
        .runtime
        .capabilities(&session_id)
        .expect("opened by this runtime")
        .is_some());

    // The first incarnation ends the way `agent_stop` ends one: the instance goes, the registration
    // is free again, and the engine is asked to exit.
    drop(wired.runtime().instance.lock().unwrap().take());

    let second = wired
        .registry
        .start(
            "fake",
            "prof",
            "vault-1",
            &wired.managed_root,
            &agent_runtime::profile::Credentials::default(),
            Arc::new(NoVault),
            LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
        )
        .await
        .expect("the registration is free again, so a second engine starts");
    assert_ne!(
        second.identity().runtime_epoch,
        first_epoch,
        "a start mints a new incarnation, which is what makes the previous answer stale"
    );
    assert!(
        second.runtime().capabilities(&session_id).is_err(),
        "the new runtime does not answer about a session it never opened, even under the same id"
    );
    second.shutdown();
}

// --- The pieces the tests above do not reach ---

#[test]
fn every_feature_has_a_name_the_two_sides_share() {
    // The names are data (a page renders them rather than translating them), so they are pinned
    // here: a rename is a change on this side and in the TypeScript contract, and this is where the
    // Rust half says which spelling it has.
    let names: Vec<&str> = HostFeature::ALL
        .iter()
        .map(|feature| feature.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "session-resume",
            "slash-commands",
            "model-selection",
            "image-attachments",
            "audio-attachments",
            "session-config-options",
            "embedded-context",
        ]
    );
}

#[test]
fn the_fixture_answers_the_behaviours_this_file_drives() {
    // A behaviour string the fixture does not know falls through to the measured handshake, so a
    // typo would make `modest-handshake`'s test pass for the wrong reason — it would be measuring a
    // handshake that was never sent. The arms are read off the fixture rather than assumed.
    let fixture = fs::read_to_string(fixture_script()).expect("the fixture is in the tree");
    for behaviour in ["modest-handshake)", "two-in-one"] {
        assert!(
            fixture.contains(behaviour),
            "the fixture no longer answers `{behaviour}`, so what this file asserts about \
             declarations, negotiations and orderings is no longer exercised"
        );
    }
}
