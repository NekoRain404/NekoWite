//! R8 (identity) — two engines at once, and no name the protocol gives them can make one
//! engine's work appear under another's.
//!
//! §3.4's session row and §6.1: an engine chooses its own `sessionId`, its request ids are its own,
//! and the host's run ids are per-instance counters — so the host's own isolation cannot rest on
//! any of them. What it rests on is the composite identity (agentId + profileId + vaultId +
//! runtimeEpoch) that the registry mints and every envelope carries, and on refusing to run two
//! engines for one (agent, profile, vault). The definition half — which engines exist and what
//! they may say about themselves — is `agent_registry_test.rs`.
//!
//! The engine half is T2's fixture (`tests/fixtures/agent/fake_agent.sh`), unmodified. It always
//! calls its session `ses_fake_1`, which is what makes the isolation test possible without a
//! second fixture protocol: two copies of one engine really do emit the same session id.
//!
//! Module inclusion: `agent_runtime/mod.rs` does not declare `registry` or `adapters` —
//! registering them is T4's (`lib.rs` is that task's serialized file) — so the tree is declared
//! here by path, the convention `agent_permission_ipc_test.rs` also uses.

#[path = "../src/agent_runtime"]
mod agent_runtime {
    pub mod acp_transport;
    pub mod adapters;
    pub mod events;
    pub mod fs_capability;
    pub mod process;
    pub mod registry;
    pub mod runs;
    pub mod session;
}

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use agent_runtime::adapters::{self, Capability, HostFeature};
use agent_runtime::events::{AgentEventEnvelope, AgentEventKind};
use agent_runtime::fs_capability::VaultFiles;
use agent_runtime::registry::{
    AgentInstance, AgentRegistration, AgentRegistry, EnvPolicy, InstallSource,
    RegistryError,
};
use agent_runtime::session::AgentRuntime;

/// Generous enough that a slow machine does not flake, short enough that a hang fails the run
/// rather than the suite's timeout.
const PATIENCE: Duration = Duration::from_secs(10);

/// No test here touches a vault: the fixture sends no `fs/*` request of its own, so reaching this
/// would mean something unexpected was being served rather than a stub to fill in.
struct NoVault;

impl VaultFiles for NoVault {
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("this test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("this test must not write a vault")
    }
}

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-registry-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// A registration for the fixture engine written the way §3.4.3 has a user write one: an absolute
/// path to a program, and the arguments as an array.
fn fixture_agent(agent_id: &str, behaviour: &str) -> AgentRegistration {
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
        adapter_id: adapters::generic_acp::ADAPTER_ID.to_string(),
        reported_version: None,
    }
}

/// The registry every multi-agent test starts from: the bundled default, plus two registrations
/// for the fixture engine with a profile each — a profile belongs to one engine (§3.4's Profile
/// row), which is also why the two can never be handed each other's identity.
fn registry_with_two_fakes() -> AgentRegistry {
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    for (agent_id, profile_id) in [("fake-a", "prof-a"), ("fake-b", "prof-b")] {
        register_fixture(&mut registry, agent_id, profile_id, "good");
    }
    registry
}

/// Start one engine, or the refusal that stopped it: the five arguments spelled once.
async fn try_start(
    registry: &AgentRegistry,
    agent_id: &str,
    profile_id: &str,
    vault_id: &str,
    root: &Path,
) -> Result<AgentInstance, RegistryError> {
    registry
        .start(agent_id, profile_id, vault_id, root, Arc::new(NoVault))
        .await
}

/// Start one engine and finish its handshake, so a test can talk to it.
async fn started(
    registry: &AgentRegistry,
    agent_id: &str,
    profile_id: &str,
    vault_id: &str,
    root: &Path,
) -> AgentInstance {
    let mut instance = try_start(registry, agent_id, profile_id, vault_id, root)
        .await
        .expect("the fixture engine should start");
    instance
        .runtime_mut()
        .initialize()
        .await
        .expect("the fixture engine should initialize");
    instance
}

async fn next_event(runtime: &mut AgentRuntime) -> AgentEventEnvelope {
    tokio::time::timeout(PATIENCE, runtime.recv_event())
        .await
        .expect("an event should arrive")
        .expect("the runtime should still be running")
}

