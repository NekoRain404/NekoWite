//! The runtime against the real pinned engine and a real model.
//!
//! `agent_runtime_test.rs` drives the runtime against a shell fixture and stops the real engine at
//! its handshake, because everything below the handshake used to cost money. What that leaves
//! untested is the half of the protocol the app actually spends its time in: `session/new`,
//! `session/set_config_option`, `session/prompt`, the event stream a real engine produces, and the
//! usage that comes back with the answer. P0 §2/§6 measured all of those through hand-written
//! probes talking *directly* to the binary; none of them had ever been measured through this
//! runtime.
//!
//! So this file spends one prompt. It is the only test in the suite that does, and it is written to
//! be skipped — never failed — by a checkout that cannot afford one.
//!
//! Read P0 §2.2, §2.3, §2.4, §6.1, §6.3 and §7 first: the assertions below are those measurements,
//! moved from a probe to the runtime that ships.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::Usage;
use serde_json::{json, Value};

use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::{
    env_pairs, isolated_profile_env, AgentEventEnvelope, AgentEventKind, AgentIdentity,
    AgentRuntime, AgentRuntimeEvents, EngineConnection, EngineLaunch, VaultFiles, SYSTEM_CA_BUNDLE,
};

/// The model P0 §2.3 used. It is a gateway model chosen for this test rather than a default the app
/// ships, which is why it is set by value here instead of being read from anywhere.
const TEST_MODEL: &str = "iapp/deepseek-v4-flash";

/// P0 §2.3's prompt, which produced a three-token answer and cost 8,732 tokens of input. Anything
/// longer buys nothing: the point is that the path works end to end, not what the model says.
const TEST_PROMPT: &str = "Reply with exactly: PONG";

/// How long the answer may take. The runtime's own prompt bound is thirty minutes (§6.2 asks for a
/// net, not a budget); a test wants to fail long before that.
const RUN_PATIENCE: Duration = Duration::from_secs(150);

/// The profile's provider block, in the shape P0 §2.3 measured working.
///
/// The credential is an `{env:…}` reference, never a value: the engine resolves it out of the
/// environment it was spawned with, so the key exists in no file this test writes and in no
/// argument it passes. The `name` says test so that an engine log or an invoice is attributable.
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

/// A throwaway directory for one live run.
///
/// Under the package's `target/` rather than `/tmp`, because plan §3.2 requires the test profile to
/// be *inside the repository* and forbids reading or writing the developer's real credentials; this
/// is the one directory in the tree that is already gitignored and already scratch space.
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
/// Everything here is a *skip* rather than a failure, for the reason the fixture-era real-engine
/// test gives: the artifact is a gitignored pipeline product and the key lives outside the
/// repository, so both are legitimately absent from a checkout. `scripts/verify-acp-live.sh` is the
/// caller that refuses to skip — it checks both before it starts cargo.
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

    // P0 §2.4, the blocking finding: the engine's bundled store has no Let's Encrypt 2025
    // hierarchy, so without a CA bundle *every* prompt fails with a message that names neither the
    // host nor the fix. The runtime injects the system bundle when the environment does not already
    // name one (`process::resolve_ca_bundle`), so an environment that names one is not the
    // environment this test is evidence about.
    if std::env::var_os("NODE_EXTRA_CA_CERTS").is_some() {
        eprintln!(
            "SKIP: NODE_EXTRA_CA_CERTS is already set in this environment, so the engine would \
             inherit it and this run would not be evidence that the runtime's own CA injection is \
             what made the prompt work"
        );
        return None;
    }
    if !Path::new(SYSTEM_CA_BUNDLE).is_file() {
        eprintln!(
            "SKIP: {SYSTEM_CA_BUNDLE} is absent, so this host has no bundle for the runtime to \
             inject and the prompt could not succeed"
        );
        return None;
    }

    // The key reaches this process through the environment and nowhere else: never `argv` (world
    // readable in `/proc`), never a config file, never a log line. P0 §3.
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

/// The session touches no vault: this prompt asks for a word, so a file request would mean the
/// engine read something the run never asked for.
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
        panic!("a live prompt test must not ask a window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a live prompt test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("a live prompt test must not write a vault")
    }
}

fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "live-test".to_string(),
        runtime_epoch: "epoch-live".to_string(),
        vault_id: "vault-live".to_string(),
    }
}

