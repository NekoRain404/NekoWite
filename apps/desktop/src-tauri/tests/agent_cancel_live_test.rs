//! What the stop button does, against the real pinned engine and a real model.
//!
//! The scan report §4 lists `session/cancel` among the capabilities the engine advertises and
//! nobody has exercised, and its rule is that the advertisement must not be reported as verified.
//! This is the measurement — and unlike the other four, this one has a host path that ships:
//! `agent_cancel_run` → `permissions::cancel_run` → `AgentRuntime::cancel` → the `session/cancel`
//! notification. So this file spends prompts on the path the app really uses rather than on the
//! wire, which is what `agent_session_lifecycle_test.rs` is for.
//!
//! **Two prompts, and what each one buys.** The first is a turn stopped while it is streaming:
//! it is what makes a cancel land mid-generation rather than on a turn that was over anyway. The
//! second is a new turn on the same session, and it is not decoration — it is the only way this
//! runtime can be asked whether the engine actually stopped. The host marks the run cancelled
//! before the engine is ever told (`runs::AgentRuntime::cancel`), so the first prompt alone would
//! measure our own bookkeeping and call the engine's cooperation measured. A second prompt that
//! completes proves the engine let go of the first generation; one that hangs or errors proves it
//! did not, and the patience bound below turns that into a red rather than a wait.
//!
//! **What this does not measure.** The engine's own answer to a cancelled `session/prompt` —
//! whether it reports a stop reason or an error — never reaches a caller: `runs::prompt`'s task
//! reads it and `finish_run` drops it, because the host has already published the ending. The
//! report says so rather than implying otherwise.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::permissions::{cancel_run, PermissionTable};
use nekowite_lib::agent_runtime::{
    env_pairs, isolated_profile_env, AgentEventEnvelope, AgentEventKind, AgentIdentity,
    AgentRuntime, AgentRuntimeEvents, EngineConnection, EngineLaunch, VaultFiles, SYSTEM_CA_BUNDLE,
};

/// The model P0 §2.3 used, set by value for the same reason `agent_live_test.rs` gives: it is a
/// gateway model chosen for this test rather than a default the app ships.
const TEST_MODEL: &str = "iapp/deepseek-v4-flash";

/// The turn the stop is aimed at.
///
/// It has to still be streaming when the press arrives, or the measurement is of a cancel that
/// landed on a turn nobody was having. Two hundred lines is comfortably longer than the round trip
/// to the first chunk, and it costs almost nothing in output tokens — the cancel arrives at the
/// first one.
const LONG_PROMPT: &str = "Count from 1 to 200, one number per line, and nothing else.";

/// The turn sent afterwards, to show the session is still usable. P0 §2.3's prompt: the point is
/// that the path works, not what the model says.
const SHORT_PROMPT: &str = "Reply with exactly: PONG";

/// How long one turn may take. Same bound and same reason as `agent_live_test.rs`: the runtime's
/// own prompt bound is thirty minutes, and a test wants to fail long before that.
const RUN_PATIENCE: Duration = Duration::from_secs(150);

/// How long the event stream is watched after a run has ended.
///
/// The contract says a stopped answer must not look alive again, and the dispatcher drops what the
/// engine keeps sending for a cancelled run. Dropping is not observable from outside except by
/// waiting: this is the wall clock that makes "nothing arrived" a result rather than a comment.
const AFTER_ENDING: Duration = Duration::from_secs(5);