/// Reads events until `stop` says so, so a test asserts on a whole run rather than on whichever
/// event arrived first.
async fn events_until(
    runtime: &mut AgentRuntime,
    mut stop: impl FnMut(&AgentEventEnvelope) -> bool,
) -> Vec<AgentEventEnvelope> {
    let mut collected = Vec::new();
    loop {
        let event = next_event(runtime).await;
        let done = stop(&event);
        collected.push(event);
        if done {
            return collected;
        }
    }
}

fn texts(events: &[AgentEventEnvelope]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .filter_map(|event| event.payload.get("text")?.as_str().map(str::to_string))
        .collect()
}

/// The error a call that must be refused produced, or a failure.
fn refused<T>(result: Result<T, RegistryError>) -> RegistryError {
    match result {
        Ok(_) => panic!("expected a refusal, got a running instance"),
        Err(error) => error,
    }
}

/// Registers the fixture engine under an agent id and binds a profile to it.
fn register_fixture(registry: &mut AgentRegistry, agent_id: &str, profile_id: &str, behaviour: &str) {
    registry
        .register(fixture_agent(agent_id, behaviour))
        .expect("registers");
    registry.bind_profile(profile_id, agent_id).expect("binds");
}

/// Opens a session on a started instance and returns the engine's own session id.
async fn open_session(instance: &mut AgentInstance, root: &Path) -> String {
    instance
        .runtime_mut()
        .open_session(root)
        .await
        .expect("session/new")
        .session_id
}

/// Prompts, then reads the run to its end.
async fn run_to_finish(
    instance: &mut AgentInstance,
    session_id: &str,
    prompt: &str,
) -> Vec<AgentEventEnvelope> {
    instance
        .runtime_mut()
        .prompt(session_id, prompt)
        .expect("prompt");
    events_until(instance.runtime_mut(), |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await
}

/// The permission frame in the shape P0 §7.1 measured: a `toolCall` and the engine's own options
/// with its own ids. The JSON-RPC id is `fs-1` because the fixture has one generic reverse-request
/// reply capture keyed on it — reusing it is reusing the fixture, not teaching it a second protocol.
fn permission_frame(tool_call_id: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": "fs-1",
        "method": "session/request_permission",
        "params": {
            "sessionId": "ses_fake_1",
            "toolCall": {
                "toolCallId": tool_call_id,
                "title": tool_call_id,
                "kind": "edit",
                "status": "pending",
            },
            "options": [{ "optionId": "once", "name": "Allow once", "kind": "allow_once" }],
        },
    })
    .to_string()
}

