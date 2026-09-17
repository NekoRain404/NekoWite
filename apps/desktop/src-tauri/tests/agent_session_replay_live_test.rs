//! `session/load`'s history replay, measured — the one half of `load` a probe with no turns in
//! the session cannot reach.
//!
//! `agent_session_lifecycle_test.rs` §4.2 measured everything about `load` that needs no prompt:
//! a second engine process on the same profile root reopened a session the first process had
//! created and then died, answered with the engine's own `configOptions`, and served a control
//! call afterwards. What it could not show is the thing the schema defines `load` *by* — that the
//! session "will send `session/update` notifications to replay the session history" — because
//! nothing had ever been said in the session it restored. Its own log says so:
//! `frames the load produced: []`, and the scan report's §6 lists the gap by name.
//!
//! This file spends one prompt to close it. The prompt buys three facts at once, and they are the
//! reason it is worth ~9k input tokens rather than being deferred again:
//!
//! 1. **Whether the engine replays at all**, and with what. A restored session with turns in it
//!    either hands the conversation back or says nothing; the two are different products.
//! 2. **In what shape**, frame by frame, which is what decides whether this host can carry it.
//!    The replay arrives as ordinary `session/update` notifications, and this host's dispatcher
//!    (`runs::forward_update`) attaches turn content to the run a session has in flight — so a
//!    session registered with no run drops every replayed text frame. That is the difference
//!    between `load` being reachable and `load` being wired to nothing, and it is not visible
//!    from the wire alone.
//! 3. **Through this runtime**, not through a hand-written probe. The sequence below is the
//!    product's own path: `AgentRuntime::open_session`, `set_config_option`, `prompt`,
//!    `AgentRuntime::load_session`, and the runtime's own event stream. A green run here is
//!    evidence about the code that ships.
//!
//! **Why this is a separate target from the free lifecycle probe.** That one needs no key and
//! deliberately sits outside `scripts/verify-acp-live.sh`'s three guards so it can be run freely.
//! This one spends money, so it belongs behind the same guards as `agent_live_test.rs` — the
//! artifact, the credential and the profile isolation — and it skips, never fails, when any of
//! them is absent.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use nekowite_lib::agent_runtime::adapters::opencode::MODEL_OPTION_ID;
use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::{
    env_pairs, isolated_profile_env, AgentEventEnvelope, AgentEventKind, AgentIdentity,
    AgentRuntime, AgentRuntimeEvents, EngineConnection, EngineLaunch, VaultFiles, SYSTEM_CA_BUNDLE,
};

/// The artifact P0 §1 pins, gitignored and a pipeline product — the same path
/// `agent_session_lifecycle_test.rs` names.
const ARTIFACT: &str = "binaries/opencode-x86_64-unknown-linux-gnu";

/// The model `agent_live_test.rs` uses, and the same gateway. Not a default this app ships.
const TEST_MODEL: &str = "iapp/deepseek-v4-flash";

/// The shortest prompt that still produces a turn with an assistant message in it. Anything longer
/// buys nothing: what is being measured is whether the *history* comes back, not what it says.
const TEST_PROMPT: &str = "Reply with exactly: PONG";

/// How long one turn may take. `agent_live_test.rs` allows 150s for the same reason.
const RUN_PATIENCE: Duration = Duration::from_secs(150);

/// How long the collector waits for silence before it decides the replay is over.
///
/// The load's response is the barrier the host relies on, so this is only the outer net: it is
/// long enough that a replay frame arriving just after the response is still counted, and short
/// enough that a missing one is not waited on forever.
const REPLAY_SETTLE: Duration = Duration::from_secs(5);

/// How long the first engine gets to leave before the second one is started on its profile root.
///
/// The supervisor's own grace is `process::SHUTDOWN_GRACE` (one second) and it sends `SIGTERM`
/// then `SIGKILL` after that, so this is that sequence with room to spare. Unlike
/// `agent_session_lifecycle_test.rs` — which owns its child process and can `wait()` on it — this
/// file goes through `AgentRuntime`, which deliberately keeps no handle to the process
/// (`EngineConnection::shutdown`'s own note: "the grace window is the engine's, not ours"), so a
/// wall clock is the only instrument left.
const EXIT_GRACE: Duration = Duration::from_secs(3);

