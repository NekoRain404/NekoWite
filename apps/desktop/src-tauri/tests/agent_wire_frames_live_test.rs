//! What the pinned engine actually puts on the wire — measured, not inferred.
//!
//! Five rows of `agent-ui-gap-audit-remeasure.md` were left unsettled for one reason: nothing in
//! this tree had ever recorded the pinned engine sending the frames they are about. Row 5
//! (`usage_update`), row 11 (`session_info_update`) and row 21 (`plan`) had a producer added, or a
//! consumer chain waiting, on the strength of *code existing in the artifact* — a byte scan
//! establishes that a sender was compiled in, and nothing about whether it ever fires. Rows 26 and
//! 27 (`_meta.subagent_session_info` on a tool call, and `elicitation/create`) had no measurement
//! at all.
//!
//! **Why this instrument and not the runtime's own event stream.** `AgentRuntimeEvents` carries
//! `normalize_update`'s *output*, and `normalize_update` is exactly the filter three of the five
//! questions are about: a `plan` frame and a `session_info_update` frame fall to `_ => None`
//! (`events.rs:414`), which from up there is indistinguishable from a frame the engine never sent.
//! The replay target's own lesson is the same one one layer down — a drop inside the mapping is
//! invisible from any stream that has already been through it. So this file listens to the
//! **transport**, where the engine's frames are still the engine's:
//!
//! 1. the typed half: `EngineEvents.updates` is the SDK's own `SessionNotification`, before any
//!    host vocabulary is applied;
//! 2. the verbatim half: the launch is wrapped in a two-way `tee`, so every JSON-RPC line in both
//!    directions is on disk beside the run. That is the only place an engine→**client request**
//!    can be seen at all — this host registers no handler for `elicitation/create`, so the SDK
//!    answers such a request `-32601` inside its own dispatch loop and it never reaches a Rust
//!    caller. Without the transcript, row 27 would be unmeasurable through this transport.
//!
//! Everything below the wrapper is the product's own path: the same binary with the same `acp`
//! argument, `isolated_profile_env`'s roots, `NWK_TEST_KEY` through the same environment, the same
//! CA injection, the same `BoundedFrameReader`, the same request bounds, and `EngineConnection`'s
//! own calls. What is skipped is `AgentRuntime`'s bookkeeping, deliberately: that layer's job is
//! to decide which frames reach a window, so asking it whether a frame arrived would be asking the
//! filter to report on what it filtered. The mapping is still measured here — `mapped` below runs
//! the host's own `normalize_update` over each frame that actually arrived.
//!
//! **The prompts are ordinary usage, not probes.** A turn that reads a folder and writes a summary
//! of it is what the composer is for; a turn that searches a folder for a word is what people ask
//! for every day. Neither is shaped to make a frame appear — the point is the opposite, and a
//! negative here is the result worth having.

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionUpdate,
};
use nekowite_lib::agent_runtime::events::normalize_update;
use nekowite_lib::agent_runtime::{
    client_capabilities, env_pairs, isolated_profile_env, EngineConnection, EngineLaunch,
    FsRequest, PermissionRequest, SYSTEM_CA_BUNDLE,
};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

/// The artifact P0 §1 pins, gitignored and a pipeline product — the same path every other live
/// target names.
const ARTIFACT: &str = "binaries/opencode-x86_64-unknown-linux-gnu";

/// The model the other live targets use, and the same gateway. Not a default this app ships.
const TEST_MODEL: &str = "iapp/deepseek-v4-flash";

/// How long one turn may take. The other live targets allow 150s for the same reason.
const RUN_PATIENCE: Duration = Duration::from_secs(150);

/// How long a control call may take. `session/new` and `session/list` reach no provider.
const CALL_BOUND: Duration = Duration::from_secs(60);

/// The profile's provider block, byte for byte the one `agent_live_test.rs` and the replay target
/// use. The credential is an `{env:…}` reference, so it exists in no file this test writes.
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

