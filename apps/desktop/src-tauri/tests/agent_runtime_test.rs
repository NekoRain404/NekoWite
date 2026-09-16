//! The agent runtime, against a fixture engine and then against the real one.
//!
//! Framing, JSON-RPC and the process lifecycle belong to `agent-client-protocol`
//! (see `src/agent_runtime/mod.rs` for the layering), so what these tests hold
//! down is what this crate still owns: the launch environment, the translation
//! of protocol updates into host events, the run lifecycle and its cancellation
//! race, and the failure classification.
//!
//! The fixture engine (`tests/fixtures/agent/fake_agent.sh`) is a POSIX shell
//! script — no interpreter to install — that can be told to misbehave in one
//! specific way per test. It answers the protocol as measured in P0, so a test
//! that passes here is a statement about our wiring, not about a mock we
//! invented.

// The runtime is a library module now: `lib.rs` declares `pub mod agent_runtime;`
// and `agent_runtime/mod.rs` declares the tree inside it, so this test compiles
// against the same source the app ships rather than a second copy of it. It used
// to be included by path, which is what a test does while the file that
// registers it belongs to another task; that shim is gone, and the import below
// is the whole of what replaced it.
use nekowite_lib::agent_runtime;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use std::sync::Arc;

use agent_client_protocol::schema::v1::SessionUpdate;
use serde_json::json;

use agent_runtime::events::normalize_update;
use agent_runtime::{
    AgentEventEnvelope, AgentEventKind, AgentFailureCode, AgentIdentity, AgentRuntime,
    AgentRuntimeEvents, EngineConnection, EngineLaunch, VaultFiles, env_pairs,
    isolated_profile_env,
};

/// The transport tests touch no vault: the fixture engine sends no `fs/*`
/// request, so reaching here would mean something unexpected was being served
/// rather than that a stub needs filling in.
struct NoVault;

impl VaultFiles for NoVault {
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a transport test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("a transport test must not write a vault")
    }
}

/// Generous enough that a slow machine does not produce a flake, short enough
/// that a genuine hang fails the run rather than the suite's timeout.
const PATIENCE: Duration = Duration::from_secs(10);

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-agent-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "default".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-1".to_string(),
    }
}

/// Launches the fixture engine, optionally letting it report what it was
/// started with through a capture file.
fn fixture(behaviour: &str, capture: Option<&Path>) -> EngineLaunch {
    let mut env = Vec::new();
    if let Some(path) = capture {
        env.push((
            "NWK_FAKE_CAPTURE".to_string(),
            path.to_string_lossy().into_owned(),
        ));
    }
    EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            behaviour.to_string(),
        ],
        env: env_pairs(env),
        ca_bundle: None,
    }
}

async fn start(launch: &EngineLaunch) -> (AgentRuntime, AgentRuntimeEvents) {
    let (connection, events) = EngineConnection::connect(launch)
        .await
        .expect("the fixture engine should start");
    AgentRuntime::new(identity(), connection, events, Arc::new(NoVault))
}

/// The next host event, failing the test rather than hanging.
async fn next_event(events: &mut AgentRuntimeEvents) -> AgentEventEnvelope {
    tokio::time::timeout(PATIENCE, events.next_event())
        .await
        .expect("an event should arrive")
        .expect("the runtime should still be running")
}

/// Reads events until `stop` says so, so a test can assert on a whole run
/// instead of on whichever event happened to arrive first.
async fn events_until(
    events: &mut AgentRuntimeEvents,
    mut stop: impl FnMut(&AgentEventEnvelope) -> bool,
) -> Vec<AgentEventEnvelope> {
    let mut collected = Vec::new();
    loop {
        let event = next_event(events).await;
        let done = stop(&event);
        collected.push(event);
        if done {
            return collected;
        }
    }
}

/// Collects everything that arrives within `within`, then stops.
async fn events_for(events: &mut AgentRuntimeEvents, within: Duration) -> Vec<AgentEventEnvelope> {
    let mut collected = Vec::new();
    let deadline = tokio::time::Instant::now() + within;
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.next_event()).await {
        collected.push(event);
    }
    collected
}

fn texts(events: &[AgentEventEnvelope]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .filter_map(|event| event.payload.get("text")?.as_str().map(str::to_string))
        .collect()
}

