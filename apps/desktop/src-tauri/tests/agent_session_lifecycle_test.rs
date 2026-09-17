//! The four session-management methods the engine advertises and this host never calls.
//!
//! The scan report §4 lists `session/load`, `fork`, `close` and `list` as capabilities the
//! engine's handshake claims and nobody has exercised — and its own rule is that the claim must
//! not be reported as verified. This file is the measurement, and it costs nothing: `session/new`
//! needs no credentials (P0 §2.2 measured that), and none of these calls reaches a provider. A
//! session the engine opened is enough to ask every one of them.
//!
//! **Which engine.** The pinned artifact, started the way `AgentRuntime` starts it — the same
//! `acp` argument and the same `isolated_profile_env` roots. What differs is the speaker.
//!
//! **Why the wire instead of our runtime.** `src/agent_runtime` has no method for any of these
//! four: its only outbound calls are `initialize`, `session/new`, `session/set_config_option`,
//! `session/prompt` and `session/cancel` (`acp_transport/calls.rs`). There is therefore no host
//! path to measure. What is in question is the engine's own side of its own advertisement, and
//! the wire is the honest instrument for that.
//!
//! **What this shows, and what it does not.** It shows each method exists, accepts the shape the
//! pinned schema defines, and leaves the engine in the state it promises: the session in the
//! list, gone from it after a close, or reopened by a second process after the one that made it
//! is gone. It does **not** show what a restored *conversation* looks like — that needs turns in
//! the session, and a turn is a prompt, which costs money. The comments say where that line falls.
//!
//! The frames below are the SDK's own wire shape, read off `agent_client_protocol_schema` 1.7.0
//! (`session/load` `{sessionId, cwd, mcpServers}`, `session/close` `{sessionId}`,
//! `session/list` `{cwd?, cursor?}` → `{sessions: [{sessionId, cwd, …}]}`), so a refusal here is
//! the engine's answer about the engine's contract rather than a request this file invented.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

use nekowite_lib::agent_runtime::isolated_profile_env;

/// The artifact P0 §1 pins. Gitignored and a pipeline product, so its absence is a checkout
/// state rather than a failure — every test here skips on it, and `scripts/verify-acp-live.sh`
/// is the caller that refuses to skip.
const ARTIFACT: &str = "binaries/opencode-x86_64-unknown-linux-gnu";

/// How long one answer may take. Every call here is answered out of the engine's own state or
/// its own database, so this is a net for a wedged process rather than a budget for a turn.
const PATIENCE: Duration = Duration::from_secs(30);

/// P0 §2.1's negotiated version, in P0's own request shape.
const PROTOCOL_VERSION: u64 = 1;

/// How long the engine gets to exit on its own before it is killed. The runtime's own
/// `SHUTDOWN_GRACE` is one second; the tests that start a *second* engine on the same profile
/// root can afford to wait longer for the first to let go of the database it shares.
const EXIT_GRACE: Duration = Duration::from_secs(15);

/// The artifact, or a printed skip and `None`.
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