/// The wrapper the launch goes through.
///
/// Two `tee`s and no other change: the engine is still the program that runs, on the same pipes,
/// with the same environment, in the same process group. What is added is a copy of each direction
/// on disk. `set -o pipefail` so the wrapper's status is the engine's rather than the last
/// `tee`'s, and `exec` is deliberately not used — the second `tee` has to outlive the engine to
/// flush what the engine wrote last.
const WRAPPER: &str = r#"#!/usr/bin/env bash
# Generated by tests/agent_wire_frames_live_test.rs. Records both directions of the ACP
# conversation, then hands the engine's stdio straight back to the caller.
set -uo pipefail
"$NWK_WIRE_ENGINE" "$@" \
  < <(tee -a "$NWK_WIRE_DIR/to-engine.jsonl") \
  | tee -a "$NWK_WIRE_DIR/from-engine.jsonl"
"#;

/// One live connection, in the two halves a caller needs.
struct Live {
    connection: Arc<EngineConnection>,
    updates: UnboundedReceiver<agent_client_protocol::schema::v1::SessionNotification>,
    permissions: UnboundedReceiver<PermissionRequest>,
    fs: UnboundedReceiver<FsRequest>,
    wire: PathBuf,
}

fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/acp-wire-frames")
        .join(format!("{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// The engine, or a printed skip — the same guard every live target uses.
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
/// The same two CA conditions `agent_live_test.rs` applies, for the reason that file states: they
/// are what make a successful prompt evidence about the runtime's own CA injection rather than
/// about an environment that already had one.
fn live_run_inputs() -> Option<(PathBuf, String)> {
    let artifact = artifact()?;
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

/// Starts the engine with the wrapper round it, and the profile's provider config planted.
async fn start(artifact: &Path, key: &str, root: &Path) -> Live {
    let profile = root.join("profile");
    let config_dir = profile.join("XDG_CONFIG_HOME/opencode");
    fs::create_dir_all(&config_dir).expect("profile config dir");
    fs::write(config_dir.join("opencode.json"), PROVIDER_CONFIG).expect("provider config");
    let wire = root.join("wire");
    fs::create_dir_all(&wire).expect("wire dir");

    let script = wire.join("launch.sh");
    fs::write(&script, WRAPPER).expect("wrapper script");
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("wrapper mode");

    let mut env = isolated_profile_env(&profile);
    env.push(("NWK_TEST_KEY".to_string(), key.to_string()));
    env.push((
        "NWK_WIRE_ENGINE".to_string(),
        artifact.to_string_lossy().into_owned(),
    ));
    env.push((
        "NWK_WIRE_DIR".to_string(),
        wire.to_string_lossy().into_owned(),
    ));
    let launch = EngineLaunch {
        program: script,
        args: vec!["acp".to_string()],
        env: env_pairs(env),
        ca_bundle: None,
    };

    let (connection, events) = EngineConnection::connect(&launch)
        .await
        .expect("the real engine should start behind the wrapper");
    Live {
        connection: Arc::new(connection),
        updates: events.updates,
        permissions: events.permissions,
        fs: events.fs,
        wire,
    }
}

/// Answers the reverse requests, so a turn can never hang on one.
///
/// Neither is expected to carry anything — the pinned engine's default configuration asks for
/// nothing (P0 §4 and §7 measured it) — and each request that does arrive is printed, because an
/// unexpected one is a measurement rather than an inconvenience.
fn servant(
    mut permissions: UnboundedReceiver<PermissionRequest>,
    mut fs: UnboundedReceiver<FsRequest>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                permission = permissions.recv() => match permission {
                    Some(request) => {
                        // The engine's own option ids, in the engine's own order: the first is the
                        // least surprising answer a probe with no user can give, and it is the
                        // engine's id rather than one this side invented (§6.3).
                        let option = request
                            .request
                            .options
                            .first()
                            .map(|option| option.option_id.clone());
                        eprintln!(
                            "  !! the engine asked for permission on {:?} — answering {:?}",
                            request.request.tool_call.fields.title, option
                        );
                        if let Some(option_id) = option {
                            let _ = request.responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(option_id),
                                ),
                            ));
                        } else {
                            let _ = request
                                .responder
                                .respond_with_internal_error("the engine offered no option");
                        }
                    }
                    None => break,
                },
                fs = fs.recv() => match fs {
                    Some(request) => {
                        eprintln!("  !! the engine delegated a file request to the host");
                        request.refuse_with(agent_client_protocol::Error::internal_error().data(
                            "a wire probe serves no vault",
                        ));
                    }
                    // The update stream outlives this one only if the connection dies; either way
                    // there is nothing left to answer.
                    None => return,
                },
            }
        }
        while let Some(request) = fs.recv().await {
            request
                .refuse_with(agent_client_protocol::Error::internal_error().data("probe closed"));
        }
    })
}

