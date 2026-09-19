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

use agent_runtime::live_notes::{LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes};
use agent_runtime::{
    env_pairs, isolated_profile_env, AgentEventEnvelope, AgentEventKind, AgentFailureCode,
    AgentIdentity, AgentRuntime, AgentRuntimeEvents, EngineConnection, EngineLaunch, VaultFiles,
    INITIALIZE_BOUND,
};

/// The transport tests touch no vault: the fixture engine sends no `fs/*`
/// request, so reaching here would mean something unexpected was being served
/// rather than that a stub needs filling in.
struct NoVault;

/// The window side, for a test that never reads a note: no window is registered for any vault,
/// so a read would be refused rather than served from disk — which is the direction the seam
/// is built to fail in, and which keeps a test that does not exercise reads honest about it.
struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

impl VaultFiles for NoVault {
    fn frontend_path(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a transport test must not ask a window about a note")
    }
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
    AgentRuntime::new(
        identity(),
        connection,
        events,
        Arc::new(NoVault),
        LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
    )
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

    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");
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

#[tokio::test]
async fn a_start_that_fails_carries_the_engines_own_last_words() {
    // The commonest way this app fails in front of its owner: the engine will not start — a
    // configuration document it rejects, a credential the provider refuses — and its one line
    // of explanation goes to stderr. The log was already captured, bounded and redacted, and
    // nothing could read it: the engine's own sentence was dropped in the same moment it was
    // produced, and the window showed "the engine connection closed" and no more.
    //
    // The credential is part of the measurement rather than decoration. What a failure sentence
    // may show is the redacted text and never the stream, and an engine echoing back an injected
    // value is exactly how a credential would otherwise reach a person through this path.
    const SECRET: &str = "sk-test-9d41f7c2ab3e";
    let mut launch = fixture("startup-refusal", None);
    launch.env.extend(env_pairs([(
        "NWK_TEST_API_KEY".to_string(),
        SECRET.to_string(),
    )]));

    let error = match EngineConnection::connect(&launch).await {
        // Which of the two this is depends on how fast the fixture's exit is noticed after the
        // handshake goes out, and the two are the same failure to a reader.
        Err(error) => error,
        Ok((connection, _events)) => connection
            .initialize(INITIALIZE_BOUND)
            .await
            .expect_err("this fixture never answers the handshake"),
    };

    let message = error.failure_message();
    assert!(
        message.contains("unknown key \"provider\""),
        "the engine's own sentence is what a start failure is read for: {message}"
    );
    assert!(
        !message.contains(SECRET),
        "and what is shown must be the redacted text, never the stream: {message}"
    );
    assert!(
        message.contains("<redacted>"),
        "with the marker standing where the credential was: {message}"
    );
}

#[tokio::test]
async fn an_engine_that_dies_the_moment_it_starts_still_gets_to_say_why() {
    // The harsher shape of the same failure, and the one the sample could be empty in: this
    // engine waits for nothing. It writes its line and exits at once, so stderr and stdout
    // close together and the failure may be noticed by the connect or by the handshake. Both
    // are covered here because either may be what a reader gets.
    //
    // The claim being measured is the honest bound `with_stderr_tail` states: a line written
    // before the process died is in practice already read by the pump, which is a task of its
    // own sitting in `read` while the call that notices is several hops behind.
    let launch = EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            "-c".to_string(),
            "printf 'Error: no provider is configured\\n' >&2; exit 1".to_string(),
        ],
        env: Vec::new(),
        ca_bundle: None,
    };

    let (error, noticed_by) = match EngineConnection::connect(&launch).await {
        Err(error) => (error, "connect"),
        Ok((connection, _events)) => (
            connection
                .initialize(INITIALIZE_BOUND)
                .await
                .expect_err("a process that has already exited never answers the handshake"),
            "handshake",
        ),
    };
    // Printed rather than merely asserted: which of the two noticed is the fact that says
    // whether this shape reaches the reader through the connection's own failure or through a
    // call's, and both are `Disconnected` arms carrying the same log.
    eprintln!("an engine that exits at once was noticed by the {noticed_by}");

    let message = error.failure_message();
    assert!(
        message.contains("no provider is configured"),
        "the engine's last line must survive an exit that gives nothing a head start: {message}"
    );
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
    assert_ne!(
        ca, "<unset>",
        "NODE_EXTRA_CA_CERTS must be set for the engine"
    );
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
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    let run_id = runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
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
async fn a_turn_that_ends_for_a_reason_this_version_does_not_know_is_not_a_failure() {
    // The Rust half of the contract's tolerance for an unfamiliar ending, at the door a live
    // engine actually comes through. The fixture answers `budget_exceeded`, which the pinned
    // schema's `StopReason` does not enumerate: read through that enum alone the whole response is
    // refused, and the `Err` arm above publishes `run-failed`/`invalid-response` — a finished turn
    // shown to the user as a failure, the one outcome the ruling for this area forbids. What must
    // arrive instead is the ending the engine sent, under the contract's one spelling, carrying a
    // word the window reads as `unrecognised` rather than as a reason either side invented.
    let (runtime, mut events) = start(&fixture("unknown-stop-reason", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    let run_id = runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished || event.kind == AgentEventKind::RunFailed
    })
    .await;

    let last = events.last().expect("one ending");
    assert_eq!(
        last.kind,
        AgentEventKind::RunFinished,
        "an unfamiliar reason must not be reported as a failed turn: {:?}",
        last.payload
    );
    assert_eq!(last.run_id.as_deref(), Some(run_id.as_str()));
    // The engine's own word, respelled `_` → `-` exactly as the five enumerated names are
    // (`wire_stop_reason`), so one spelling crosses the wire whatever the engine sent.
    assert_eq!(last.payload["stopReason"], "budget-exceeded");
    // And the counters it arrived with are not dropped with the word: P0 §2.3's own numbers.
    assert_eq!(last.payload["usage"]["inputTokens"], 11);
    assert!(
        events
            .iter()
            .all(|event| event.kind != AgentEventKind::RunFailed),
        "nothing about this turn may be published as a failure"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_thought_chunk_reaches_the_host_as_its_own_kind() {
    // The fixture emits an `agent_thought_chunk` between the text chunks — P0 §2.3's measured
    // order. It arrives as `thought-delta`, the contract's own kind for it, and *not* as answer
    // text: §5.1 forbids inventing reasoning, and folding the engine's own disclosure into
    // `text-delta` would put "thinking" on the answer's side of the timeline, which is the one
    // thing the separation exists to prevent.
    let (runtime, mut events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    let thoughts: Vec<&str> = events
        .iter()
        .filter(|event| event.kind == AgentEventKind::ThoughtDelta)
        .filter_map(|event| event.payload.get("text")?.as_str())
        .collect();
    assert_eq!(
        thoughts,
        vec!["thinking"],
        "the engine's reasoning channel arrives"
    );
    assert!(
        !texts(&events).iter().any(|text| text.contains("thinking")),
        "reasoning must not be rendered as answer text"
    );
    // And nothing arrived as a kind the contract cannot read: the full set of what this turn
    // published is these four, which is what a component switches on.
    assert!(events
        .iter()
        .all(|event| event.kind == AgentEventKind::TextDelta
            || event.kind == AgentEventKind::ThoughtDelta
            || event.kind == AgentEventKind::CommandsChanged
            || event.kind == AgentEventKind::RunFinished));
    runtime.shutdown();
}

#[tokio::test]
async fn an_update_with_no_kind_here_is_dropped_rather_than_failing_the_turn() {
    // The engine sends a `sessionUpdate` this version's schema does not name, in the middle of a
    // turn. Two rules have to hold at once, and §6.2 states both: the frame must not reach a
    // component as a mystery blob (`normalize_update`'s `_` arm is where that is decided), and it
    // must not take the turn down with it — the turn is the engine's, the frame is one this host
    // has no kind for, and a reader that fails a run over a frame it does not understand reports
    // the engine's work as this window's fault.
    //
    // What the frame *does* on the way in is the pinned schema's decision, not this fixture's:
    // `SessionUpdate` has no `Other` arm, so the SDK refuses to deserialize the notification at
    // all. Both routes end in the same place for the host — nothing published for it — and the
    // assertion that matters is the same either way: the turn ends exactly where the fixture
    // always ends it, and every kind that reached the window is one a component can render.
    let (runtime, mut events) = start(&fixture("unknown-update", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    let run_id = runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    assert_eq!(
        texts(&events),
        vec!["first"],
        "the turn is the one the fixture plays"
    );
    let last = events.last().expect("a run-finished event");
    assert_eq!(last.run_id.as_deref(), Some(run_id.as_str()));
    assert_eq!(
        last.payload["stopReason"], "end-turn",
        "an update with no kind here is not a reason to fail the turn"
    );
    assert!(
        events
            .iter()
            .all(|event| event.kind == AgentEventKind::TextDelta
                || event.kind == AgentEventKind::ThoughtDelta
                || event.kind == AgentEventKind::CommandsChanged
                || event.kind == AgentEventKind::RunFinished),
        "only kinds a component can render reached the window: {:?}",
        events.iter().map(|event| event.kind).collect::<Vec<_>>()
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_tool_calls_three_frames_arrive_correlated_and_in_order() {
    // P0 §6.1's measured sequence, through the whole runtime: a `tool_call` (pending) and two
    // `tool_call_update`s (in_progress, completed) for one `toolCallId`. Three claims, and each
    // one is a requirement the scan states rather than a detail of the fixture:
    //
    //  - all three reach the host (neither wire type falls into a catch-all),
    //  - they are one host kind, `tool-update`, so a consumer updates a row instead of adding one,
    //  - the id that correlates them and the status order that says how the call progressed are
    //    both intact, which is what lets the panel draw one evolving row.
    let (runtime, mut events) = start(&fixture("tools", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    let run_id = runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    let calls: Vec<&serde_json::Value> = events
        .iter()
        .filter(|event| event.kind == AgentEventKind::ToolUpdate)
        .map(|event| {
            event
                .payload
                .get("update")
                .expect("the schema's frame, wrapped")
        })
        .collect();
    assert_eq!(
        calls.len(),
        3,
        "one frame per measured update, none dropped"
    );

    let ids: Vec<&str> = calls
        .iter()
        .filter_map(|call| call.get("toolCallId")?.as_str())
        .collect();
    assert_eq!(
        ids,
        vec!["call_fake_1"; 3],
        "toolCallId is the key that ties the three frames to one call"
    );
    let statuses: Vec<Option<&str>> = calls
        .iter()
        .map(|call| call.get("status").and_then(|status| status.as_str()))
        .collect();
    // The engine's own statuses, in the order it sent them — `None` for the first one because
    // `pending` is the schema's default and serde skips a default when the frame is re-encoded
    // (`ToolCallStatus::is_default`, `skip_serializing_if`). That absence is not a hole: the
    // schema's own default is what it means, and the window reads it that way (`tauri-agent/
    // tools.ts`: `toolStatus(...) ?? prior?.status ?? 'pending'`). Pinned here because it is the
    // reason that fallback is load-bearing rather than decorative.
    assert_eq!(
        statuses,
        vec![None, Some("in_progress"), Some("completed")],
        "pending → in_progress → completed, with `pending` spelled as the schema's default"
    );
    assert_eq!(
        calls[0].get("locations"),
        None,
        "the first frame's empty location list is skipped the same way (`Vec::is_empty`)"
    );

    // Every one of the three belongs to the turn that started the call, which is what stamps the
    // row's run and what lets only that turn's frames settle it.
    assert!(events
        .iter()
        .filter(|event| event.kind == AgentEventKind::ToolUpdate)
        .all(|event| event.run_id.as_deref() == Some(run_id.as_str())));
    runtime.shutdown();
}

#[tokio::test]
async fn the_usage_the_engine_reported_is_published_field_by_field() {
    // P0 §6.3's second measured turn: `cachedReadTokens` where the first turn had
    // `thoughtTokens`, and a `totalTokens` (8895) that is not the sum of input + output. Neither
    // number is ours to compute or to default, so what the host publishes is the engine's object,
    // in the engine's own numbers.
    let (runtime, mut events) = start(&fixture("cached-usage", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    let usage = &events.last().expect("a run-finished event").payload["usage"];
    assert_eq!(usage["inputTokens"], 1721);
    assert_eq!(usage["outputTokens"], 6);
    assert_eq!(
        usage["totalTokens"], 8895,
        "the engine's own total, never a sum"
    );
    assert_eq!(usage["cachedReadTokens"], 7168);
    assert!(
        usage.get("thoughtTokens").is_none(),
        "the field the engine did not send must not appear with a made-up value: {usage}"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_usage_missing_a_core_field_still_reports_the_counters_it_sent() {
    // The pinned schema's own `Usage` is what P0 §6.3 warns about: `totalTokens`, `inputTokens`
    // and `outputTokens` are non-optional `u64`s there, and `PromptResponse.usage` is read with
    // `DefaultOnError`, so an engine that sends a thinner object has the whole usage dropped
    // during deserialization. The fixture's object omits `totalTokens` and keeps the rest, and
    // what this pins is both halves of the rule that governs it:
    //
    //  - the counters the engine *did* send are published as the engine's own numbers, which is
    //    the half that used to be thrown away — `usage: null` said "not provided" about usage
    //    that was provided in part;
    //  - the field it did not send stays absent — never `0`, and never a sum standing in for a
    //    total the engine never reported (1721 + 6 is not a number this host may publish here);
    //  - and the turn still ends normally either way: a decorative count never decides that a
    //    finished turn failed.
    let (runtime, mut events) = start(&fixture("thin-usage", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
    let events = events_until(&mut events, |event| {
        event.kind == AgentEventKind::RunFinished
    })
    .await;

    let last = events.last().expect("a run-finished event");
    assert_eq!(
        last.payload["stopReason"], "end-turn",
        "the turn still ended normally"
    );
    let usage = &last.payload["usage"];
    assert_eq!(
        usage["inputTokens"], 1721,
        "a counter the engine sent must reach the window, not be dropped with the object"
    );
    assert_eq!(usage["outputTokens"], 6);
    assert_eq!(
        usage["cachedReadTokens"], 7168,
        "an optional counter travels the same way: reading only the schema's three required \
         fields is not enough to keep what the engine reported"
    );
    assert!(
        usage.get("totalTokens").is_none(),
        "the field the engine did not send must not appear with a made-up value: {usage}"
    );
    assert!(
        usage.get("thoughtTokens").is_none(),
        "nor may a counter this behaviour never sends be invented: {usage}"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn a_second_prompt_while_running_is_refused() {
    let (runtime, _events) = start(&fixture("stream", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");
    let run_id = runtime
        .prompt(&session.session_id, "first", &[])
        .expect("prompt");
    assert!(run_id.starts_with("run-"));

    let refused = runtime.prompt(&session.session_id, "second", &[]);

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
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    let run_id = runtime
        .prompt(&session.session_id, "hello", &[])
        .expect("prompt");
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
    // Read off the ending rather than off the first frame: the thought chunk the engine sends
    // between the answer's chunks is a host event of its own now, and it is delivered before the
    // cancel (it is not text, so the assertion above is about the answer alone).
    let ending = after
        .iter()
        .find(|event| event.kind == AgentEventKind::RunFinished)
        .expect("the cancelled run still ends");
    assert_eq!(ending.run_id.as_deref(), Some(run_id.as_str()));
    assert_eq!(ending.payload["stopReason"], "cancelled");
    runtime.shutdown();
}

#[tokio::test]
async fn cancelling_an_idle_session_is_not_an_error() {
    // Stop can be pressed in the same instant the answer lands; reporting that
    // race as a fault would be reporting the user's own click as a bug.
    let (runtime, _events) = start(&fixture("good", None)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/tmp"))
        .await
        .expect("session/new");

    runtime.cancel(&session.session_id).await.expect("cancel");
    runtime.shutdown();
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
        let alive = pids
            .iter()
            .any(|pid| Path::new(&format!("/proc/{pid}")).exists());
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
    let binary =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/opencode-x86_64-unknown-linux-gnu");
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
    let response = runtime
        .initialize()
        .await
        .expect("the real engine initializes");

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