/// A throwaway directory for one test, under the package's `target/` — the one directory in the
/// tree that is already gitignored scratch space, and the one place plan §3.2 allows a test
/// profile to live (never the developer's own `~/.config/opencode`).
fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/acp-session-lifecycle")
        .join(format!("{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

/// One engine process, spoken to over newline-delimited JSON-RPC on stdio — the transport
/// `EngineConnection` uses, minus the SDK, so that every frame this file reasons about is one a
/// reader can see in the failure output.
struct Engine {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    /// Every frame the engine sent that was not the answer being waited for. Kept so that a
    /// failure can show what the engine was doing instead of answering.
    heard: Vec<Value>,
}

impl Engine {
    async fn start(binary: &Path, profile: &Path, workspace: &Path) -> Engine {
        let mut command = tokio::process::Command::new(binary);
        command
            .arg("acp")
            // The child's own working directory. Not the crate's: `isolated_profile_env` closes
            // the developer's profile, but the engine also merges configuration by walking up
            // from the process's cwd (that module's header records the measurement), and a probe
            // about session bookkeeping should not run inside a checkout.
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The engine logs to stderr and an unread pipe blocks it on its own logging. No CA
            // bundle is passed: nothing here makes a network call, which is the whole reason
            // these five can be measured for free.
            .stderr(Stdio::null())
            .envs(isolated_profile_env(profile))
            // A panicking test must not leave an engine behind.
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .unwrap_or_else(|error| panic!("spawning {}: {error}", binary.display()));
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        Engine {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
            heard: Vec::new(),
        }
    }

    /// `initialize`, in P0 §2.1's shape.
    ///
    /// An empty client capability set rather than the app's own `client_capabilities()`: P0 §2.1
    /// measured this engine's answer under `{}`, and nothing here uses the fs capability that
    /// would be the difference.
    async fn handshake(&mut self) -> Value {
        self.call(
            "initialize",
            json!({ "protocolVersion": PROTOCOL_VERSION, "clientCapabilities": {} }),
        )
        .await
        .unwrap_or_else(|error| panic!("initialize was refused: {error}"))
    }

    /// `session/new`, returning the whole response so a caller can keep the engine's own
    /// `configOptions` as well as the id.
    async fn open(&mut self, workspace: &Path) -> Value {
        self.call("session/new", json!({ "cwd": workspace, "mcpServers": [] }))
            .await
            .unwrap_or_else(|error| panic!("session/new was refused: {error}"))
    }

    /// The same, reduced to the id.
    async fn open_id(&mut self, workspace: &Path) -> String {
        let response = self.open(workspace).await;
        response["sessionId"]
            .as_str()
            .unwrap_or_else(|| panic!("session/new returned no sessionId: {response}"))
            .to_string()
    }

    /// One request, and the answer that carries its id.
    ///
    /// Ids are the client's to choose and are counted per direction (JSON-RPC), so counting from
    /// one cannot collide with the engine's own reverse requests — P0 §7.1 saw those use ids 0
    /// and 1 in the other direction.
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next_id;
        self.next_id += 1;
        let mut frame = serde_json::to_string(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))
        .expect("a request serializes");
        frame.push('\n');
        self.stdin
            .write_all(frame.as_bytes())
            .await
            .unwrap_or_else(|error| panic!("writing {method}: {error}"));
        self.stdin
            .flush()
            .await
            .expect("the request reaches the engine");

        loop {
            let frame = self.next_frame(method).await;
            if frame.get("id").and_then(Value::as_u64) == Some(id) {
                return match frame.get("error") {
                    Some(error) => Err(error.clone()),
                    None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                };
            }
            self.heard.push(frame);
        }
    }

    async fn next_frame(&mut self, waiting_for: &str) -> Value {
        // Awaited into a value before the match, so the borrow of `lines` ends here and the
        // panic arms can read `heard`.
        let read = tokio::time::timeout(PATIENCE, self.lines.next_line()).await;
        let line = match read {
            Err(_) => {
                let heard = &self.heard;
                panic!(
                    "the engine sent no answer to {waiting_for} within {PATIENCE:?}; it had sent \
                     {} other frame(s) instead: {heard:?}",
                    heard.len()
                )
            }
            Ok(Err(error)) => {
                panic!("reading the engine's stdout while waiting for {waiting_for}: {error}")
            }
            Ok(Ok(None)) => {
                panic!("the engine's stdout closed while waiting for {waiting_for}")
            }
            Ok(Ok(Some(line))) => line,
        };
        serde_json::from_str(&line).unwrap_or_else(|error| {
            // Not a panic: a non-JSON line on stdout is itself worth seeing, and keeping it as a
            // frame puts it in the failure output rather than taking the process down.
            eprintln!("engine stdout line was not JSON ({error}): {line}");
            json!({ "nonJsonLine": line })
        })
    }

    /// Ends the engine the way the runtime does — stdin closed first, a bounded wait for it to
    /// leave on its own, `kill` only after that. A test that then starts a second engine on the
    /// same profile root needs the first one to have actually let go of the database.
    async fn stop(mut self) {
        let _ = self.stdin.shutdown().await;
        if tokio::time::timeout(EXIT_GRACE, self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
    }
}

/// A response with every `configOptions` entry's catalogue replaced by its size.
///
/// The engine's model selector lists ~100 choices and tens of kilobytes (P0 §2.2 measured it
/// arriving with every session response). Printed whole it would bury the frame this file is
/// about; the id, the current value and the number of choices are what identify an option.
fn summarize(response: &Value) -> Value {
    let mut copy = response.clone();
    if let Some(options) = copy.get_mut("configOptions").and_then(Value::as_array_mut) {
        for option in options.iter_mut() {
            let choices = option["options"].as_array().map_or(0, Vec::len);
            option["options"] = json!(format!("<{choices} choices>"));
        }
    }
    copy
}

/// The session ids a `session/list` answer names, in the engine's own order.
fn listed_ids(list: &Value) -> Vec<String> {
    list["sessions"]
        .as_array()
        .unwrap_or_else(|| panic!("session/list returned no sessions array: {list}"))
        .iter()
        .filter_map(|info| info["sessionId"].as_str().map(str::to_string))
        .collect()
}

/// The `model` option's id and current value, read out of an answer that carried
/// `configOptions`.
///
/// The engine's own list rather than a constant: P0 §2.2 measured the option arriving with
/// `session/new` and §6.3 is explicit that the option ids and values are the engine's to define.
fn current_model(config_options: &Value) -> (String, String) {
    let options = config_options
        .as_array()
        .unwrap_or_else(|| panic!("no configOptions array in the answer: {config_options}"));
    let model = options
        .iter()
        .find(|option| option["id"] == "model")
        .unwrap_or_else(|| panic!("the engine sent no model option: {config_options}"));
    let value = model["currentValue"]
        .as_str()
        .unwrap_or_else(|| panic!("the model option carries no current value: {model}"));
    ("model".to_string(), value.to_string())
}

/// A control call on a session, which is what tells a session the engine *serves* from a session
/// the engine merely *lists*. It reaches no provider, so it costs nothing — which is what makes
/// this file free rather than cheap.
async fn control_call(engine: &mut Engine, session_id: &str, option: &(String, String)) -> Value {
    engine
        .call(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": option.0, "value": option.1 }),
        )
        .await
        .unwrap_or_else(|error| panic!("a control call on {session_id} was refused: {error}"))
}

/// `session/list` names the sessions this engine holds.
///
/// The precondition for the other three: an engine that cannot enumerate what it holds cannot be
/// asked whether a close removed it or a load restored it.
#[tokio::test]
async fn session_list_names_the_sessions_the_engine_holds() {
    let Some(binary) = artifact() else { return };
    let profile = scratch("list-profile");
    let workspace = scratch("list-workspace");
    let mut engine = Engine::start(&binary, &profile, &workspace).await;
    engine.handshake().await;

    let first = engine.open_id(&workspace).await;
    let second = engine.open_id(&workspace).await;

    let list = engine
        .call("session/list", json!({}))
        .await
        .unwrap_or_else(|error| panic!("session/list was refused: {error}"));
    let ids = listed_ids(&list);
    // The raw entry, because its field set is the engine's answer about what a listing carries
    // (the schema makes `title` and timestamps optional and the engine decides).
    eprintln!(
        "session/list: {} session(s); first entry: {}",
        ids.len(),
        &list["sessions"][0]
    );
    assert!(
        ids.contains(&first),
        "session/list did not name the session session/new had just returned ({first}): {ids:?}"
    );
    assert!(
        ids.contains(&second),
        "session/list did not name the second session ({second}): {ids:?}"
    );

    engine.stop().await;
}

/// `session/fork` hands back a second session, and the engine serves it.
#[tokio::test]
async fn session_fork_hands_back_a_second_session_the_engine_serves() {
    let Some(binary) = artifact() else { return };
    let profile = scratch("fork-profile");
    let workspace = scratch("fork-workspace");
    let mut engine = Engine::start(&binary, &profile, &workspace).await;
    engine.handshake().await;

    let parent = engine.open(&workspace).await;
    let parent_id = parent["sessionId"].as_str().expect("sessionId").to_string();
    let option = current_model(&parent["configOptions"]);

    let forked = engine
        .call(
            "session/fork",
            json!({ "sessionId": parent_id, "cwd": workspace, "mcpServers": [] }),
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "the engine's handshake advertises sessionCapabilities.fork and it refused \
             session/fork: {error}"
            )
        });
    let child_id = forked["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("session/fork returned no sessionId: {forked}"))
        .to_string();
    eprintln!("session/fork: {parent_id} → {child_id}");
    assert_ne!(
        child_id, parent_id,
        "session/fork answered with the session it was asked to fork"
    );

    let ids = listed_ids(
        &engine
            .call("session/list", json!({}))
            .await
            .expect("session/list"),
    );
    assert!(
        ids.contains(&parent_id) && ids.contains(&child_id),
        "the engine holds only one of the pair after a fork — parent {parent_id}, fork \
         {child_id}: {ids:?}"
    );

    // A row in a list is not a session. A control call is what separates the two, and this one
    // is free.
    let answered = control_call(&mut engine, &child_id, &option).await;
    eprintln!(
        "a control call on the fork answered {}",
        summarize(&answered)
    );

    engine.stop().await;
}