/// The variant's own name, which is what a frame log is read for.
///
/// Every variant the pinned schema can name is named here rather than left to a wildcard: the
/// frame log is exactly where a variant nobody expected is meant to be legible.
fn variant_of(update: &SessionUpdate) -> &'static str {
    match update {
        SessionUpdate::UserMessageChunk(_) => "user_message_chunk",
        SessionUpdate::AgentMessageChunk(_) => "agent_message_chunk",
        SessionUpdate::AgentThoughtChunk(_) => "agent_thought_chunk",
        SessionUpdate::ToolCall(_) => "tool_call",
        SessionUpdate::ToolCallUpdate(_) => "tool_call_update",
        SessionUpdate::Plan(_) => "plan",
        SessionUpdate::PlanUpdate(_) => "plan_update",
        SessionUpdate::PlanRemoved(_) => "plan_removed",
        SessionUpdate::AvailableCommandsUpdate(_) => "available_commands_update",
        SessionUpdate::CurrentModeUpdate(_) => "current_mode_update",
        SessionUpdate::ConfigOptionUpdate(_) => "config_option_update",
        SessionUpdate::SessionInfoUpdate(_) => "session_info_update",
        SessionUpdate::UsageUpdate(_) => "usage_update",
        SessionUpdate::CompactionUpdate(_) => "compaction_update",
        SessionUpdate::CompactionSummaryChunk(_) => "compaction_summary_chunk",
        other => {
            let _ = other;
            "unnamed-by-this-instrument"
        }
    }
}

/// What the host's own mapping makes of a frame — the other half of every row.
fn mapped(update: &SessionUpdate) -> String {
    match normalize_update(update) {
        Some((kind, payload)) => format!("{kind:?} {}", short(&payload)),
        None => "DROPPED at normalize_update's `_ => None`".to_string(),
    }
}

fn short(value: &Value) -> String {
    value.to_string().chars().take(200).collect()
}

/// Reads every notification that arrives, printing one line each, until `patience` runs out.
///
/// The stream is not closed by the turn's end — the connection outlives the run — so the wait is a
/// clock rather than a sentinel, exactly as the replay target's collector waits for silence.
async fn collect(
    updates: &mut UnboundedReceiver<agent_client_protocol::schema::v1::SessionNotification>,
    patience: Duration,
) -> (Vec<SessionUpdate>, BTreeMap<&'static str, usize>) {
    let mut frames: Vec<SessionUpdate> = Vec::new();
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let deadline = tokio::time::Instant::now() + patience;
    loop {
        let Ok(next) = tokio::time::timeout_at(deadline, updates.recv()).await else {
            break;
        };
        let Some(notification) = next else { break };
        let name = variant_of(&notification.update);
        *counts.entry(name).or_default() += 1;
        eprintln!(
            "  frame {:>3} {name:<26} {}",
            frames.len(),
            mapped(&notification.update)
        );
        frames.push(notification.update);
    }
    (frames, counts)
}

