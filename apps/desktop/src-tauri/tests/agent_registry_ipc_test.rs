//! The registry's IPC surface — the window's half of §3.4's definitions.
//!
//! T13a delivered the settings page against a port (`read` / `add` / `setEnabled`), and until this
//! file's subject existed nothing in a window could add, enable or disable an engine: the page's
//! three calls had no command behind them. What is held down here is the shape those commands
//! answer in, the two failure channels, and the three decisions a *request* may not make.
//!
//! Three properties are the reason the cases are grouped this way rather than one per function:
//!
//! 1. **The wire shape is the page's vocabulary.** The readout and the refusals are asserted through
//!    `serde_json`, not through the Rust structs, because the renderer sees JSON: a renamed field
//!    would keep every Rust assertion green and leave the page with a blank row. `program` is the
//!    case that already differs (`path` on the wire, because the field a form points at is the one
//!    the user typed into), and `env_extra` is an object per variable rather than a pair.
//! 2. **A refusal and an exception are two channels.** A refusal is a value from a call that
//!    completed — `Ok(Some(…))`, the facts as data, which the page renders with its own sentences.
//!    An `Err` is a call that did not run at all: a registry that cannot be built (no engine beside
//!    the executable) or one an in-flight start is holding. The difference is what tells a user
//!    whether to fix a field or to retry, so both are asserted, and the blocked case is asserted to
//!    have changed nothing.
//! 3. **Registration is not a sandbox, and not a shell.** A draft is validated for what `execve`
//!    can carry (an id that can be a directory name, an absolute path, an argument array with no
//!    NUL in it, an adapter id this build answers to) and for nothing else. A program that is not
//!    *there* is reported as a state rather than refused, because a bundled sidecar that has not
//!    been built yet is normal to report — and no function on this surface takes a string that
//!    could be split on spaces.
//!
//! The last two cases are the ones a definition alone cannot answer: they start the fixture engine,
//! so what is asserted is about a process. `the_profiles_credentials_reach_the_engine_at_launch` is
//! Gap 2's end-to-end evidence — the value is read out of the *child's* environment, by the child,
//! which is the only thing that distinguishes "the launch described a credential" from "the engine
//! has one".

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use nekowite_lib::agent_runtime::adapters;
use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::profile::Credentials;
use nekowite_lib::agent_runtime::registry::{
    AgentInstance, AgentRegistration, AgentRegistry, EnvPolicy, InstallSource, RegistryError,
};
use nekowite_lib::agent_runtime::secret::Secret;
use nekowite_lib::agent_runtime::TransportError;
use nekowite_lib::agent_runtime::VaultFiles;
use nekowite_lib::commands::agent_registry::{
    add_agent, read_registry, refusal_view, set_enabled, AgentDraft, RegistryReadout,
    RegistryRefusal,
};
use nekowite_lib::state::{edit_registry, AgentRuntimeState};

/// The fixture engine (`tests/fixtures/agent/fake_agent.sh`) — T2's, unmodified apart from the two
/// capture lines this target needs (the fixture's own comment says why). No test here sends a vault
/// request, so the file capability stays untouched.
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

const PATIENCE: Duration = Duration::from_secs(10);

/// A value that is obviously not a key: §10.4 forbids touching a developer's real profile or
/// credential, so the one this file injects is spelled as what it is.
const FAKE_KEY: &str = "sk-nkw-not-a-real-credential-0001";

/// The variable the fixture reports its own environment with.
const CREDENTIAL_VAR: &str = "NWK_TEST_API_KEY";

/// The profile the fixture engines here are bound to. Not `default`: the bundled engine owns that
/// one, and a profile belongs to one engine (§3.4's Profile row) — which is itself the rule the
/// binding below would fail on if it were flouted.
const PROFILE: &str = "acme-profile";

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-registry-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// The app's registry, in the state a window finds it once anything has asked for it.
///
/// Pre-installed rather than built by `edit_registry`'s own lazy path, so the cases about *shape*
/// need no engine on disk: whether a bundled sidecar sits next to the test binary is T14's question.
/// The one case that does go through that path asserts its refusal.
fn state_with(registry: AgentRegistry) -> AgentRuntimeState {
    let state = AgentRuntimeState::default();
    *state.registry.lock().unwrap() = Some(Arc::new(registry));
    state
}

/// The fixture engine as a registration, the way a user's own engine looks: an absolute program, an
/// argument array, and an environment of its own.
fn fixture_agent(agent_id: &str, capture: &Path) -> AgentRegistration {
    AgentRegistration {
        agent_id: agent_id.to_string(),
        display_name: format!("Fake {agent_id}"),
        source: InstallSource::External,
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            "good".to_string(),
        ],
        env: EnvPolicy::UserEnvironment,
        env_extra: vec![(
            "NWK_FAKE_CAPTURE".to_string(),
            capture.to_string_lossy().into_owned(),
        )],
        enabled: true,
        adapter_id: adapters::generic_acp::ADAPTER_ID.to_string(),
        reported_version: None,
    }
}