/// `session/close` is served, and does not take another session with it.
///
/// **What the protocol asks of a close, and what it does not.** The pinned schema's own words are
/// that the agent 「must cancel any ongoing work related to the session … and then free up any
/// resources associated with the session」. Removing the conversation from `session/list` is a
/// *different* method's job — `session/delete`, documented as 「deleting an existing session from
/// `session/list`」 — so a close that leaves the session listed is the two methods meaning what
/// they say, not a close that failed. This test therefore asserts the two things the schema does
/// promise (the call is served; it is not destructive), and prints the membership so that the next
/// reader has the measurement rather than this paragraph.
///
/// The one half of the contract this cannot reach is 「cancel any ongoing work」: it needs work to
/// be in progress, and a turn is a prompt. `agent_cancel_live_test.rs` covers the sibling method.
#[tokio::test]
async fn session_close_is_served_without_taking_another_session_with_it() {
    let Some(binary) = artifact() else { return };
    let profile = scratch("close-profile");
    let workspace = scratch("close-workspace");
    let mut engine = Engine::start(&binary, &profile, &workspace).await;
    engine.handshake().await;

    let doomed = engine.open_id(&workspace).await;
    let kept = engine.open_id(&workspace).await;

    let closed = engine
        .call("session/close", json!({ "sessionId": doomed }))
        .await
        .unwrap_or_else(|error| {
            panic!(
                "the engine's handshake advertises sessionCapabilities.close and it refused \
             session/close: {error}"
            )
        });
    eprintln!("session/close: {doomed} answered {closed}");

    let list = engine
        .call("session/list", json!({}))
        .await
        .expect("session/list");
    let ids = listed_ids(&list);
    eprintln!("session/list after the close: {ids:?} (closed {doomed}, kept {kept})");
    assert!(
        ids.contains(&kept),
        "closing one session took another with it: {ids:?}"
    );

    // A second close, an unknown id, and the method that *is* documented as removing a session
    // from the list. Each is printed: what an engine answers about its own session table is the
    // measurement, and none of the three is something the schema states an outcome for.
    eprintln!(
        "a second close answered {:?}",
        engine
            .call("session/close", json!({ "sessionId": doomed }))
            .await
    );
    eprintln!(
        "closing an id the engine never issued answered {:?}",
        engine
            .call("session/close", json!({ "sessionId": "ses_not-a-session" }))
            .await
    );
    let deleted = engine
        .call("session/delete", json!({ "sessionId": doomed }))
        .await;
    eprintln!("session/delete (not advertised in the handshake) answered {deleted:?}");
    if deleted.is_ok() {
        let after = listed_ids(
            &engine
                .call("session/list", json!({}))
                .await
                .expect("session/list"),
        );
        eprintln!("session/list after the delete: {after:?}");
    }

    engine.stop().await;
}