/// The turn a session's frames are read from: one prompt, answered.
///
/// The request is sent on a task of its own while this one reads, because the answer arrives as
/// notifications on the same connection and a single task cannot await both — the same split the
/// replay target's collector makes, and the same one `driver::install` makes in the app.
async fn take_one_turn(
    live: &mut Live,
    workspace: &Path,
    prompt: &str,
) -> (Vec<SessionUpdate>, BTreeMap<&'static str, usize>) {
    let opened = live
        .connection
        .new_session(workspace, CALL_BOUND)
        .await
        .expect("session/new against the real engine");
    let session: SessionId = opened.session_id.clone();
    eprintln!("session {session}");

    let options = serde_json::to_value(&opened.config_options).expect("options serialize");
    assert!(
        options
            .as_array()
            .is_some_and(|options| options.iter().any(|option| option["id"] == "model")),
        "the engine returned no `model` option, which every other live target relies on: {options}"
    );
    live.connection
        .set_config_option(
            session.clone(),
            "model".to_string(),
            TEST_MODEL.to_string(),
            CALL_BOUND,
        )
        .await
        .expect("the engine accepts the model this probe is configured for");

    let asking = {
        let connection = Arc::clone(&live.connection);
        let prompt = prompt.to_string();
        tokio::spawn(async move { connection.prompt(session, &prompt, RUN_PATIENCE).await })
    };

    let (frames, counts) = collect(&mut live.updates, RUN_PATIENCE).await;
    // The prompt's own answer is the turn's end, and it is read *after* the clock rather than
    // before it: the stream does not close when the turn does, so the ending is the fact that
    // says the turn was over rather than a race with a reader.
    let ending = asking.await.expect("the asking task should not panic");
    eprintln!("--- the turn answered {ending:?}");
    (frames, counts)
}

/// Writes a folder with something in it, so "read this folder" is a real request rather than a
/// trick. `deep` adds nested files, which is what a search prompt needs to be worth searching.
fn workspace(root: &Path, deep: bool) -> PathBuf {
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let mut files: Vec<(String, String)> = vec![
        (
            "README.md".to_string(),
            "# Sample\n\nA small folder used as a workspace.\n".to_string(),
        ),
        (
            "notes.md".to_string(),
            "# Notes\n\nThe project has three parts.\n".to_string(),
        ),
        (
            "config.json".to_string(),
            "{\n  \"retries\": 3,\n  \"timeout\": 30\n}\n".to_string(),
        ),
        (
            "src/main.rs".to_string(),
            "fn main() {\n    println!(\"retry policy: 3 attempts\");\n}\n".to_string(),
        ),
        (
            "src/lib.rs".to_string(),
            "pub fn retries() -> u32 {\n    3\n}\n".to_string(),
        ),
    ];
    if deep {
        for (index, area) in ["client", "server", "shared", "tools"].iter().enumerate() {
            for module in 0..4 {
                files.push((
                    format!("crates/{area}/src/module{module}.rs"),
                    format!(
                        "//! {area} module {module}.\n\npub const TIMEOUT_MS: u64 = {};\n\n\
                         pub fn describe() -> &'static str {{\n    \"{area} {module}\"\n}}\n",
                        (index + 1) * (module + 1) * 1000
                    ),
                ));
            }
            files.push((
                format!("crates/{area}/tests/basic.rs"),
                format!("#[test]\nfn {area}_answers() {{\n    assert!(true);\n}}\n"),
            ));
        }
    }
    for (name, body) in files {
        let path = workspace.join(&name);
        fs::create_dir_all(path.parent().unwrap()).expect("workspace dirs");
        fs::write(&path, body).expect("workspace file");
    }
    workspace
}

/// What one turn produced, or `None` when the inputs were absent and the test skipped.
struct Turn {
    tool_frames: Vec<String>,
    counts: BTreeMap<&'static str, usize>,
}

/// One turn at a time, across every test in this target.
///
/// `cargo test` runs a target's tests in parallel by default, and two engine processes reading two
/// frame streams at once would interleave their logs into one another's output and reach the
/// provider with two requests in the same instant. Serialized, the log of a run is that run's.
fn one_turn_at_a_time() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// One whole turn: start the engine, plant the folder, ask, log every frame.
async fn one_turn(label: &str, deep: bool, prompt: &str) -> Option<Turn> {
    let _one_at_a_time = one_turn_at_a_time().lock().await;
    // `live_run_inputs` has already printed the SKIP line, so a `None` here is a skipped run and
    // never an assertion about a turn that did not happen.
    let (artifact, key) = live_run_inputs()?;
    let root = scratch(label);
    let workspace = workspace(&root, deep);

    let mut live = start(&artifact, &key, &root).await;
    let _servant = servant(
        std::mem::replace(&mut live.permissions, unused::<PermissionRequest>()),
        std::mem::replace(&mut live.fs, unused::<FsRequest>()),
    );
    live.connection
        .initialize(CALL_BOUND)
        .await
        .expect("the engine initializes");
    eprintln!(
        "the host advertises: {}",
        serde_json::to_value(client_capabilities()).expect("capabilities serialize")
    );

    eprintln!("prompt: {prompt:?}");
    let (frames, counts) = take_one_turn(&mut live, &workspace, prompt).await;
    let tool_frames = report(&live.wire, &frames, &counts);
    live.connection.shutdown();
    Some(Turn {
        tool_frames,
        counts,
    })
}