/// The option with this id, as the engine sent it.
///
/// The runtime hands the engine's own list through untouched (`session::SessionInfo`), so this
/// looks at the wire's shape rather than at a shape this host rebuilt — which is §6.3's rule that
/// the option ids belong to the engine.
fn config_option<'a>(options: &'a Value, id: &str) -> Option<&'a Value> {
    options.as_array()?.iter().find(|option| option["id"] == id)
}

/// Reads host events until the run ends, printing each one as it arrives.
///
/// The printing is the evidence: `--nocapture` is how a reader sees what the real engine actually
/// produced, without a second paid probe to ask it again.
async fn collect_run(events: &mut AgentRuntimeEvents) -> Vec<AgentEventEnvelope> {
    let deadline = tokio::time::Instant::now() + RUN_PATIENCE;
    let mut collected = Vec::new();
    loop {
        let event = tokio::time::timeout_at(deadline, events.next_event())
            .await
            .unwrap_or_else(|_| panic!("the run did not end within {RUN_PATIENCE:?}"))
            .expect("the runtime should still be running");
        eprintln!(
            "event[{}] seq={} run={:?} {}",
            collected.len(),
            event.sequence,
            event.run_id,
            summary(&event)
        );
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

/// One bounded line per event. The shape is the evidence, not the whole payload: an engine's model
/// catalogue and its command list are tens of kilobytes each.
fn summary(event: &AgentEventEnvelope) -> String {
    let text = match event.kind {
        AgentEventKind::TextDelta => format!("text-delta {:?}", event.payload["text"]),
        AgentEventKind::CommandsChanged => format!(
            "commands-changed ({} commands)",
            event.payload["commands"].as_array().map_or(0, Vec::len)
        ),
        _ => event.payload.to_string(),
    };
    text.chars().take(400).collect()
}

#[tokio::test]
async fn the_real_engine_completes_a_real_prompt() {
    let Some((artifact, key)) = live_run_inputs() else {
        return;
    };

    // ---- the profile the engine is given -------------------------------------------------------
    // The runtime's own isolation helper, so what is under test is the environment the app would
    // build. `opencode.json` goes where the engine's config lookup reads it: `$XDG_CONFIG_HOME`.
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
        // A `Secret` from here on: the derived `Debug` on `EngineLaunch` cannot print it.
        env: env_pairs(env),
        // `None` is the point of the run: the system bundle is what the runtime injects.
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

    // ---- 1. the handshake (P0 §2.1) ------------------------------------------------------------
    let handshake = runtime.initialize().await.expect("the engine initializes");
    assert_eq!(handshake.protocol_version.as_u16(), 1, "protocolVersion");
    let info = handshake.agent_info.expect("agentInfo");
    assert_eq!(info.name, "OpenCode");
    eprintln!(
        "handshake: protocolVersion=1 agentInfo={} {}",
        info.name, info.version
    );

    // ---- 2. the session (P0 §2.2) --------------------------------------------------------------
    // No credentials are involved: the engine opens a session with none configured, and the
    // provider is chosen afterwards through the model option.
    let session = runtime
        .open_session(&workspace)
        .await
        .expect("session/new succeeds with no credentials configured");
    assert!(!session.session_id.is_empty(), "session/new returned no id");
    let model = config_option(&session.config_options, "model")
        .unwrap_or_else(|| panic!("no model selector in {:?}", session.config_options));
    assert_eq!(
        model["type"], "select",
        "the model option is not a selector"
    );
    eprintln!(
        "session: {} model option: current={} choices={}",
        session.session_id,
        model["currentValue"],
        model["options"].as_array().map_or(0, Vec::len)
    );

    // ---- 3. the model (P0 §2.3) ----------------------------------------------------------------
    // Mid-session switching works on the pinned engine: the response reports the chosen value as
    // current, which is what makes this call the credential path rather than a wish.
    let options = runtime
        .set_config_option(&session.session_id, "model", TEST_MODEL)
        .await
        .expect("session/set_config_option");
    let model = config_option(&options, "model").expect("the answer keeps the model option");
    assert_eq!(
        model["currentValue"], TEST_MODEL,
        "the engine did not report the chosen model as current"
    );

    // ---- 4. one prompt, and everything it produces ---------------------------------------------
    let run_id = runtime
        .prompt(&session.session_id, TEST_PROMPT, &[])
        .expect("the session accepts a prompt");
    eprintln!("prompt sent, host run id {run_id}");
    let collected = collect_run(&mut events).await;

    // ---- 5. it ended, and it ended the way a finished turn ends ---------------------------------
    let ending = collected.last().expect("a run emits an ending");
    assert_eq!(
        ending.kind,
        AgentEventKind::RunFinished,
        "the run did not finish: {}",
        ending.payload
    );
    // The engine answers `end_turn` (P0 §2.3, and the fixture sends the protocol's snake_case);
    // the host publishes the contract's spelling of the same reason (`runs::wire_stop_reason`).
    assert_eq!(ending.payload["stopReason"], "end-turn");

    // ---- 6. text arrived, and it is the answer --------------------------------------------------
    let chunks: Vec<&str> = collected
        .iter()
        .filter(|event| event.kind == AgentEventKind::TextDelta)
        .filter_map(|event| event.payload["text"].as_str())
        .collect();
    let text = chunks.join("");
    assert!(
        !chunks.is_empty(),
        "the engine streamed no text chunk; the run produced {:?}",
        collected.iter().map(|event| event.kind).collect::<Vec<_>>()
    );
    eprintln!("reply in {} chunk(s): {text:?}", chunks.len());
    assert!(
        text.to_uppercase().contains("PONG"),
        "the reply did not contain PONG: {text:?}"
    );

    // ---- 7. the usage (P0 §6.3) -----------------------------------------------------------------
    // The runtime serializes the engine's own object rather than a struct of its own
    // (`runs::prompt`), because §6.3 measured the field set changing between identical runs and
    // `totalTokens` not being `input + output`. What can be asserted here is that nothing was
    // added: every count present is the engine's, and `a_usage_field_the_engine_did_not_send_is_
    // absent_rather_than_zero` pins the other half — that a count the engine withholds is absent
    // rather than 0.
    let published = &ending.payload["usage"];
    let usage = published
        .as_object()
        .unwrap_or_else(|| panic!("usage was not an object: {published}"));
    for field in ["inputTokens", "outputTokens", "totalTokens"] {
        assert!(
            usage.get(field).is_some_and(Value::is_u64),
            "usage.{field} is missing from {usage:?}"
        );
    }
    let carried: Vec<&str> = ["thoughtTokens", "cachedReadTokens", "cachedWriteTokens"]
        .into_iter()
        .filter(|field| usage.contains_key(*field))
        .collect();
    for (field, value) in usage {
        assert!(
            value.is_u64(),
            "usage.{field} is {value}: a count the engine sent is a count, and one it did not send \
             must be absent, never rendered as a number"
        );
    }
    eprintln!("usage: {published} optional fields the engine sent: {carried:?}");

    runtime.shutdown();
}

/// The absent-is-not-zero property, on the two shapes P0 §6.3 measured.
///
/// Live this property is expensive to reach: making the engine send one field set and then the
/// other is two more real prompts, and the scan already holds both. What is cheap, and is the half
/// that would actually break, is the encoding the runtime publishes through — `runs::prompt`
/// serializes `PromptResponse::usage` with the expression used here. A hand-built struct with
/// defaulted counts would report a field the engine never sent as 0; the SDK's `Usage` keeps the
/// three variable fields an `Option` and skips them when they are unset, and this pins that with
/// the measured frames rather than with an invented one.
#[test]
fn a_usage_field_the_engine_did_not_send_is_absent_rather_than_zero() {
    // P0 §6.3, probes 3 and 4: same engine, same model, same script, two different field sets.
    let probe_3 = json!({
        "inputTokens": 8717, "outputTokens": 3, "totalTokens": 8732, "thoughtTokens": 12
    });
    let probe_4 = json!({
        "inputTokens": 1721, "outputTokens": 6, "totalTokens": 8895, "cachedReadTokens": 7168
    });

    let publish = |frame: Value| {
        json!({
            "usage": serde_json::from_value::<Usage>(frame)
                .expect("a frame the engine really sent reads as the SDK's own usage type")
        })
    };

    let first = publish(probe_3);
    assert_eq!(first["usage"]["thoughtTokens"], 12);
    assert!(
        first["usage"].get("cachedReadTokens").is_none(),
        "a field probe 3 never sent came back as {}",
        first["usage"]["cachedReadTokens"]
    );

    let second = publish(probe_4);
    assert_eq!(second["usage"]["cachedReadTokens"], 7168);
    assert!(
        second["usage"].get("thoughtTokens").is_none(),
        "a field probe 4 never sent came back as {}",
        second["usage"]["thoughtTokens"]
    );
}