/// `session/load` reopens a session in a **second engine process** — an app restart.
///
/// This is what "reopening yesterday's session" is: the process that made the session is gone,
/// and the session has to come back from the engine's own database. The limit is stated rather
/// than implied — the session loaded here has no turns in it, because a turn is a prompt and a
/// prompt costs money. What a *restored conversation* looks like (the replayed history, which is
/// what separates `session/load` from `session/resume`) is therefore still unmeasured; adding it
/// means one prompt before `first.stop()`, and a count of the `session/update` frames the load
/// replays.
#[tokio::test]
async fn session_load_reopens_a_session_after_the_engine_that_made_it_is_gone() {
    let Some(binary) = artifact() else { return };
    let profile = scratch("load-profile");
    let workspace = scratch("load-workspace");

    let mut first = Engine::start(&binary, &profile, &workspace).await;
    first.handshake().await;
    let opened = first.open(&workspace).await;
    let session = opened["sessionId"].as_str().expect("sessionId").to_string();
    let option = current_model(&opened["configOptions"]);
    first.stop().await;

    let mut second = Engine::start(&binary, &profile, &workspace).await;
    second.handshake().await;
    let loaded = second
        .call(
            "session/load",
            json!({ "sessionId": session, "cwd": workspace, "mcpServers": [] }),
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
            "the engine's handshake advertises agentCapabilities.loadSession, and a second engine \
             on the same profile refused session/load for a session its own profile created: \
             {error}"
        )
        });
    eprintln!(
        "session/load: {session} answered {}; frames the load produced: {:?}",
        summarize(&loaded),
        second.heard
    );

    let ids = listed_ids(
        &second
            .call("session/list", json!({}))
            .await
            .expect("session/list"),
    );
    assert!(
        ids.contains(&session),
        "the engine accepted session/load and does not hold the session it loaded: {ids:?}"
    );

    control_call(&mut second, &session, &option).await;

    second.stop().await;
}