/// The four variants the audit's §2 item 5 names, checked on one turn.
fn assert_measured_absent(turn: &Turn, which: &str) {
    for (wanted, because) in MEASURED_ABSENT {
        assert_eq!(
            turn.counts.get(wanted).copied().unwrap_or(0),
            0,
            "the pinned engine sent a `{wanted}` frame on the {which} turn: {because}. Then move \
             the row in `.superpowers/sdd/roadmap/reports/agent-ui-gap-audit-remeasure.md`."
        );
    }
}

/// The engine's own frames, on a turn that does what a composer is for.
#[tokio::test]
async fn the_pinned_engine_s_update_variants_on_a_tool_using_turn() {
    let Some(turn) = one_turn(
        "wire-summary",
        false,
        "The files in this folder are a small project. Read them and write a short summary into \
         SUMMARY.md: one line per file, with a two-line overview at the top.",
    )
    .await
    else {
        return;
    };
    assert_measured_absent(&turn, "read-and-summarise");
    assert_no_subagent_key(&turn.tool_frames, "read-and-summarise");
    assert!(
        turn.counts.get("tool_call").copied().unwrap_or(0) > 0,
        "the turn produced no tool call at all, so it says nothing about the frames a tool call is \
         made of: {:?}",
        turn.counts
    );
}

/// A second turn, on a tree worth searching — where a subagent would be the ordinary instrument.
///
/// Row 26 asks whether a tool call ever carries `_meta.subagent_session_info`. The first turn
/// answers the half that matters (no tool call carries a `_meta` member at all, over three
/// different kinds), and this one is the case where an engine that had such a key would use it —
/// and the second, independent turn on which the four absences above are read.
#[tokio::test]
async fn a_search_turn_carries_no_subagent_key_on_its_tool_calls() {
    let Some(turn) = one_turn(
        "wire-search",
        true,
        "Find every place in this project where a timeout is configured, and write what you find \
         into FINDINGS.md as a list of file paths with the value each one sets.",
    )
    .await
    else {
        return;
    };
    assert_no_subagent_key(&turn.tool_frames, "search");
    assert_measured_absent(&turn, "search");
}

/// A receiver that is already closed, for a channel this run has handed to someone else.
fn unused<T>() -> UnboundedReceiver<T> {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    drop(sender);
    receiver
}

/// Everything the frame log is read for, in one block.
///
/// Returns the tool-call frames, because row 26's question is about a member of one of them.
fn report(
    wire: &Path,
    frames: &[SessionUpdate],
    counts: &BTreeMap<&'static str, usize>,
) -> Vec<String> {
    eprintln!("--- variant counts: {counts:?}");

    let from_engine = fs::read_to_string(wire.join("from-engine.jsonl")).unwrap_or_default();
    let to_engine = fs::read_to_string(wire.join("to-engine.jsonl")).unwrap_or_default();
    let requests: Vec<&str> = from_engine
        .lines()
        .filter(|line| {
            serde_json::from_str::<Value>(line)
                .is_ok_and(|value| value.get("id").is_some() && value.get("method").is_some())
        })
        .collect();
    eprintln!(
        "--- the transcript at {}: {} line(s) from the engine, {} to it, {} engine->client \
         request(s): {requests:?}",
        wire.display(),
        from_engine.lines().count(),
        to_engine.lines().count(),
        requests.len(),
    );

    // The tool call's own shape, printed whole: row 26 is a question about a member of this frame
    // and cannot be answered from a variant count.
    for frame in frames {
        if let SessionUpdate::ToolCall(call) = frame {
            eprintln!(
                "--- tool_call verbatim: {}",
                serde_json::to_string(call).unwrap_or_default()
            );
            break;
        }
    }

    let tool_frames: Vec<String> = from_engine
        .lines()
        .filter(|line| line.contains("\"tool_call\"") || line.contains("\"tool_call_update\""))
        .map(str::to_string)
        .collect();
    eprintln!(
        "--- {} tool-call frame(s) in the transcript, {} of them naming a metadata or subagent key",
        tool_frames.len(),
        // The same structural question the assertion asks, for the same reason: this number is
        // read as evidence, and a count taken over the line's text would have said 1 on the turn
        // that read this file.
        tool_frames
            .iter()
            .filter(|line| carries_a_metadata_member(line))
            .count()
    );

    for (wanted, _) in MEASURED_ABSENT {
        let n = counts.get(wanted).copied().unwrap_or(0);
        eprintln!("--- {wanted}: {n} frame(s) on this turn");
    }
    tool_frames
}

