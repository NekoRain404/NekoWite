//! The client fs capability: the agent asks, the host writes.
//!
//! The write half is tested against the app's REAL write path —
//! `nekowite_lib::storage::save_store::write_file`, the same function the
//! `write_file` command calls — because the whole point of the capability is
//! that an agent write goes through that function rather than around it. A stub
//! here would prove the wiring and nothing about the guarantee.
//!
//! The engine half is the fixture (`tests/fixtures/agent/fake_agent.sh`), which
//! sends a `fs/*` request verbatim from the environment.

// See `tests/agent_runtime_test.rs` for why the module is included by path.
#[path = "../src/agent_runtime/mod.rs"]
mod agent_runtime;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_runtime::{
    AgentIdentity, AgentRuntime, EngineConnection, EngineLaunch, VaultFiles, client_capabilities,
    slice_lines,
};

const PATIENCE: Duration = Duration::from_secs(10);

/// The app's own file path, with no adapter of our own in between.
struct RealVault;

impl VaultFiles for RealVault {
    fn read(&self, vault_root: &str, path: &str) -> Result<String, String> {
        nekowite_lib::storage::file_store::read_file(vault_root, path)
    }
    fn write(&self, vault_root: &str, path: &str, content: &str) -> Result<Option<String>, String> {
        nekowite_lib::storage::save_store::write_file(vault_root, path, content, None)
    }
}

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-agentfs-{label}-{}", std::process::id()));
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

/// A reverse request, as the engine's own frame: `id`, `method`, `params`. The
/// fixture sends it verbatim, so what is tested is the engine's real shape and
/// not a shape this file invented for itself.
fn request(method: &str, path: &Path, tail: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":"fs-1","method":"{method}","params":{{"sessionId":"ses_fake_1","path":{},"sessionId_unused":null{tail}}}}}"#,
        serde_json::to_string(&path.to_string_lossy().into_owned()).expect("path")
    )
}

fn write_request(path: &Path) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":"fs-1","method":"fs/write_text_file","params":{{"sessionId":"ses_fake_1","path":{},"content":"HELLO"}}}}"#,
        serde_json::to_string(&path.to_string_lossy().into_owned()).expect("path")
    )
}