/// The profile's provider block, byte for byte the one `agent_live_test.rs` uses.
///
/// Duplicated rather than shared: an integration test target cannot import another's module
/// without a `#[path]` include, and a fixture both files read would have to live somewhere
/// neither owns. The credential is an `{env:…}` reference, so it exists in no file this test
/// writes.
const PROVIDER_CONFIG: &str = r#"{
  "provider": {
    "iapp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "iApp Gateway (test)",
      "options": {
        "baseURL": "https://ai.iapp.dpdns.org/v1",
        "apiKey": "{env:NWK_TEST_KEY}"
      },
      "models": {
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash" }
      }
    }
  }
}
"#;

fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/acp-session-replay")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// The engine, or a printed skip.
///
/// The only input the *control* test needs: nothing there reaches a provider, so a missing
/// credential is not a reason it cannot run. Keeping the two guards apart is what lets the control
/// be run freely, which is the same property `agent_session_lifecycle_test.rs` has and the reason
/// it sits outside `scripts/verify-acp-live.sh`.
fn artifact() -> Option<PathBuf> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(ARTIFACT);
    if path.is_file() {
        return Some(path);
    }
    eprintln!(
        "SKIP: {} is absent; run scripts/fetch-opencode-linux.sh",
        path.display()
    );
    None
}

/// The engine **and** the credential, or a printed skip — what the paying test needs.
///
/// The same guards `agent_live_test.rs` applies, for the reasons that file states: the artifact is
/// a gitignored pipeline product, and the two CA conditions are what make a successful prompt
/// evidence about the *runtime's* own CA injection rather than about an environment that already
/// had one.
fn live_run_inputs() -> Option<(PathBuf, String)> {
    let artifact = match artifact() {
        Some(artifact) => artifact,
        None => return None,
    };
    if std::env::var_os("NODE_EXTRA_CA_CERTS").is_some() {
        eprintln!(
            "SKIP: NODE_EXTRA_CA_CERTS is already set, so this would not be evidence about the \
             runtime's own CA injection"
        );
        return None;
    }
    if !Path::new(SYSTEM_CA_BUNDLE).is_file() {
        eprintln!("SKIP: {SYSTEM_CA_BUNDLE} is absent, so the prompt could not succeed");
        return None;
    }
    match std::env::var("NWK_TEST_KEY") {
        Ok(key) if !key.trim().is_empty() => Some((artifact, key)),
        _ => {
            eprintln!(
                "SKIP: NWK_TEST_KEY is not set; scripts/verify-acp-live.sh is what exports it from \
                 /tmp/nkw-test-key"
            );
            None
        }
    }
}

/// A prompt that asks for a word touches no file, so vault access would mean the engine read
/// something the run never asked for.
struct NoVault;

struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

impl VaultFiles for NoVault {
    fn frontend_path(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a replay probe must not ask a window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a replay probe must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("a replay probe must not write a vault")
    }
}

fn identity(epoch: &str) -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "replay-test".to_string(),
        runtime_epoch: epoch.to_string(),
        vault_id: "vault-replay".to_string(),
    }
}

/// One engine, started the way the app starts it, with the runtime reading its streams.
async fn start(
    artifact: &Path,
    key: &str,
    profile: &Path,
    workspace: &Path,
    epoch: &str,
) -> (AgentRuntime, AgentRuntimeEvents) {
    let mut env = isolated_profile_env(profile);
    env.push(("NWK_TEST_KEY".to_string(), key.to_string()));
    let launch = EngineLaunch {
        program: artifact.to_path_buf(),
        args: vec!["acp".to_string()],
        env: env_pairs(env),
        ca_bundle: None,
    };
    let (connection, engine_events) = EngineConnection::connect(&launch)
        .await
        .expect("the real engine should start");
    let _ = workspace;
    AgentRuntime::new(
        identity(epoch),
        connection,
        engine_events,
        Arc::new(NoVault),
        LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
    )
}