#[tokio::test]
async fn two_engines_reporting_the_same_session_id_do_not_cross_streams() {
    let root = temp_dir("same-session");
    let registry = registry_with_two_fakes();
    let mut a = started(&registry, "fake-a", "prof-a", "vault-1", &root).await;
    let mut b = started(&registry, "fake-b", "prof-b", "vault-1", &root).await;
    let session_a = open_session(&mut a, &root).await;
    let session_b = open_session(&mut b, &root).await;
    assert_eq!(
        session_a, session_b,
        "the collision is this test's premise: the id is the engine's to choose"
    );
    assert_eq!(session_a, "ses_fake_1", "and the fixture's is fixed");
    let run_a = a.runtime_mut().prompt(&session_a, "hello").expect("prompt a");
    let run_b = b.runtime_mut().prompt(&session_b, "hello").expect("prompt b");
    let events_a = events_until(a.runtime_mut(), |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;
    let events_b = events_until(b.runtime_mut(), |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;
    // Both engines answer with the same words, so no content tells them apart; and the host's own
    // run id is a per-instance counter, so "run-0" names two pieces of work at once.
    assert_eq!(texts(&events_a), vec!["first"]);
    assert_eq!(texts(&events_b), vec!["first"]);
    assert_eq!(run_a, "run-0");
    assert_eq!(run_a, run_b);
    for event in &events_a {
        assert_eq!(event.agent_id, "fake-a");
        assert_eq!(event.profile_id, "prof-a");
        assert_eq!(event.vault_id, "vault-1");
        assert_eq!(event.runtime_epoch, a.identity().runtime_epoch);
    }
    for event in &events_b {
        assert_eq!(event.agent_id, "fake-b");
        assert_eq!(event.profile_id, "prof-b");
        assert_eq!(event.runtime_epoch, b.identity().runtime_epoch);
    }
    assert_ne!(
        a.identity().runtime_epoch,
        b.identity().runtime_epoch,
        "two live incarnations never share an epoch"
    );
    // The demonstration, on the events themselves: keyed by the engine's session id the two runs
    // land on one key — which is why nothing in this host may key by it alone.
    let mut by_session: HashMap<&str, usize> = HashMap::new();
    for event in events_a.iter().chain(events_b.iter()) {
        *by_session.entry(event.session_id.as_str()).or_default() += 1;
    }
    assert_eq!(by_session.len(), 1, "one session id, both engines");
    assert_eq!(
        by_session["ses_fake_1"],
        events_a.len() + events_b.len(),
        "every event of both runs is on that one key"
    );
    // Keyed by the composite identity they are disjoint sets, which is why the envelope carries
    // four identity fields rather than a session id.
    assert!(events_a.iter().all(|left| !events_b.iter().any(|right| {
        left.agent_id == right.agent_id
            && left.profile_id == right.profile_id
            && left.runtime_epoch == right.runtime_epoch
            && left.vault_id == right.vault_id
    })));
}

#[tokio::test]
async fn the_same_request_id_on_two_engines_stays_with_its_own_instance() {
    // §11.1's 「相同 requestId 的隔离」: both engines ask with the same JSON-RPC id about the same
    // session id, and only the host's own routing keeps the two apart.
    let root = temp_dir("request-id");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    for (agent_id, profile_id, tool_call) in [
        ("fake-a", "prof-a", "call_alpha"),
        ("fake-b", "prof-b", "call_beta"),
    ] {
        let mut registration = fixture_agent(agent_id, "good");
        registration.env_extra = vec![(
            "NWK_FAKE_FS_REQUEST".to_string(),
            permission_frame(tool_call),
        )];
        registry.register(registration).expect("registers");
        registry.bind_profile(profile_id, agent_id).expect("binds");
    }
    let mut a = started(&registry, "fake-a", "prof-a", "vault-1", &root).await;
    let mut b = started(&registry, "fake-b", "prof-b", "vault-1", &root).await;
    let session_a = open_session(&mut a, &root).await;
    let session_b = open_session(&mut b, &root).await;
    assert_eq!(session_a, session_b);
    let asked_a = tokio::time::timeout(PATIENCE, a.runtime_mut().recv_permission())
        .await
        .expect("a asks")
        .expect("a is running");
    let asked_b = tokio::time::timeout(PATIENCE, b.runtime_mut().recv_permission())
        .await
        .expect("b asks")
        .expect("b is running");
    assert_eq!(asked_a.request.session_id.to_string(), "ses_fake_1");
    assert_eq!(asked_b.request.session_id.to_string(), "ses_fake_1");
    assert_eq!(
        asked_a.request.tool_call.tool_call_id.to_string(),
        "call_alpha",
        "each engine's request reached its own instance's channel"
    );
    assert_eq!(
        asked_b.request.tool_call.tool_call_id.to_string(),
        "call_beta"
    );
}

#[tokio::test]
async fn an_engine_that_crashes_leaves_another_running() {
    let root = temp_dir("crash");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    register_fixture(&mut registry, "doomed", "p-doomed", "mid-request-exit");
    register_fixture(&mut registry, "survivor", "p-survivor", "good");
    let mut doomed = try_start(&registry, "doomed", "p-doomed", "vault-1", &root)
        .await
        .expect("the process starts");
    let mut survivor = started(&registry, "survivor", "p-survivor", "vault-1", &root).await;
    // The fixture exits without answering the handshake: a crash, not a refusal.
    let crashed = doomed.runtime_mut().initialize().await;
    assert!(crashed.is_err(), "a dead engine cannot answer: {crashed:?}");
    // §3.4.8: 各引擎故障互不传播 — the other engine never noticed.
    let session = open_session(&mut survivor, &root).await;
    let events = run_to_finish(&mut survivor, &session, "hello").await;
    assert_eq!(texts(&events), vec!["first"]);
    assert!(events.iter().all(|event| event.agent_id == "survivor"));
    // And the crashed engine's registration is free again once the host stops holding the dead
    // instance — a crash leaves no claim behind.
    assert!(matches!(
        registry.remove("doomed"),
        Err(RegistryError::InstanceRunning { .. })
    ));
    doomed.shutdown();
    assert!(registry.set_enabled("doomed", false).is_ok());
}

#[tokio::test]
async fn the_same_runtime_cannot_be_started_twice() {
    let root = temp_dir("dedupe");
    let registry = registry_with_two_fakes();
    let first = try_start(&registry, "fake-a", "prof-a", "vault-1", &root)
        .await
        .expect("starts");
    let second = try_start(&registry, "fake-a", "prof-a", "vault-1", &root).await;
    assert!(
        matches!(second, Err(RegistryError::AlreadyRunning { epoch, .. }) if epoch == first.identity().runtime_epoch),
        "two engines on one profile would be two writers into one session store"
    );
    // A second vault is a second instance: that is what makes "multiple agents" a boundary.
    let other = try_start(&registry, "fake-a", "prof-a", "vault-2", &root)
        .await
        .expect("another vault is another instance");
    assert_ne!(
        other.identity().runtime_epoch,
        first.identity().runtime_epoch
    );
    // A stopped instance frees its triple, and the replacement gets a name of its own: an epoch is
    // never reused, or a late frame from the dead process would look current (§6.1).
    first.shutdown();
    let restarted = try_start(&registry, "fake-a", "prof-a", "vault-1", &root)
        .await
        .expect("the triple is free again");
    assert_ne!(
        restarted.identity().runtime_epoch,
        first.identity().runtime_epoch
    );
}

#[tokio::test]
async fn a_forged_agent_or_profile_is_refused_before_anything_starts() {
    let root = temp_dir("forged");
    let mut registry = registry_with_two_fakes();
    let unknown = refused(try_start(&registry, "fake-c", "prof-a", "vault-1", &root).await);
    assert!(
        matches!(unknown, RegistryError::UnknownAgent { .. }),
        "an agent id nobody registered: {unknown:?}"
    );
    let crossed = refused(try_start(&registry, "fake-a", "prof-b", "vault-1", &root).await);
    assert!(
        matches!(crossed, RegistryError::ProfileUnbound { owner: Some(ref owner), .. } if owner == "fake-b"),
        "another engine's profile is a request for its credentials: {crossed:?}"
    );
    let unbound = refused(try_start(&registry, "fake-a", "prof-ghost", "vault-1", &root).await);
    assert!(
        matches!(unbound, RegistryError::ProfileUnbound { owner: None, .. }),
        "{unbound:?}"
    );
    assert!(
        matches!(
            registry.bind_profile("prof-a", "fake-b"),
            Err(RegistryError::ProfileUnbound { .. })
        ),
        "§3.4's Profile row: credentials and model ids are not copied between engines"
    );
    assert!(
        registry.bind_profile("prof-a", "fake-a").is_ok(),
        "re-submitting the same pair is a no-op"
    );
    // Nothing was claimed on the way past: a refused start leaves no trace.
    try_start(&registry, "fake-a", "prof-a", "vault-1", &root)
        .await
        .expect("a refused start leaves no trace: this triple is still free");
}

#[tokio::test]
async fn a_live_instance_keeps_its_registration_from_being_disabled() {
    let root = temp_dir("active");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    // This behaviour holds its run open until it is cancelled: an active task, in §3.4.7's words.
    register_fixture(&mut registry, "fake-a", "prof-a", "stream");
    let mut instance = started(&registry, "fake-a", "prof-a", "vault-1", &root).await;
    let session = open_session(&mut instance, &root).await;
    instance.runtime_mut().prompt(&session, "hello").expect("prompt");
    let error = registry.set_enabled("fake-a", false);
    assert!(
        matches!(error, Err(RegistryError::InstanceRunning { .. })),
        "a run mid-write does not stop being mid-write because a form was submitted: {error:?}"
    );
    assert!(matches!(
        registry.remove("fake-a"),
        Err(RegistryError::InstanceRunning { .. })
    ));
    instance.shutdown();
    registry
        .set_enabled("fake-a", false)
        .expect("the task is over, so the registration can be switched off");
    let error = refused(try_start(&registry, "fake-a", "prof-a", "vault-1", &root).await);
    assert!(
        matches!(error, RegistryError::Disabled { .. }),
        "and a disabled registration cannot be started: {error:?}"
    );
}

#[tokio::test]
async fn removing_a_registration_leaves_the_users_program_alone() {
    let dir = temp_dir("remove");
    let shell = dir.join("sh");
    fs::copy("/bin/sh", &shell).expect("a copy of the shell");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let mut registration = fixture_agent("fake-a", "good");
    registration.program = shell.clone();
    registry.register(registration).expect("registers");
    registry.bind_profile("prof-a", "fake-a").expect("binds");
    let removed = registry.remove("fake-a").expect("nothing is running on it");
    assert_eq!(removed.agent_id, "fake-a");
    assert!(
        shell.is_file(),
        "§3.4.7: the app's registration goes, the user's program stays"
    );
    assert!(registry.get("fake-a").is_none());
    assert!(matches!(
        registry.remove("fake-a"),
        Err(RegistryError::UnknownAgent { .. })
    ));
    // The profile binding outlived the registration, so re-adding the agent keeps the
    // authorization the user gave it.
    registry
        .register(fixture_agent("fake-a", "good"))
        .expect("re-registers");
    assert!(registry.bind_profile("prof-a", "fake-a").is_ok());
}

#[tokio::test]
async fn a_start_that_never_produced_a_runtime_frees_its_profile() {
    use std::os::unix::fs::PermissionsExt;
    let root = temp_dir("failed-launch");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    // A program that is there and executable — so every check this module makes passes — whose
    // interpreter is gone: `execve` refuses it at spawn, the one launch failure validation cannot
    // see coming, and the shape of a wrapper script whose `#!/usr/bin/env node` outlived node.
    let broken = root.join("broken-engine");
    fs::write(&broken, "#!/nonexistent/nkw-interpreter\n").expect("a wrapper script");
    fs::set_permissions(&broken, fs::Permissions::from_mode(0o755)).expect("executable");
    let mut registration = fixture_agent("fake-a", "good");
    registration.program = broken;
    registration.args = Vec::new();
    registry.register(registration).expect("registers");
    registry.bind_profile("prof-a", "fake-a").expect("binds");
    let first = refused(try_start(&registry, "fake-a", "prof-a", "vault-1", &root).await);
    assert!(matches!(first, RegistryError::LaunchFailed { .. }), "{first:?}");
    let second = refused(try_start(&registry, "fake-a", "prof-a", "vault-1", &root).await);
    assert!(
        matches!(second, RegistryError::LaunchFailed { .. }),
        "the next attempt must be a first attempt, not a second engine for a profile that has none: {second:?}"
    );
}

#[tokio::test]
async fn a_stopped_instances_advertisements_expire_with_it() {
    let root = temp_dir("epochs");
    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let mut registration = fixture_agent("fake-opencode", "good");
    registration.adapter_id = adapters::opencode::ADAPTER_ID.to_string();
    registry.register(registration).expect("registers");
    registry.bind_profile("prof-a", "fake-opencode").expect("binds");
    let stopped = {
        let instance = try_start(&registry, "fake-opencode", "prof-a", "vault-1", &root)
            .await
            .expect("starts");
        assert_eq!(
            instance.declared_capability(HostFeature::SessionResume),
            Capability::Advertised
        );
        instance.shutdown();
        assert_eq!(
            instance.declared_capability(HostFeature::SessionResume),
            Capability::Unverified,
            "§3.4: capabilities are re-detected, not carried over — a stopped engine offers nothing"
        );
        instance.identity().runtime_epoch.clone()
    };
    let next = try_start(&registry, "fake-opencode", "prof-a", "vault-1", &root)
        .await
        .expect("restarts");
    assert_ne!(next.identity().runtime_epoch, stopped);
    assert_eq!(
        next.declared_capability(HostFeature::SessionResume),
        Capability::Advertised
    );
}