/// `session/resume` on the same scenario, because the handshake advertises it in the same breath
/// as `load` and the two are not the same method: the schema documents resume as reopening a
/// session *without* returning previous messages. It is not one of the scan report's five; it is
/// here because it is one more advertised capability that a probe already on this path can
/// answer for free.
#[tokio::test]
async fn session_resume_reopens_a_session_after_the_engine_that_made_it_is_gone() {
    let Some(binary) = artifact() else { return };
    let profile = scratch("resume-profile");
    let workspace = scratch("resume-workspace");

    let mut first = Engine::start(&binary, &profile, &workspace).await;
    first.handshake().await;
    let opened = first.open(&workspace).await;
    let session = opened["sessionId"].as_str().expect("sessionId").to_string();
    let option = current_model(&opened["configOptions"]);
    first.stop().await;

    let mut second = Engine::start(&binary, &profile, &workspace).await;
    second.handshake().await;
    let resumed = second
        .call(
            "session/resume",
            json!({ "sessionId": session, "cwd": workspace, "mcpServers": [] }),
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
            "the engine's handshake advertises sessionCapabilities.resume and a second engine on \
             the same profile refused session/resume: {error}"
        )
        });
    eprintln!("session/resume: {session} answered {}", summarize(&resumed));

    // A resume is only meaningful if the session is then servable: the response saying so is the
    // engine's claim, and a control call is what tests it.
    control_call(&mut second, &session, &option).await;

    second.stop().await;
}