/// The profile's provider block, as P0 §2.3 measured working and `agent_live_test.rs` writes it:
/// the credential is an `{env:…}` reference, never a value.
const PROVIDER_CONFIG: &str = r#"{
  "provider": {
    "iapp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "iApp Gateway (cancel test)",
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

/// A throwaway directory for one live run — under the package's `target/`, which plan §3.2's
/// in-repository requirement and the gitignore both allow, and never the developer's own profile.
fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/acp-live")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// What a live run needs, or the reason there will not be one.
///
/// Skips rather than fails, for the reason `agent_live_test.rs` states: the artifact is gitignored
/// and the key lives outside the repository. `scripts/verify-acp-live.sh` is the caller that
/// refuses to skip.
fn live_run_inputs() -> Option<(PathBuf, String)> {
    let artifact =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/opencode-x86_64-unknown-linux-gnu");
    if !artifact.is_file() {
        eprintln!(
            "SKIP: {} is absent; run scripts/fetch-opencode-linux.sh",
            artifact.display()
        );
        return None;
    }
    // P0 §2.4: without the runtime's CA injection every prompt fails with a message that names
    // neither the host nor the fix. An environment that already names a bundle is not the
    // environment this file is evidence about.
    if std::env::var_os("NODE_EXTRA_CA_CERTS").is_some() {
        eprintln!(
            "SKIP: NODE_EXTRA_CA_CERTS is already set, so this run would not be evidence that the \
             runtime's own CA injection is what made the prompt work"
        );
        return None;
    }
    if !Path::new(SYSTEM_CA_BUNDLE).is_file() {
        eprintln!("SKIP: {SYSTEM_CA_BUNDLE} is absent, so no prompt could succeed");
        return None;
    }
    // The key reaches this process through the environment and nowhere else: never `argv` (world
    // readable in `/proc`), never a config file, never a log line. P0 §3.
    match std::env::var("NWK_TEST_KEY") {
        Ok(key) if !key.trim().is_empty() => Some((artifact, key)),
        _ => {
            eprintln!(
                "SKIP: NWK_TEST_KEY is not set; scripts/verify-acp-live.sh exports it from \
                 /tmp/nwk-test-key"
            );
            None
        }
    }
}

/// The session touches no vault, and this prompt is a counting exercise: a file request would
/// mean the engine read something the run never asked for.
struct NoVault;

/// No window is registered for any vault, so a read would be refused rather than served — the
/// direction the seam is built to fail in.
struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

impl VaultFiles for NoVault {
    fn frontend_path(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a live cancel test must not ask a window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a live cancel test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("a live cancel test must not write a vault")
    }
}

fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "cancel-live-test".to_string(),
        runtime_epoch: "epoch-cancel".to_string(),
        vault_id: "vault-cancel".to_string(),
    }
}

/// One bounded line per event, so `--nocapture` carries the stream without carrying a catalogue.
fn summary(event: &AgentEventEnvelope) -> String {
    let text = match event.kind {
        AgentEventKind::TextDelta => format!("text-delta {:?}", event.payload["text"]),
        _ => event.payload.to_string(),
    };
    text.chars().take(160).collect()
}

/// Reads until the run named by `run_id` ends, printing every frame for its run.
///
/// Frames belonging to another run or to no run are printed and dropped: a session fact arriving
/// mid-turn is P0 §2.2's normal ordering, and phase 1's frames may still be in flight when phase 2
/// starts.
async fn collect_run(events: &mut AgentRuntimeEvents, run_id: &str) -> Vec<AgentEventEnvelope> {
    let deadline = tokio::time::Instant::now() + RUN_PATIENCE;
    let mut collected = Vec::new();
    loop {
        let event = tokio::time::timeout_at(deadline, events.next_event())
            .await
            .unwrap_or_else(|_| panic!("run {run_id} did not end within {RUN_PATIENCE:?}"))
            .expect("the runtime should still be running");
        let mine = event.run_id.as_deref() == Some(run_id);
        eprintln!(
            "  seq={} run={:?} mine={mine} {:?} {}",
            event.sequence,
            event.run_id,
            event.kind,
            summary(&event)
        );
        if !mine {
            continue;
        }
        let ended = matches!(
            event.kind,
            AgentEventKind::RunFinished | AgentEventKind::RunFailed
        );
        collected.push(event);
        if ended {
            return collected;
        }
    }
}