/// What each measured absence would mean if it stopped being one.
///
/// A table rather than four copies of one assertion, because the four are **not** the same
/// finding and a red has to say which one moved. All four were measured absent on the pinned
/// artifact, over two ordinary turns each carrying a tool call.
const MEASURED_ABSENT: [(&str, &str); 4] = [
    (
        "plan",
        "row 21's producer is now real: the contract type (`payloads.ts`), the reducer arm \
         (`agent-event-apply.ts`) and `view.plan` all exist, and `agent_runtime/events.rs`'s \
         `normalize_update` is the one layer with no arm for it",
    ),
    (
        "session_info_update",
        "row 11's producer is now real: the contract's `session-changed` and `view.title` exist, \
         and only the `normalize_update` arm is missing",
    ),
    (
        "current_mode_update",
        "one of the four variants `agent-ui-gap-audit-remeasure.md` §2 item 5 lists as swallowed \
         at `events.rs`'s `_ => None`; the contract's `mode-changed` is already there",
    ),
    (
        "usage_update",
        "row 5's arm is already written (`UsageChanged`), so nothing is owed — what changed is \
         that the engine's own context-limit guard stopped firing for this model, and the \
         window's usage ring now has a producer",
    ),
];

/// Row 26, checked on whichever turn just ran.
///
/// Zed keys its subagent card on `_meta.subagent_session_info` (`acp_thread.rs:126,288-292`), so
/// the question is whether a tool call carries that member. The check reads the transcript rather
/// than a variant count, because `_meta` is a member of a frame; and it is written as "no
/// metadata member at all", because an engine that emitted an empty `_meta` would be a different
/// finding from one that emits none.
///
/// **It reads the member, not the line's text, and that distinction was learned the hard way.**
/// The first version asked `line.contains("_meta") || line.contains("subagent")` over the
/// serialized frame — and it went red on a turn whose only offence was *reading this file*, whose
/// comments contain both words. A tool call's `content` and `rawOutput` carry whatever the agent
/// read, so a substring answers 「did those characters appear anywhere in the payload」, which is
/// not the question. The frame is parsed and its own members are walked instead.
fn assert_no_subagent_key(tool_frames: &[String], turn: &str) {
    assert!(
        !tool_frames.is_empty(),
        "the {turn} turn produced no tool call, so it says nothing about row 26's question"
    );
    let offenders: Vec<&String> = tool_frames
        .iter()
        .filter(|line| carries_a_metadata_member(line))
        .collect();
    assert!(
        offenders.is_empty(),
        "a tool-call frame in the {turn} turn now carries a metadata member: {offenders:?}. If the \
         member is `subagent_session_info`, Zed's card is reachable and row 26's answer has \
         changed from \"the engine never sends one\" to \"the host drops it\""
    );
}

/// Whether one transcript line's `session/update` carries a `_meta` member of its own.
///
/// The `update` object is the frame, so a `_meta` beside `toolCallId`/`title`/`kind` is the
/// finding. Everything nested under `content` or `rawOutput` is the agent's material — a file it
/// read, a command's output — and a member found there would be a fact about the file rather than
/// about the frame. A line that will not parse is not a tool call and carries nothing.
fn carries_a_metadata_member(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("params")?.get("update").cloned())
        .is_some_and(|update| update.get("_meta").is_some())
}