fn read_request(path: &Path, line: Option<u32>, limit: Option<u32>) -> String {
    let line = line.map_or(String::new(), |v| format!(r#","line":{v}"#));
    let limit = limit.map_or(String::new(), |v| format!(r#","limit":{v}"#));
    format!(
        r#"{{"jsonrpc":"2.0","id":"fs-1","method":"fs/read_text_file","params":{{"sessionId":"ses_fake_1","path":{}{line}{limit}}}}}"#,
        serde_json::to_string(&path.to_string_lossy().into_owned()).expect("path")
    )
}

/// Starts the fixture engine with its session opened on `vault`, which is what
/// makes the vault the root every request is confined to — the engine's request
/// names a path but never a vault.
async fn start(vault: &Path, capture: &Path, fs_request: Option<String>) -> AgentRuntime {
    let mut env = vec![(
        "NWK_FAKE_CAPTURE".to_string(),
        capture.to_string_lossy().into_owned(),
    )];
    if let Some(request) = fs_request {
        env.push(("NWK_FAKE_FS_REQUEST".to_string(), request));
    }
    let launch = EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            "good".to_string(),
        ],
        env,
        ca_bundle: None,
    };

    let (connection, events) = EngineConnection::connect(&launch)
        .await
        .expect("the fixture engine should start");
    let runtime = AgentRuntime::new(identity(), connection, events, Arc::new(RealVault));
    runtime.initialize().await.expect("initialize");
    runtime.open_session(vault).await.expect("session/new");
    runtime
}

async fn wait_for<F: Fn() -> bool>(condition: F) -> bool {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        if condition() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn captured(capture: &Path) -> String {
    fs::read_to_string(capture).unwrap_or_default()
}

/// The frame the engine received back, as the fixture recorded it.
fn reply(capture: &Path) -> String {
    captured(capture)
        .lines()
        .find_map(|line| line.strip_prefix("fs-reply=").map(str::to_string))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The declaration, and the read semantics it promises
// ---------------------------------------------------------------------------

#[test]
fn the_capability_declaration_advertises_both_fs_methods() {
    // What actually goes on the wire in `initialize`. P0 §7.2 measured the
    // engine sending `fs/write_text_file` under an EMPTY capability set; this
    // is what turns the host into the writer by contract rather than by the
    // engine's fallback.
    let sent = serde_json::to_value(client_capabilities()).expect("serializes");

    assert_eq!(sent["fs"]["readTextFile"], true, "as sent: {sent}");
    assert_eq!(sent["fs"]["writeTextFile"], true, "as sent: {sent}");
}

#[test]
fn read_semantics_match_the_reference_implementation() {
    // The cases are Zed's own, from its `read_text_file` tests against a file
    // holding "one\ntwo\nthree\nfour\n". They are quoted rather than invented
    // because the point of them is fidelity: the schema says `line` is
    // "(1-based)" and `limit` is a "Maximum number of lines to read", and an
    // ecosystem survey found a sibling implementation that had them inverted.
    let file = "one\ntwo\nthree\nfour\n";

    // `line` is 1-based, so 3 is the third line.
    assert_eq!(slice_lines(file, Some(3), None).unwrap(), "three\nfour\n");
    // With no `line`, reading starts at the first.
    assert_eq!(slice_lines(file, None, Some(2)).unwrap(), "one\ntwo\n");
    // `limit` is a COUNT, not an end index: line 2 plus 2 lines is lines 2 and
    // 3, never "lines 2 through 2".
    assert_eq!(slice_lines(file, Some(2), Some(2)).unwrap(), "two\nthree\n");
    // An unqualified read is the whole file, byte for byte.
    assert_eq!(slice_lines(file, None, None).unwrap(), file);
}

#[test]
fn a_start_past_the_end_of_the_file_is_refused() {
    // Zed errors here rather than answering with an empty string, and the
    // difference matters: "" would tell the agent the file is empty, which is a
    // different and misleading fact. The boundary is the text buffer's, not a
    // line count — a file ending in a newline has a readable (empty) final line.
    let file = "one\ntwo\nthree\nfour\n";

    assert!(
        slice_lines(file, Some(5), None).is_ok(),
        "the empty final line is addressable"
    );
    assert!(slice_lines(file, Some(6), None).is_err());

    let unterminated = "one\ntwo";
    assert!(slice_lines(unterminated, Some(2), None).is_ok());
    assert!(slice_lines(unterminated, Some(3), None).is_err());
}

// ---------------------------------------------------------------------------
// The write, through the app's path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_engine_write_lands_through_the_apps_own_write_path() {
    let vault = temp_dir("write");
    let capture = vault.join("capture");
    let note = vault.join("note.md");

    // The engine writes an ABSOLUTE path, as ACP specifies.
    let runtime = start(&vault, &capture, Some(write_request(&note))).await;

    assert!(
        wait_for(|| note.is_file()).await,
        "the engine's write must be performed by the host, not by the engine"
    );
    assert_eq!(fs::read_to_string(&note).expect("content"), "HELLO");

    // The engine is told it succeeded, and the change is attributed.
    let changes = runtime.changes();
    assert_eq!(changes.len(), 1, "one agent write, one record");
    assert_eq!(changes[0].path, note.to_string_lossy());
    assert_eq!(changes[0].source, "agent");
    assert_eq!(changes[0].session_id, "ses_fake_1");
    assert_eq!(changes[0].vault_root, vault.to_string_lossy());
    assert!(!changes[0].at.is_empty(), "the time is recorded");
    assert!(
        changes[0].baseline_hash.is_none(),
        "the file did not exist, so there is no baseline to claim"
    );
    assert!(!changes[0].result_hash.is_empty());
    runtime.shutdown();
}

#[tokio::test]
async fn the_baseline_is_the_bytes_the_write_replaced() {
    let vault = temp_dir("baseline");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, "BEFORE").expect("seed the file");

    let runtime = start(&vault, &capture, Some(write_request(&note))).await;
    assert!(wait_for(|| !runtime.changes().is_empty()).await);

    let change = runtime.changes().remove(0);
    // Taken from the real pre-write bytes rather than reconstructed from a
    // watcher's diff afterwards — which is the difference the capability buys.
    assert!(change.baseline_hash.is_some(), "an existing file has a baseline");
    assert_ne!(
        change.baseline_hash.as_deref(),
        Some(change.result_hash.as_str()),
        "a replacement must not hash the same as what it replaced"
    );
    assert_eq!(fs::read_to_string(&note).expect("content"), "HELLO");
    runtime.shutdown();
}

#[tokio::test]
async fn the_apps_own_guards_are_in_the_path() {
    // The proof that a write goes through the app's write path and not a raw
    // `fs::write`: the app refuses to overwrite a file that is not valid UTF-8
    // text, because a text write would destroy it untracked. A raw write would
    // replace it without complaint — so a refusal here, with the bytes intact,
    // is the observable consequence of the path being the app's.
    let vault = temp_dir("guard");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, [0xff, 0xfe, 0x00, 0x01]).expect("seed a binary file");

    let runtime = start(&vault, &capture, Some(write_request(&note))).await;

    assert!(
        wait_for(|| !reply(&capture).is_empty()).await,
        "the engine must be answered"
    );
    let reply = reply(&capture);
    assert!(
        reply.contains("\"error\""),
        "the app's guard refused the write, so the engine must be told: {reply}"
    );
    assert_eq!(
        fs::read(&note).expect("still there"),
        vec![0xff, 0xfe, 0x00, 0x01],
        "a refused write must not touch the file"
    );
    assert!(runtime.changes().is_empty(), "nothing was written, so nothing is recorded");
    runtime.shutdown();
}

#[tokio::test]
async fn a_write_outside_the_vault_is_refused_and_writes_nothing() {
    let vault = temp_dir("escape");
    let capture = vault.join("capture");
    let outside = std::env::temp_dir().join(format!("nkw-escape-{}.txt", std::process::id()));
    let _ = fs::remove_file(&outside);

    let runtime = start(&vault, &capture, Some(write_request(&outside))).await;

    // The engine is told it failed. A success response here would let the model
    // report an edit it never made.
    assert!(wait_for(|| !reply(&capture).is_empty()).await);
    let reply = reply(&capture);
    assert!(
        reply.contains("\"error\""),
        "a refused write must answer with an error, got: {reply}"
    );
    assert!(!outside.exists(), "a path outside the session's vault must not be created");
    assert!(runtime.changes().is_empty());
    runtime.shutdown();
}

#[tokio::test]
async fn a_request_for_an_unknown_session_is_refused() {
    let vault = temp_dir("unknown");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    // A session id this host never opened. The path is otherwise valid, so what
    // is being tested is the session resolution rather than the path.
    let unknown = format!(
        r#"{{"jsonrpc":"2.0","id":"fs-1","method":"fs/write_text_file","params":{{"sessionId":"ses_nobody","path":{},"content":"HELLO"}}}}"#,
        serde_json::to_string(&note.to_string_lossy().into_owned()).expect("path")
    );

    let runtime = start(&vault, &capture, Some(unknown)).await;

    assert!(
        wait_for(|| !reply(&capture).is_empty()).await,
        "an unknown session must still be answered, not ignored"
    );
    let reply = reply(&capture);
    assert!(
        reply.contains("\"error\"") && reply.contains("unknown session"),
        "the engine must learn which id was not found, got: {reply}"
    );
    assert!(!note.exists(), "no session, no root to confine to, no write");
    runtime.shutdown();
}

// ---------------------------------------------------------------------------
// The read, over the wire
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_read_returns_the_lines_the_engine_asked_for() {
    let vault = temp_dir("read");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, "one\ntwo\nthree\nfour\n").expect("seed the file");

    // Second line, two lines long: "two\nthree\n" — the 1-based start and the
    // count-over-index reading, exercised through the real request path.
    let runtime = start(&vault, &capture, Some(read_request(&note, Some(2), Some(2)))).await;

    assert!(
        wait_for(|| !reply(&capture).is_empty()).await,
        "the read must be answered; captured: {:?}",
        captured(&capture)
    );
    let reply = reply(&capture);
    assert!(
        reply.contains(r#""content":"two\nthree\n""#),
        "the reply must carry exactly lines 2 and 3, got: {reply}"
    );
    assert!(!reply.contains("\"error\""), "a readable file is not an error");
    runtime.shutdown();
}