#[tokio::test]
async fn stopping_a_streaming_turn_ends_it_and_leaves_the_session_usable() {
    let Some((artifact, key)) = live_run_inputs() else {
        return;
    };

    // ---- the profile the engine is given -------------------------------------------------------
    let profile = scratch("profile");
    let config_dir = profile.join("XDG_CONFIG_HOME/opencode");
    fs::create_dir_all(&config_dir).expect("profile config dir");
    fs::write(config_dir.join("opencode.json"), PROVIDER_CONFIG).expect("provider config");
    let workspace = scratch("workspace");

    let mut env = isolated_profile_env(&profile);
    env.push(("NWK_TEST_KEY".to_string(), key));
    let launch = EngineLaunch {
        program: artifact,
        args: vec!["acp".to_string()],
        env: env_pairs(env),
        // `None` is the point: the system bundle is what the runtime injects.
        ca_bundle: None,
    };

    let (connection, engine_events) = EngineConnection::connect(&launch)
        .await
        .expect("the real engine should start");
    let (runtime, mut events) = AgentRuntime::new(
        identity(),
        connection,
        engine_events,
        Arc::new(NoVault),
        LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
    );

    runtime.initialize().await.expect("the engine initializes");
    let session = runtime
        .open_session(&workspace)
        .await
        .expect("session/new succeeds with no credentials configured");
    runtime
        .set_config_option(&session.session_id, "model", TEST_MODEL)
        .await
        .expect("session/set_config_option");
    eprintln!("session {} on model {TEST_MODEL}", session.session_id);

    // The table `agent_cancel_run` reaches through. Built with the runtime, exactly as the IPC
    // surface builds it, because the stop path's order — pending prompts ended first, then the
    // engine told — lives in `cancel_run` rather than in `AgentRuntime::cancel`.
    let permissions = PermissionTable::new(identity(), &runtime);

    // ---- 1. a turn, stopped while it is streaming ----------------------------------------------
    let run_id = runtime
        .prompt(&session.session_id, LONG_PROMPT, &[])
        .expect("the session accepts a prompt");
    eprintln!("turn {run_id}: {LONG_PROMPT:?}");

    let stop_at = tokio::time::Instant::now() + RUN_PATIENCE;
    let mut streamed = 0usize;
    let ending = loop {
        let event = tokio::time::timeout_at(stop_at, events.next_event())
            .await
            .unwrap_or_else(|_| {
                panic!("the turn neither streamed nor ended within {RUN_PATIENCE:?}")
            })
            .expect("the runtime should still be running");
        if event.run_id.as_deref() != Some(run_id.as_str()) {
            eprintln!(
                "  seq={} run={:?} (not this run) {:?}",
                event.sequence, event.run_id, event.kind
            );
            continue;
        }
        match event.kind {
            AgentEventKind::TextDelta => {
                streamed += 1;
                if streamed == 1 {
                    // The user's press, through the command's own path.
                    cancel_run(&runtime, &permissions, &session.session_id)
                        .await
                        .expect("the cancel reaches the engine");
                    eprintln!(
                        "  cancelled at seq {} — {}",
                        event.sequence,
                        summary(&event)
                    );
                }
                continue;
            }
            AgentEventKind::RunFinished | AgentEventKind::RunFailed => break event,
            _ => {
                eprintln!(
                    "  seq={} run={:?} {:?} {}",
                    event.sequence,
                    event.run_id,
                    event.kind,
                    summary(&event)
                );
                continue;
            }
        }
    };

    assert!(
        streamed > 0,
        "the turn ended before it streamed anything, so no stop was ever pressed mid-answer; \
         nothing about a cancel was measured: {:?}",
        ending.payload
    );
    // The host's own half: it marks the run cancelled before the engine is told, so this ending is
    // this app's promise about the stop, published on the same stream the window reads.
    assert_eq!(
        ending.kind,
        AgentEventKind::RunFinished,
        "a stopped turn ended as {:?}: {}",
        ending.kind,
        ending.payload
    );
    assert_eq!(
        ending.payload["stopReason"], "cancelled",
        "a stopped turn published {} rather than the contract's `cancelled`",
        ending.payload["stopReason"]
    );
    eprintln!(
        "turn {run_id} ended: {} after {streamed} text chunk(s)",
        ending.payload
    );

    // ---- 1b. nothing more arrives for it --------------------------------------------------------
    let deadline = tokio::time::Instant::now() + AFTER_ENDING;
    loop {
        match tokio::time::timeout_at(deadline, events.next_event()).await {
            // The window closed with nothing: the contract's 「a stopped answer must not look
            // alive again」, watched rather than assumed.
            Err(_) => break,
            Ok(None) => break,
            Ok(Some(event)) => assert!(
                event.run_id.is_none(),
                "a frame for the stopped run arrived after its ending (seq {}): {:?} {}",
                event.sequence,
                event.kind,
                summary(&event)
            ),
        }
    }
    eprintln!("{AFTER_ENDING:?} after the ending, no further frame for {run_id}");

    // ---- 2. the same session, a new turn -------------------------------------------------------
    // This is the half that measures the ENGINE rather than the host. The runtime allowed the
    // prompt because the host considers the run over; if the engine had not stopped generating,
    // this is where it shows — as an error, or as no ending inside RUN_PATIENCE.
    let second = runtime
        .prompt(&session.session_id, SHORT_PROMPT, &[])
        .expect("the session accepts a prompt after a stop");
    eprintln!("turn {second}: {SHORT_PROMPT:?}");
    let collected = collect_run(&mut events, &second).await;
    let ending = collected.last().expect("a run emits an ending");
    assert_eq!(
        ending.kind,
        AgentEventKind::RunFinished,
        "the turn after the stop did not finish: {}",
        ending.payload
    );
    assert_eq!(
        ending.payload["stopReason"], "end-turn",
        "the turn after the stop ended as {}",
        ending.payload["stopReason"]
    );
    let text: String = collected
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .filter_map(|event| event.payload["text"].as_str())
        .collect();
    eprintln!("the turn after the stop answered {text:?}");
    assert!(
        text.to_uppercase().contains("PONG"),
        "the turn after the stop answered {text:?}"
    );

    runtime.shutdown();
}