// ---------------------------------------------------------------------------
// The handshake and the frames around it
// ---------------------------------------------------------------------------

#[tokio::test]
async fn initialize_negotiates_the_measured_protocol_version() {
    let (runtime, _events) = start(&fixture("good", None)).await;

    let response = runtime.initialize().await.expect("initialize");

    assert_eq!(response.protocol_version.as_u16(), 1);
    let info = response
        .agent_info
        .expect("the fixture reports an agentInfo, as P0 measured");
    assert_eq!(info.name, "FakeAgent");
    runtime.shutdown();
}

#[tokio::test]
async fn two_frames_in_one_write_are_both_handled() {
    // The fixture answers `session/new` and emits the command list in a single
    // write — the sequence P0 §2.2 measured. A reader that treats one read as
    // one message loses the second frame; the SDK's line framing must split
    // them, and both must be acted on.
    let (runtime, mut events) = start(&fixture("two-in-one", None)).await;
    runtime.initialize().await.expect("initialize");

    let session = runtime.open_session(Path::new("/tmp")).await.expect("session/new");
    let event = next_event(&mut events).await;

    assert_eq!(event.kind, AgentEventKind::CommandsChanged);
    assert_eq!(event.session_id, session.session_id);
    runtime.shutdown();
}

#[tokio::test]
async fn utf8_split_across_reads_is_reassembled() {
    // The fixture writes half of a three-byte character, waits, then writes the
    // rest. Nothing may be decoded before the frame is whole.
    let (runtime, _events) = start(&fixture("split-utf8", None)).await;

    let response = runtime.initialize().await.expect("initialize");

    // The fixture's name IS the character whose bytes it cuts in half, so a
    // reader that decoded each read on its own would produce a replacement
    // character — or nothing — instead of this.
    assert_eq!(
        response.agent_info.expect("agentInfo").name,
        "\u{4e2d}",
        "the split frame must be joined before it is decoded"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_line_that_is_not_json_does_not_end_the_session() {
    // stdout is protocol, so a non-JSON line there is a real violation; what it
    // must not be is fatal to the connection, which is still perfectly able to
    // answer the request that follows.
    let (runtime, _events) = start(&fixture("malformed", None)).await;

    let response = runtime.initialize().await.expect("initialize");

    assert_eq!(response.protocol_version.as_u16(), 1);
    runtime.shutdown();
}

#[tokio::test]
async fn a_response_for_an_unknown_id_is_discarded() {
    // A frame whose id matches no outstanding request (the SDK numbers its
    // requests with UUID strings) must not be delivered anywhere, and must not
    // end the connection: the request that follows is still answered.
    let (runtime, _events) = start(&fixture("unknown-id", None)).await;

    let response = runtime.initialize().await.expect("initialize");

    assert_eq!(response.protocol_version.as_u16(), 1);
    runtime.shutdown();
}

#[tokio::test]
async fn a_child_that_dies_mid_request_does_not_park_it_forever() {
    // The fixture exits without answering. rust-sdk #250/#223 report in-flight
    // futures left "parked forever" in this situation, and the Python SDK's
    // #85 measured that pattern turning crashes into infinite hangs — the worse
    // of the two failures, because a hang looks like a slow answer.
    //
    // What is asserted is only that the call ENDS. Which of the two guards ends
    // it — the SDK noticing the closed transport, or our own per-call bound —
    // is printed, because it is what T3 needs to know it is proving.
    let (runtime, _events) = start(&fixture("mid-request-exit", None)).await;
    let started = std::time::Instant::now();

    let outcome = tokio::time::timeout(PATIENCE, runtime.initialize()).await;

    let elapsed = started.elapsed();
    let terminated = outcome.is_ok();
    eprintln!(
        "dead child: terminated={terminated} after {elapsed:?} (SDK close, or our INITIALIZE_BOUND)"
    );
    assert!(
        terminated,
        "a dead engine must not park a request indefinitely: {outcome:?}"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn an_endless_frame_aborts_the_run_and_reports_the_bound() {
    // Nine megabytes with no newline. §6.2: exceeding the limit must abort the
    // run and report it, never buffer without limit and never drop the frame
    // quietly. The bound is ours, because `agent-client-protocol`'s `Lines` has
    // no maximum anywhere and its splitter grows until it finds a newline.
    let (runtime, _events) = start(&fixture("oversized", None)).await;

    let outcome = tokio::time::timeout(PATIENCE, runtime.initialize()).await;

    let error = outcome
        .expect("the bound must abort the run, not leave it hanging")
        .expect_err("an oversized frame must not be accepted as a message");
    // And it must say which limit it hit: "the connection closed" would send a
    // reader looking for a crash that never happened.
    let message = error.failure_message();
    assert!(
        message.contains("larger than"),
        "the failure must name the bound, got: {message}"
    );
    runtime.shutdown();
}

// ---------------------------------------------------------------------------
// The launch environment (P0 §2.4)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_engine_is_started_with_the_ca_bundle() {
    // A child cannot be asked what it was spawned with, so the fixture reports
    // its own environment. Without this variable every prompt against a host
    // whose chain is missing from the engine's store fails as an opaque TLS
    // error, which P0 §2.4 measured and §2.4 requires the runtime to prevent.
    let capture = temp_dir("ca").join("capture");
    let (runtime, _events) = start(&fixture("good", Some(&capture))).await;
    runtime.initialize().await.expect("initialize");

    let recorded = fs::read_to_string(&capture).expect("the fixture should have reported its env");
    let ca = recorded
        .lines()
        .find_map(|line| line.strip_prefix("ca="))
        .expect("the fixture records the variable");
    assert_ne!(ca, "<unset>", "NODE_EXTRA_CA_CERTS must be set for the engine");
    assert!(
        Path::new(ca).is_file(),
        "and it must name a bundle that exists, not just any string: {ca}"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_certificate_failure_is_classified_and_reworded() {
    // The measured shape (P0 §2.4): the engine reports an untrusted certificate
    // as a generic -32603 whose message is the only evidence of the real
    // condition, and §2.4 forbids showing that message to a user.
    let (runtime, _events) = start(&fixture("cert-fail", None)).await;

    let error = runtime.initialize().await.expect_err("this fixture fails");

    assert_eq!(error.failure_code(), AgentFailureCode::CertificateUntrusted);
    let message = error.failure_message();
    assert!(
        !message.contains("unknown certificate verification error"),
        "the engine's own words must not reach the user: {message}"
    );
    assert!(message.to_lowercase().contains("certificate"));
    runtime.shutdown();
}

// ---------------------------------------------------------------------------
// Sessions and runs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_session_reports_the_command_list_before_any_run() {
    let (runtime, mut events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");

    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    // P0 §2.2: the command list follows as a notification, not in the response,
    // and it arrives with no run open.
    let event = next_event(&mut events).await;
    assert_eq!(event.kind, AgentEventKind::CommandsChanged);
    assert_eq!(event.session_id, session.session_id);
    assert!(event.run_id.is_none(), "a session event carries no run id");
    runtime.shutdown();
}

#[tokio::test]
async fn a_prompt_streams_text_and_ends_with_the_measured_stop_reason() {
    let (runtime, mut events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime.open_session(Path::new("/tmp")).await.expect("session/new");

    let run_id = runtime.prompt(&session.session_id, "hello").expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    assert_eq!(texts(&events), vec!["first"]);
    let last = events.last().expect("a run-finished event");
    assert_eq!(last.run_id.as_deref(), Some(run_id.as_str()));
    // The engine answers `end_turn` (the fixture sends the protocol's snake_case); what the host
    // publishes is the contract's spelling, so no reader on this side has to know both.
    assert_eq!(last.payload["stopReason"], "end-turn");
    assert!(
        last.payload.get("usage").is_some(),
        "the usage arrives with the result (P0 §2.3)"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_thought_chunk_never_reaches_the_host_as_an_unknown() {
    // The fixture emits an `agent_thought_chunk` between the text chunks. It
    // has no host kind (a decision the contract owns, see `events`), and the
    // one thing it must not do is arrive as a mystery payload.
    let (runtime, mut events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime.open_session(Path::new("/tmp")).await.expect("session/new");

    runtime.prompt(&session.session_id, "hello").expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    assert!(
        !texts(&events).iter().any(|text| text.contains("thinking")),
        "reasoning must not be rendered as answer text"
    );
    assert!(events.iter().all(|event| event.kind == AgentEventKind::TextDelta
        || event.kind == AgentEventKind::CommandsChanged
        || event.kind == AgentEventKind::RunFinished));
    runtime.shutdown();
}

#[tokio::test]
async fn a_second_prompt_while_running_is_refused() {
    let (runtime, _events) = start(&fixture("stream", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime.open_session(Path::new("/tmp")).await.expect("session/new");
    let run_id = runtime.prompt(&session.session_id, "first").expect("prompt");
    assert!(run_id.starts_with("run-"));

    let refused = runtime.prompt(&session.session_id, "second");

    assert!(
        matches!(
            refused,
            Err(agent_runtime::SessionError::RunInProgress { .. })
        ),
        "a second generation on one session must be refused, not queued: {refused:?}"
    );
    runtime.cancel(&session.session_id).await.expect("cancel");
    runtime.shutdown();
}

#[tokio::test]
async fn a_cancelled_run_drops_its_late_text_and_finishes_once() {
    let (runtime, mut events) = start(&fixture("stream", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime.open_session(Path::new("/tmp")).await.expect("session/new");

    let run_id = runtime.prompt(&session.session_id, "hello").expect("prompt");
    // The fixture sends "first", then waits for the cancel before sending
    // "late" — the text that must not revive a stopped run (§6.2).
    let first = events_until(&mut events, |event| event.kind == AgentEventKind::TextDelta).await;
    assert_eq!(texts(&first), vec!["first"]);

    runtime.cancel(&session.session_id).await.expect("cancel");
    let after = events_for(&mut events, Duration::from_millis(1200)).await;

    assert_eq!(
        texts(&after),
        Vec::<String>::new(),
        "text for a cancelled run must not be forwarded"
    );
    let endings = after
        .iter()
        .filter(|event| event.kind == AgentEventKind::RunFinished)
        .count();
    assert_eq!(endings, 1, "a run ends exactly once");
    assert_eq!(after[0].run_id.as_deref(), Some(run_id.as_str()));
    assert_eq!(after[0].payload["stopReason"], "cancelled");
    runtime.shutdown();
}

#[tokio::test]
async fn cancelling_an_idle_session_is_not_an_error() {
    // Stop can be pressed in the same instant the answer lands; reporting that
    // race as a fault would be reporting the user's own click as a bug.
    let (runtime, _events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime.open_session(Path::new("/tmp")).await.expect("session/new");

    runtime.cancel(&session.session_id).await.expect("cancel");
    runtime.shutdown();
}

// ---------------------------------------------------------------------------
// The engine's own options
// ---------------------------------------------------------------------------

/// One `session/update` as the pinned schema sends it.
///
/// Deserialized from JSON rather than built from Rust structs on purpose: what the mapping
/// below has to survive is the *wire's* shape (`agent-client-protocol-schema` 1.7.0, v1), and
/// a struct literal would agree with this crate's reading of that shape by construction.
fn wire_update(frame: serde_json::Value) -> SessionUpdate {
    serde_json::from_value(frame).expect("the pinned schema reads its own frame")
}

/// The engine's option list, as the contract's reader takes it (`readers/session.ts`,
/// `readConfigChanged`): the discriminator on the *value* (`kind`), the current value under
/// `current`, and a select's choices a flat list.
#[test]
fn a_config_option_update_is_mapped_into_the_contracts_payload() {
    let update = wire_update(json!({
        "sessionUpdate": "config_option_update",
        "configOptions": [
            {
                "id": "model",
                "name": "Model",
                "description": "Which model answers",
                "type": "select",
                "currentValue": "fake/model-b",
                "options": [
                    { "value": "fake/model-a", "name": "Model A" },
                    { "value": "fake/model-b", "name": "Model B", "description": "the fast one" }
                ]
            },
            {
                "id": "fast",
                "name": "Fast mode",
                "type": "boolean",
                "currentValue": true
            }
        ]
    }));

    let (kind, payload) = normalize_update(&update).expect("an option list must be forwarded");

    assert_eq!(kind, AgentEventKind::ConfigChanged);
    assert_eq!(
        payload,
        json!({
            "options": [
                {
                    "id": "model",
                    "name": "Model",
                    "description": "Which model answers",
                    "value": {
                        "kind": "select",
                        "current": "fake/model-b",
                        "choices": [
                            { "value": "fake/model-a", "name": "Model A" },
                            { "value": "fake/model-b", "name": "Model B", "description": "the fast one" }
                        ]
                    }
                },
                {
                    "id": "fast",
                    "name": "Fast mode",
                    "value": { "kind": "toggle", "current": true }
                }
            ]
        }),
        "the window's reader accepts this shape and no other"
    );
}

#[test]
fn grouped_config_choices_are_flattened_in_the_engines_order() {
    // The wire's choices are an untagged union — a flat list, or a list of groups of them —
    // and the contract's `AgentConfigChoice` is one flat list. Flattening keeps the values and
    // their order; the group's *name* has nowhere to go, which is the residual T4b §7 reported
    // rather than something this mapping can decide.
    let update = wire_update(json!({
        "sessionUpdate": "config_option_update",
        "configOptions": [{
            "id": "model",
            "name": "Model",
            "type": "select",
            "currentValue": "a",
            "options": [
                { "group": "anthropic", "name": "Anthropic", "options": [
                    { "value": "a", "name": "A" },
                    { "value": "b", "name": "B" }
                ]},
                { "group": "local", "name": "Runs here", "options": [
                    { "value": "c", "name": "C" }
                ]}
            ]
        }]
    }));

    let (kind, payload) = normalize_update(&update).expect("an option list must be forwarded");

    assert_eq!(kind, AgentEventKind::ConfigChanged);
    let choices = payload["options"][0]["value"]["choices"]
        .as_array()
        .expect("a select's choices are a list");
    let values: Vec<&str> = choices
        .iter()
        .filter_map(|choice| choice["value"].as_str())
        .collect();
    assert_eq!(values, vec!["a", "b", "c"], "in the engine's own order");
    assert!(
        choices.iter().all(|choice| choice.get("group").is_none()),
        "the group's name has nowhere to go in the contract's choice: {choices:?}"
    );
}

#[test]
fn an_option_list_with_no_options_is_still_a_list() {
    // An engine may withdraw every option it offered, and the contract replaces the previous
    // set wholesale: an empty list is a fact (`readConfigChanged` accepts it), while a missing
    // one is a payload the window cannot read.
    let update = wire_update(json!({
        "sessionUpdate": "config_option_update",
        "configOptions": []
    }));

    let (_, payload) = normalize_update(&update).expect("an empty list is still forwarded");

    assert_eq!(payload, json!({ "options": [] }));
}

#[test]
fn every_kind_is_spelled_the_way_the_contract_spells_it() {
    // The envelope's `kind` is a *string* on the wire: serde renders it from the variant name
    // (`#[serde(rename_all = "kebab-case")]`) while the contract's union is written out by hand
    // in `agent-contracts/payloads.ts`, so the two can drift apart with both suites green — which
    // is the failure this task's own predecessor found for `stopReason` (`runs.rs`,
    // `wire_stop_reason`), one field over. This is the whole enum in one place, against the
    // contract's own spellings; a kind added without its string fails here.
    for (kind, spelling) in [
        (AgentEventKind::TextDelta, "text-delta"),
        (AgentEventKind::ToolUpdate, "tool-update"),
        (AgentEventKind::PermissionRequest, "permission-request"),
        (AgentEventKind::CommandsChanged, "commands-changed"),
        (AgentEventKind::ConfigChanged, "config-changed"),
        (AgentEventKind::FilesChanged, "files-changed"),
        (AgentEventKind::RunFinished, "run-finished"),
        (AgentEventKind::RunFailed, "run-failed"),
    ] {
        assert_eq!(
            serde_json::to_value(kind).expect("a kind is a name"),
            json!(spelling),
            "{kind:?} must cross the wire under the contract's own name"
        );
    }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

#[tokio::test]
async fn shutdown_takes_the_whole_process_group_with_it() {
    // The fixture forks a grandchild that sleeps — a stand-in for the tool
    // subprocesses the engine leaves behind. Killing only the process we were
    // handed leaves that grandchild running after the app closes, which §6.2
    // forbids; the group kill the SDK performs is what prevents it.
    let capture = temp_dir("tree").join("capture");
    let (runtime, _events) = start(&fixture("tree", Some(&capture))).await;
    // No initialize: this behaviour never answers one, and the point is the
    // process tree it leaves behind.
    let pids = wait_for_pids(&capture).await;

    runtime.shutdown();
    // The kill happens during the transport's drop, on the connection task; the
    // processes need a moment to actually disappear.
    let gone = wait_until_gone(&pids).await;

    assert!(gone, "these processes outlived shutdown: {pids:?}");
}

#[tokio::test]
async fn shutdown_gives_the_engine_time_to_exit_on_its_own() {
    // §6.2 asks for 「先正常取消/退出再限时终止」 — a normal exit first, a timed
    // termination only if that fails. Closing the connection closes the child's
    // stdin, and this fixture then behaves like an engine finishing a write:
    // it waits, records that it got there, and exits by itself.
    //
    // The record is the measurement. If the group were killed the instant the
    // connection dropped — which is what I first reported, from reading
    // `ChildGuard` alone — this file would never be written.
    let capture = temp_dir("grace").join("capture");
    let (runtime, _events) = start(&fixture("slow-exit", Some(&capture))).await;
    runtime.initialize().await.expect("initialize");

    runtime.shutdown();

    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let recorded = fs::read_to_string(&capture).unwrap_or_default();
        if recorded.contains("exited-cleanly=yes") {
            assert!(recorded.contains("eof-seen=yes"), "EOF must arrive first");
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the engine was killed before it could exit on its own: {recorded:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Waits for the fixture to report its own pid and its child's.
async fn wait_for_pids(capture: &Path) -> Vec<i32> {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        if let Ok(recorded) = fs::read_to_string(capture) {
            let pids: Vec<i32> = recorded
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("pid=")
                        .or_else(|| line.strip_prefix("child="))
                        .and_then(|value| value.trim().parse().ok())
                })
                .collect();
            if pids.len() == 2 {
                return pids;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the fixture never reported its process tree"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Whether every pid is gone. `kill -0` only asks the kernel; nothing here
/// signals anything, because these pids are evidence, not targets.
async fn wait_until_gone(pids: &[i32]) -> bool {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let alive = pids.iter().any(|pid| Path::new(&format!("/proc/{pid}")).exists());
        if !alive {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---------------------------------------------------------------------------
// The real engine
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_real_engine_negotiates_protocol_version_one() {
    // The artifact is a pipeline product and gitignored (P0 §1), so a checkout
    // without it is normal — that is a skip, not a failure. Run
    // `scripts/fetch-opencode-linux.sh` to make this test mean something.
    let binary = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries/opencode-x86_64-unknown-linux-gnu");
    if !binary.is_file() {
        eprintln!(
            "SKIP: {} is absent; run scripts/fetch-opencode-linux.sh",
            binary.display()
        );
        return;
    }

    // Its own HOME and XDG roots: plan §10.4 forbids exercising the developer's
    // real OpenCode profile, and the engine writes config and state under those
    // roots as soon as it starts.
    let profile = temp_dir("real-profile");
    let launch = EngineLaunch {
        program: binary,
        args: vec!["acp".to_string()],
        env: env_pairs(isolated_profile_env(&profile)),
        ca_bundle: None,
    };
    let (runtime, _events) = start(&launch).await;

    // Nothing past the handshake: `initialize` costs nothing and needs no
    // credentials, so this stays a test and not a bill.
    let response = runtime.initialize().await.expect("the real engine initializes");

    assert_eq!(response.protocol_version.as_u16(), 1);
    let info = response.agent_info.expect("agentInfo");
    assert_eq!(info.name, "OpenCode");
    // Not pinned to 1.18.29: the artifact is updated by its own task (T14), and
    // a test that failed on an engine upgrade would be reporting the version
    // bump rather than a broken handshake.
    assert!(
        info.version.starts_with(char::is_numeric),
        "agentInfo.version should look like a version, got {:?}",
        info.version
    );
    runtime.shutdown();
}