/// The detector, on the two frames that tell it apart — and the first is the real one.
///
/// This costs no prompt and is the red the fix was written against. The first line is a
/// `tool_call_update` whose `content` carries **this file's own text**, which names `_meta` and
/// `subagent` in prose: a substring check calls it an offender, and that is exactly how the live
/// run went red. The second carries the member the check is for. A detector that cannot separate
/// them is not measuring the frame.
#[test]
fn a_metadata_member_is_the_frames_own_and_not_the_text_it_carries() {
    let window_read_of_this_file = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call_1",
                "status": "completed",
                "title": "tests/agent_wire_frames_live_test.rs",
                "content": [{
                    "type": "content",
                    "content": {
                        "type": "text",
                        "text": "Zed keys its subagent card on `_meta.subagent_session_info`, \
                                 so the question is whether a tool call carries that member."
                    }
                }]
            }
        }
    })
    .to_string();
    assert!(
        !carries_a_metadata_member(&window_read_of_this_file),
        "a file whose text mentions the member is not a frame that carries it"
    );

    let frame_that_carries_one = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "ses_1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "call_2",
                "title": "task",
                "_meta": { "subagent_session_info": { "sessionId": "ses_2" } }
            }
        }
    })
    .to_string();
    assert!(
        carries_a_metadata_member(&frame_that_carries_one),
        "a member beside toolCallId is the finding this check exists for"
    );

    assert!(
        !carries_a_metadata_member("not json at all"),
        "a line that is not a frame carries nothing"
    );
}

/// The wrapper records both directions without changing the handshake — and costs no prompt.
///
/// Run this first: it is the control that makes the paying test's transcript evidence about the
/// engine rather than about the wrapper. `session/new` needs no credential (P0 §2.2) and nothing
/// here reaches a provider.
#[tokio::test]
async fn the_wrapper_records_both_directions_without_changing_the_handshake() {
    let _one_at_a_time = one_turn_at_a_time().lock().await;
    let Some(artifact) = artifact() else { return };
    let root = scratch("wrapper-control");
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");

    let mut live = start(&artifact, "", &root).await;
    let _servant = servant(
        std::mem::replace(&mut live.permissions, unused::<PermissionRequest>()),
        std::mem::replace(&mut live.fs, unused::<FsRequest>()),
    );
    let initialized = live
        .connection
        .initialize(CALL_BOUND)
        .await
        .expect("the engine initializes through the wrapper");
    eprintln!("handshake: {initialized:?}");
    eprintln!(
        "the host advertises: {}",
        serde_json::to_value(client_capabilities()).expect("capabilities serialize")
    );

    let opened = live
        .connection
        .new_session(&workspace, CALL_BOUND)
        .await
        .expect("session/new through the wrapper");
    eprintln!("session/new: {}", opened.session_id);

    // The engine announces its command list right after `session/new` (P0 §2.2). Reading until
    // the clock runs out is what proves the transcript's pipes are live rather than merely made.
    let (frames, counts) = collect(&mut live.updates, Duration::from_secs(10)).await;
    eprintln!(
        "--- after session/new: {} frame(s) {counts:?}",
        frames.len()
    );

    let to_engine = fs::read_to_string(live.wire.join("to-engine.jsonl")).expect("outbound");
    let from_engine = fs::read_to_string(live.wire.join("from-engine.jsonl")).expect("inbound");
    for (direction, body) in [("us -> engine", &to_engine), ("engine -> us", &from_engine)] {
        eprintln!("--- {direction}: {} line(s)", body.lines().count());
    }

    assert!(
        to_engine.contains("\"method\":\"initialize\"")
            && to_engine.contains("\"method\":\"session/new\""),
        "the outbound transcript does not hold the calls this test made, so it is not recording: \
         {} line(s)",
        to_engine.lines().count()
    );
    assert!(
        from_engine.contains("\"session/new\"") || from_engine.contains("\"sessionUpdate\""),
        "the inbound transcript holds nothing the engine said, so the second tee is not wired: {} \
         line(s)",
        from_engine.lines().count()
    );
    // What the handshake buys is the session and its options; a wrapper that had changed the
    // framing would show up as an answer with neither.
    assert!(
        opened
            .config_options
            .as_ref()
            .is_some_and(|options| !options.is_empty()),
        "the engine answered `session/new` through the wrapper with no configuration options, so \
         the wrapper is not transparent to the conversation"
    );

    live.connection.shutdown();
}