/// Reads every frame the runtime publishes until it has been silent for `quiet`.
///
/// A task rather than a loop at the call site, because the load has to be *awaited* while the
/// stream is being read: `AgentRuntime::load_session` and `AgentRuntimeEvents` are two halves of
/// one runtime and neither call can be interleaved with the other from a single task. This is the
/// same split `driver::install` makes in the app.
fn collector(
    mut events: AgentRuntimeEvents,
    quiet: Duration,
) -> (Arc<Mutex<Vec<AgentEventEnvelope>>>, tokio::task::JoinHandle<()>) {
    let seen: Arc<Mutex<Vec<AgentEventEnvelope>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let handle = tokio::spawn(async move {
        while let Ok(Some(event)) = tokio::time::timeout(quiet, events.next_event()).await {
            sink.lock().unwrap().push(event);
        }
    });
    (seen, handle)
}

/// One bounded line per frame — the shape is the evidence, and an engine's command list is tens of
/// kilobytes.
fn summary(event: &AgentEventEnvelope) -> String {
    let text = match event.kind {
        AgentEventKind::TextDelta => format!("text-delta {:?}", event.payload["text"]),
        AgentEventKind::CommandsChanged => format!(
            "commands-changed ({} commands)",
            event.payload["commands"].as_array().map_or(0, Vec::len)
        ),
        _ => event.payload.to_string(),
    };
    text.chars().take(200).collect()
}

/// The turn a session's history is made of: one prompt, answered.
async fn take_one_turn(runtime: &AgentRuntime, events: &mut AgentRuntimeEvents, workspace: &Path) -> String {
    let opened = runtime
        .open_session(workspace)
        .await
        .expect("session/new against the real engine");
    let session = opened.session_id.clone();
    eprintln!("first engine: session {session}");

    let options = opened.config_options.clone();
    assert!(
        options
            .as_array()
            .is_some_and(|options| options.iter().any(|option| option["id"] == MODEL_OPTION_ID)),
        "the engine returned no option named `{MODEL_OPTION_ID}`, which is the one this \
         engine's adapter names as the model selector: {options}"
    );
    runtime
        .set_config_option(&session, MODEL_OPTION_ID, TEST_MODEL)
        .await
        .expect("the engine accepts the model this probe is configured for");

    let run = runtime
        .prompt(&session, TEST_PROMPT)
        .expect("the turn starts");
    eprintln!("turn {run}: {TEST_PROMPT:?}");

    let deadline = tokio::time::Instant::now() + RUN_PATIENCE;
    let mut text = String::new();
    loop {
        let event = tokio::time::timeout_at(deadline, events.next_event())
            .await
            .unwrap_or_else(|_| panic!("the turn did not end within {RUN_PATIENCE:?}"))
            .expect("the runtime should still be running");
        eprintln!("  first-engine frame seq={} run={:?} {}", event.sequence, event.run_id, summary(&event));
        if event.kind == AgentEventKind::TextDelta {
            if let Some(chunk) = event.payload["text"].as_str() {
                text.push_str(chunk);
            }
        }
        if matches!(
            event.kind,
            AgentEventKind::RunFinished | AgentEventKind::RunFailed
        ) {
            let ended = summary(&event);
            eprintln!("  turn ended: {ended}");
            assert!(
                event.kind == AgentEventKind::RunFinished,
                "the turn failed, so there is no history to replay: {ended}"
            );
            break;
        }
    }
    assert!(
        !text.trim().is_empty(),
        "the turn produced no assistant text, so a replay would have nothing to carry"
    );
    text
}