/// A draft, as the page's add form builds one: no source, no environment policy, no `enabled`.
fn draft(agent_id: &str) -> AgentDraft {
    AgentDraft {
        agent_id: agent_id.to_string(),
        display_name: format!("Acme {agent_id}"),
        program: "/opt/acme/acme-acp".to_string(),
        args: vec!["--acp".to_string(), "--profile default".to_string()],
        adapter_id: adapters::generic_acp::ADAPTER_ID.to_string(),
    }
}

fn readout_json(readout: &RegistryReadout) -> Value {
    serde_json::to_value(readout).expect("the readout serializes")
}

fn refusal_json(refusal: &RegistryRefusal) -> Value {
    serde_json::to_value(refusal).expect("a refusal serializes")
}

/// The entry for `agent_id` out of a serialized readout.
fn entry<'a>(view: &'a Value, agent_id: &str) -> &'a Value {
    view["entries"]
        .as_array()
        .expect("rows")
        .iter()
        .find(|entry| entry["agentId"] == agent_id)
        .unwrap_or_else(|| panic!("no row for {agent_id} in {view}"))
}

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------

#[test]
fn the_readout_is_the_shape_the_settings_page_reads() {
    // A program that is certainly not there — the directory was made a moment ago. The *agent id*
    // is the adapter's constant and does not come from the path, which is why this is still the
    // bundled engine's row.
    let dir = temp_dir("readout");
    let readout = read_registry(&AgentRegistry::with_bundled(dir.join("no-such-engine")));
    let view = readout_json(&readout);

    // §3.4.1: the default is the bundled engine and it is *reported*, because the page shows which
    // engine a new session starts on and does not get to choose it.
    assert_eq!(view["defaultAgentId"], "opencode");
    let bundled = entry(&view, "opencode");
    assert_eq!(bundled["source"], "bundled");
    assert_eq!(bundled["env"], "profile-isolated");
    assert_eq!(bundled["enabled"], true);
    assert_eq!(bundled["adapterId"], adapters::opencode::ADAPTER_ID);
    assert_eq!(bundled["programState"], "missing");
    assert_eq!(bundled["reportedVersion"], Value::Null);
    // The arguments are an array: §3.4.3 keeps them separate all the way to `execve`.
    assert_eq!(bundled["args"], json!(["acp"]));
    assert_eq!(bundled["envExtra"], json!([]));

    // The adapter ids are this build's own answer, so the form offers the ones that exist rather
    // than a list the page maintains (§3.4's last line).
    let offered = view["adapterIds"].as_array().expect("a list");
    assert!(offered.contains(&json!(adapters::opencode::ADAPTER_ID)));
    assert!(offered.contains(&json!(adapters::generic_acp::ADAPTER_ID)));

    // Nothing is running and one profile is bound — answers rather than absences, because the page's
    // switch-off precondition and its engine-switch plan are built from them.
    assert_eq!(view["runningAgentIds"], json!([]));
    assert_eq!(view["profileOwners"]["default"], "opencode");
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

#[test]
fn an_added_engine_is_the_users_own_and_carries_the_draft_verbatim() {
    let managed = temp_dir("add");
    let state = state_with(AgentRegistry::with_bundled("/opt/nekowite/opencode"));

    // Through `edit_registry`, which is the path a command takes: the closure returns what the page
    // receives, and `Ok(None)` is the accepted arm.
    let accepted = edit_registry(&state, &managed, |registry| {
        add_agent(registry, draft("acme"))
    })
    .expect("the registry is there to change");
    assert!(accepted.is_none(), "{accepted:?}");

    let installed = state.registry.lock().unwrap().clone().expect("installed");
    let view = readout_json(&read_registry(&installed));
    let added = entry(&view, "acme");

    // Three fields the draft could not name, decided by the backend: the program is the user's
    // (§3.4.6 — the host may report a version and nothing more), the environment is the user's own
    // (§3.1), and it is switched on (§3.4.1's 安装并启用 is one act).
    assert_eq!(added["source"], "external");
    assert_eq!(added["env"], "user-environment");
    assert_eq!(added["enabled"], true);
    assert_eq!(added["reportedVersion"], Value::Null);
    // And the draft's own fields arrived as typed — including an argument with a space in it, which
    // is one argument and not two.
    assert_eq!(added["displayName"], "Acme acme");
    assert_eq!(added["program"], "/opt/acme/acme-acp");
    assert_eq!(added["args"], json!(["--acp", "--profile default"]));
    assert_eq!(added["programState"], "missing");
}

#[test]
fn a_refused_change_is_a_value_and_an_unreachable_registry_is_an_error() {
    let managed = temp_dir("channels");

    // The refusal channel: the call completed and the backend said no. `Ok(Some(…))`, and the facts
    // are the page's to render — no sentence is built here.
    let state = state_with(AgentRegistry::with_bundled("/opt/nekowite/opencode"));
    let duplicate = edit_registry(&state, &managed, |registry| {
        add_agent(registry, draft("opencode"))
    })
    .expect("a refusal is not a failure of the call");
    assert!(matches!(
        duplicate,
        Some(RegistryRefusal::DuplicateAgent { .. })
    ));

    // The exception channel, first form: nothing to build a registry from. An empty slot sends
    // `edit_registry` through `program_to_launch`, and a test binary has no engine beside it — the
    // same sentence the app gives for a package that did not carry its sidecar.
    let empty = AgentRuntimeState::default();
    let unbuildable = edit_registry(&empty, &managed, |registry| {
        add_agent(registry, draft("acme"))
    });
    assert!(unbuildable.is_err(), "{unbuildable:?}");
    assert!(
        empty.registry.lock().unwrap().is_none(),
        "a registry that could not be built must not be left half-installed"
    );

    // The exception channel, second form: a start is in flight and holds a share of it. That is
    // §3.4.7's rule from the other side — a definition may not be edited while an engine is being
    // started from it — and the registry stays exactly where it was.
    let in_flight = state_with(AgentRegistry::with_bundled("/opt/nekowite/opencode"));
    let held = in_flight
        .registry
        .lock()
        .unwrap()
        .clone()
        .expect("installed");
    let blocked = edit_registry(&in_flight, &managed, |registry| {
        add_agent(registry, draft("acme"))
    });
    assert!(blocked.is_err(), "{blocked:?}");
    assert_eq!(
        Arc::strong_count(&held),
        2,
        "the in-flight share is still the one the slot holds"
    );
    drop(held);

    // And the same call succeeds the moment nothing holds a share — which is what makes the arm
    // above about a race rather than about a registry that cannot be edited at all.
    let after = edit_registry(&in_flight, &managed, |registry| {
        add_agent(registry, draft("acme"))
    });
    assert!(after.expect("nothing holds it now").is_none());
}

#[test]
fn the_refusal_wire_shape_is_the_pages_vocabulary() {
    // One assertion per field-name shape rather than per arm: these are the ones a page reads by a
    // *different* name than the Rust error carries, which is where a mapping drifts silently.
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");

    let program = add_agent(
        &mut registry,
        AgentDraft {
            program: "acme-acp".to_string(),
            ..draft("acme")
        },
    )
    .expect("a relative path is refused");
    assert_eq!(
        refusal_json(&program),
        json!({ "kind": "program", "path": "acme-acp", "state": "not-absolute" })
    );

    let argument = add_agent(
        &mut registry,
        AgentDraft {
            args: vec!["--ok".to_string(), "bad\0arg".to_string()],
            ..draft("acme")
        },
    )
    .expect("a NUL byte is refused");
    assert_eq!(
        refusal_json(&argument),
        json!({ "kind": "argument", "index": 1 })
    );

    let id = add_agent(
        &mut registry,
        AgentDraft {
            agent_id: "../acme".to_string(),
            ..draft("acme")
        },
    )
    .expect("a path traversal dressed as an id is refused");
    assert_eq!(
        refusal_json(&id),
        json!({ "kind": "id", "field": "agent_id", "value": "../acme" })
    );

    let adapter = add_agent(
        &mut registry,
        AgentDraft {
            adapter_id: "opencode-next".to_string(),
            ..draft("acme")
        },
    )
    .expect("an adapter nobody answers to is refused at the form");
    assert_eq!(
        refusal_json(&adapter),
        json!({ "kind": "unknown-adapter", "adapterId": "opencode-next" })
    );

    // The arm whose Rust field the wire deliberately drops, and the arm whose Rust field is renamed
    // and reworded: an epoch is this host's incarnation token (§6.1) and the row identifies the
    // engine by id, while a start failure carries the transport's own classification *and* the
    // engine's own words (P0 §2.4's certificate rewording is passed through, not reinvented).
    let blocked = set_enabled(&mut registry, "opencode", false).expect("the default is refused");
    assert_eq!(
        refusal_json(&blocked),
        json!({ "kind": "is-default", "agentId": "opencode" })
    );

    let failed = refusal_view(RegistryError::LaunchFailed {
        agent_id: "acme".to_string(),
        error: TransportError::Disconnected {
            detail: "the engine closed the pipe".to_string(),
        },
    });
    let view = refusal_json(&failed);
    assert_eq!(view["kind"], "launch-failed");
    assert_eq!(view["agentId"], "acme");
    assert_eq!(view["code"], "process-exited");
    assert_eq!(
        view["message"],
        "the engine connection closed: the engine closed the pipe"
    );
}

// ---------------------------------------------------------------------------
// The two answers that need a process
// ---------------------------------------------------------------------------

/// One fixture engine, started through the registry the way the app starts it.
async fn started(
    registry: &AgentRegistry,
    agent_id: &str,
    root: &Path,
    credentials: &Credentials,
) -> AgentInstance {
    let instance = registry
        .start(
            agent_id,
            PROFILE,
            "vault-1",
            root,
            credentials,
            Arc::new(NoVault),
            LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
        )
        .await
        .expect("the fixture engine starts");
    tokio::time::timeout(PATIENCE, instance.runtime().initialize())
        .await
        .expect("the fixture engine answers the handshake")
        .expect("the fixture engine initializes");
    instance
}

#[tokio::test]
async fn a_live_engine_blocks_the_switch_off_and_shows_in_the_readout() {
    let dir = temp_dir("running");
    let capture = dir.join("capture");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    registry
        .register(fixture_agent("acme", &capture))
        .expect("the fixture registers");
    registry.bind_profile(PROFILE, "acme").expect("binds");

    let instance = started(&registry, "acme", &dir, &Credentials::default()).await;

    // The readout says which row has an engine, so the page does not offer a switch-off that can
    // only be refused — and the backend refuses it anyway, with the same fact.
    let view = readout_json(&read_registry(&registry));
    assert_eq!(view["runningAgentIds"], json!(["acme"]));
    let refused = set_enabled(&mut registry, "acme", false).expect("the engine is live");
    assert_eq!(
        refusal_json(&refused),
        json!({ "kind": "instance-running", "agentId": "acme" })
    );
    assert!(
        registry.get("acme").expect("registered").enabled,
        "a refused switch-off leaves the registration as the backend left it"
    );

    // Switching *on* has no precondition at all: §3.4.7's rule is about handling the active task
    // first, and nothing is being started or stopped by acknowledging that a row is already on.
    assert!(set_enabled(&mut registry, "acme", true).is_none());

    // Dropping the instance releases the epoch and asks the engine to exit, which is what makes the
    // switch-off possible — and the readout's answer is about *now*, not about what ever started.
    drop(instance);
    assert!(set_enabled(&mut registry, "acme", false).is_none());
    assert_eq!(
        readout_json(&read_registry(&registry))["runningAgentIds"],
        json!([]),
        "a stopped instance is not a running engine"
    );
}

#[tokio::test]
async fn the_profiles_credentials_reach_the_engine_at_launch() {
    let dir = temp_dir("credential");
    let capture = dir.join("capture");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let mut registration = fixture_agent("acme", &capture);
    // Profile-isolated, so this also proves the credentials are *added to* the policy's roots
    // rather than replacing them: one environment, two sources, and the engine sees both.
    registration.env = EnvPolicy::ProfileIsolated;
    registry.register(registration).expect("registers");
    registry.bind_profile(PROFILE, "acme").expect("binds");

    let credentials = Credentials::new([(CREDENTIAL_VAR.to_string(), Secret::new(FAKE_KEY))]);
    let _instance = started(&registry, "acme", &dir, &credentials).await;

    // Read out of the child's own environment, written by the child: the credential arrived *in the
    // process*, which is the only thing that distinguishes "the launch described it" from "the
    // engine has it" — and that gap is the failure this case exists to catch.
    let recorded =
        fs::read_to_string(&capture).expect("the fixture reports what it was started with");
    assert!(recorded.contains(&format!("cred={FAKE_KEY}")), "{recorded}");
    assert!(
        recorded.contains(&format!("home={}", dir.join("HOME").display())),
        "{recorded}"
    );

    // And the launch that carried it is not printable — T3a's flag, from the side that has a
    // credential to leak: the field is made of `Secret`s, so `EngineLaunch`'s *derived* `Debug`
    // prints the names and a placeholder.
    let launch = registry
        .get("acme")
        .expect("registered")
        .launch(&dir, &credentials);
    let printed = format!("{launch:?}");
    assert!(!printed.contains(FAKE_KEY), "{printed}");
    assert!(printed.contains(CREDENTIAL_VAR), "{printed}");
    assert!(printed.contains("<redacted>"), "{printed}");
}