/// The measurement. See this file's header for what the one prompt buys.
#[tokio::test]
async fn session_load_replays_the_conversation_through_this_runtime() {
    let Some((artifact, key)) = live_run_inputs() else {
        return;
    };

    let profile = scratch("profile");
    let config_dir = profile.join("XDG_CONFIG_HOME/opencode");
    fs::create_dir_all(&config_dir).expect("profile config dir");
    fs::write(config_dir.join("opencode.json"), PROVIDER_CONFIG).expect("provider config");
    let workspace = scratch("workspace");

    // ---- the first engine: one real turn, so the session has a history ------------------------
    let (first, mut first_events) = start(&artifact, &key, &profile, &workspace, "epoch-replay-1").await;
    first
        .initialize()
        .await
        .expect("the engine initializes");
    let answered = take_one_turn(&first, &mut first_events, &workspace).await;
    eprintln!("the assistant answered {answered:?}");

    // The session id has to outlive the process; the runtime's own table is the only place it is.
    let session = {
        let listed = first.list_sessions().await.expect("session/list before the restart");
        assert_eq!(listed.sessions.len(), 1, "one session was opened: {listed:?}");
        listed.sessions[0].session_id.clone()
    };
    first.shutdown();
    drop(first);
    drop(first_events);
    tokio::time::sleep(EXIT_GRACE).await;

    // ---- the second engine: an app restart, and the load -------------------------------------
    let (second, second_events) = start(&artifact, &key, &profile, &workspace, "epoch-replay-2").await;
    second
        .initialize()
        .await
        .expect("the second engine initializes");

    // Started *before* the load, and given a moment to be parked on the stream: a replayed frame
    // that arrives before the collector is reading is a frame this measurement would miss, which
    // would read as "the engine replayed nothing".
    let (seen, handle) = collector(second_events, REPLAY_SETTLE);
    tokio::time::sleep(Duration::from_millis(100)).await;

    let loaded = second.load_session(&session, &workspace).await;
    eprintln!("session/load: {session} answered {loaded:?}");

    // The settle window, so a replay frame arriving just after the response is counted too.
    tokio::time::sleep(REPLAY_SETTLE).await;
    handle.abort();
    let frames = seen.lock().unwrap().clone();

    let replayed: Vec<&AgentEventEnvelope> = frames
        .iter()
        .filter(|frame| frame.session_id == session)
        .collect();
    eprintln!(
        "--- the load produced {} frame(s) for {session}: ",
        replayed.len()
    );
    for frame in &replayed {
        eprintln!("  seq={} run={:?} {}", frame.sequence, frame.run_id, summary(frame));
    }

    let loaded = loaded.unwrap_or_else(|error| {
        panic!(
            "the second engine refused session/load for a session its own profile created: \
             {error:?}"
        )
    });
    assert_eq!(
        loaded.session_id, session,
        "a load answers the id it was asked for"
    );

    // What the measurement is *for*: the conversation comes back as `session/update` frames on
    // the host's own stream. The assertion is deliberately about content rather than about a
    // count — a count of zero and a count of anything else are the two answers, and which one it
    // is has to be reported rather than assumed.
    let replayed_text: String = replayed
        .iter()
        .filter(|frame| frame.kind == AgentEventKind::TextDelta)
        .filter_map(|frame| frame.payload["text"].as_str())
        .collect();
    eprintln!("--- replayed assistant text: {replayed_text:?}");

    assert!(
        replayed.iter().any(|frame| frame.kind == AgentEventKind::TextDelta),
        "session/load produced no text frame for a session with a turn in it, so either the \
         engine does not replay history or this host drops it: {} frame(s) arrived: {:?}",
        replayed.len(),
        replayed.iter().map(|frame| summary(frame)).collect::<Vec<_>>()
    );
    assert!(
        replayed_text.contains(answered.trim()),
        "the replayed text does not carry what the first engine answered — replayed \
         {replayed_text:?}, answered {answered:?}"
    );

    // And the host holds the session afterwards, which is what makes it usable rather than merely
    // displayed.
    let held = second
        .capabilities(&session)
        .expect("the host registered the session it loaded");
    eprintln!("--- after the load, the host reports: {held:?}");

    second.shutdown();
}

/// The same measurement's control: what a `session/load` produces for a session with **no** turns.
///
/// `agent_session_lifecycle_test.rs` §4.2 measured this and printed `frames the load produced: []`.
/// Restating it here is not duplication for its own sake — it is the pair that makes the number
/// above mean something. A run that reports N replayed frames is only evidence of replay if a run
/// with nothing to replay reports none; otherwise both numbers are indistinguishable from "this
/// host prints whatever it likes".
///
/// Costs nothing: `session/new` needs no credential (P0 §2.2) and nothing here reaches a provider.
#[tokio::test]
async fn a_load_whose_session_has_no_turns_replays_nothing() {
    let Some(artifact) = artifact() else { return };
    let profile = scratch("control-profile");
    fs::create_dir_all(profile.join("XDG_CONFIG_HOME/opencode")).expect("profile config dir");
    let workspace = scratch("control-workspace");

    // No credential: nothing in this test reaches a provider, and an empty value is the honest
    // statement that the run had none to give.
    let (first, _first_events) = start(&artifact, "", &profile, &workspace, "epoch-control-1").await;
    first.initialize().await.expect("the engine initializes");
    let opened = first
        .open_session(&workspace)
        .await
        .expect("session/new against the real engine");
    let session = opened.session_id.clone();

    // A load of a session this host **already holds** is refused before the engine is asked, and
    // this is free to check: it is the user picking a row they are already in, and the answer has
    // to be a sentence rather than a second copy of the session replacing the one being followed
    // (`SessionError::AlreadyOpen`). The sibling test's second engine is the other half of the same
    // rule — there, the id is not open and the load goes through.
    let refused = first.load_session(&session, &workspace).await;
    eprintln!("session/load of an open session answered {refused:?}");
    assert!(
        matches!(refused, Err(nekowite_lib::agent_runtime::session::SessionError::AlreadyOpen { .. })),
        "a load of a session this host already holds must be refused by the host, not sent to the \
         engine: {refused:?}"
    );

    first.shutdown();
    drop(first);
    tokio::time::sleep(EXIT_GRACE).await;

    let (second, second_events) = start(&artifact, "", &profile, &workspace, "epoch-control-2").await;
    second.initialize().await.expect("the second engine initializes");
    let (seen, handle) = collector(second_events, REPLAY_SETTLE);
    tokio::time::sleep(Duration::from_millis(100)).await;

    let loaded = second
        .load_session(&session, &workspace)
        .await
        .unwrap_or_else(|error| panic!("the engine refused a load of its own empty session: {error:?}"));
    tokio::time::sleep(REPLAY_SETTLE).await;
    handle.abort();

    let frames: Vec<Value> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|frame| frame.session_id == session)
        .map(|frame| serde_json::json!({ "seq": frame.sequence, "kind": format!("{:?}", frame.kind) }))
        .collect();
    let turn_content: Vec<&Value> = frames
        .iter()
        .filter(|frame| {
            let kind = frame["kind"].as_str().unwrap_or_default();
            matches!(kind, "TextDelta" | "ThoughtDelta" | "ToolUpdate")
        })
        .collect();
    eprintln!(
        "session/load on an empty session: {} answered; {} frame(s) for it: {frames:?}",
        loaded.session_id,
        frames.len()
    );

    // **What a load of an empty session does produce, measured:** exactly one `CommandsChanged`
    // frame carrying the engine's own command list. That is not replay — it is the same
    // announcement the engine makes after `session/new` (P0 §2.2 measured it arriving unasked
    // there too), and it is *session-scoped* rather than turn-scoped, which is why
    // `runs::forward_update` forwards it for a session with no run at all. So the control is
    // stated in terms of turn content and not in terms of "no frames": asserting an empty stream
    // would have been asserting something false about the engine, and the first version of this
    // test did exactly that and failed against the real artifact.
    assert!(
        frames.len() <= 1,
        "a session with no turns produced more frames than the engine's own command list, so \
         there is something here besides that announcement: {frames:?}"
    );
    assert!(
        frames
            .iter()
            .all(|frame| frame["kind"].as_str() == Some("CommandsChanged")),
        "a session with no turns produced a frame that is not the engine's command list: {frames:?}"
    );
    assert!(
        turn_content.is_empty(),
        "a session with no turns produced turn content, so the replayed-text count in the \
         sibling test is not evidence of replay: {turn_content:?}"
    );

    second.shutdown();
}
