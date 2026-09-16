//! The client fs capability: the agent asks, the host writes.
//!
//! The write half is tested against the app's REAL write path —
//! `nekowite_lib::storage::save_store::write_file`, the same function the
//! `write_file` command calls — because what the capability buys is that a
//! **delegated** agent write goes through that function rather than around it. A
//! stub here would prove the wiring and nothing about the guarantee.
//!
//! What this file cannot say is anything about which writes the engine delegates.
//! The fixture below sends one `fs/*` request verbatim from the environment and
//! has no write path of its own to fall back to, so a green run here is a
//! statement about this host — never about the engine's routing. That question
//! needs the real engine and lives in `agent_fs_write_refusal_test.rs`.

// The library declares the runtime now (`lib.rs`: `pub mod agent_runtime;`), so
// this imports the tree the app ships instead of including a copy of it by path.
use nekowite_lib::agent_runtime;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_runtime::live_notes::{LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes};
use agent_runtime::{
    AgentIdentity, AgentRuntime, EngineConnection, EngineLaunch, VaultFiles, client_capabilities,
    env_pairs, slice_lines,
};

const PATIENCE: Duration = Duration::from_secs(10);

/// The app's own file path, with no adapter of our own in between.
struct RealVault;

impl VaultFiles for RealVault {
    fn frontend_path(&self, vault_root: &str, path: &str) -> Result<String, String> {
        let (resolved, _relative) = nekowite_lib::domain::path_policy::resolve_within_rel(vault_root, path)?;
        Ok(nekowite_lib::domain::path_policy::ipc_path(&resolved))
    }
    fn read(&self, vault_root: &str, path: &str) -> Result<String, String> {
        nekowite_lib::storage::file_store::read_file(vault_root, path)
    }
    fn write(&self, vault_root: &str, path: &str, content: &str) -> Result<Option<String>, String> {
        nekowite_lib::storage::save_store::write_file(vault_root, path, content, None)
    }
}

/// The window side, for the tests in this file that are not about reads: no window is
/// registered for any vault, so a read is refused rather than served from disk. What a read
/// serves is `agent_live_note_test.rs`'s subject, and this file says only that a host with no
/// window answers nothing — the direction the seam is built to fail in.
struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
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
        env: env_pairs(env),
        ca_bundle: None,
    };

    let (connection, events) = EngineConnection::connect(&launch)
        .await
        .expect("the fixture engine should start");
    // The reading half is dropped: these tests assert on what the engine *received* (the capture
    // file) and on what the runtime recorded, not on the host's event stream — and the file
    // requests are served by the dispatcher `AgentRuntime::new` starts, not by the reader.
    let (runtime, _events) = AgentRuntime::new(
        identity(),
        connection,
        events,
        Arc::new(RealVault),
        LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
    );
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
    // engine sending `fs/write_text_file` under an EMPTY capability set, so this
    // is not what makes the engine delegate — it is what gives the delegated
    // request a handler. Unclaimed, the SDK answers `-32601` instead.
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
        "a write the engine DELEGATED must be performed by the host, not answered and dropped"
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
    // The exact path, and the rule that refused it. "An error came back" is not
    // enough on its own: the unknown-session branch answers with an error too, and so
    // does a join failure — and a refusal aimed at the wrong path, or made before the
    // path was ever resolved, would look identical from here. Naming both is what
    // separates "the app's own confinement refused this write" from the three other
    // ways this request could have failed, and it is the strongest assertion available
    // without the real engine, which is the only thing that can say whether the engine
    // went on to write the file itself.
    assert!(
        reply.contains("path escapes vault") && reply.contains(&outside.to_string_lossy().to_string()),
        "the refusal must come from the vault's own path policy and name the path it refused, \
         got: {reply}"
    );
    assert!(!outside.exists(), "a path outside the session's vault must not be created");
    assert!(runtime.changes().is_empty());
    runtime.shutdown();
}

#[tokio::test]
async fn a_traversal_spelling_is_refused_before_it_is_resolved() {
    // The refusal above hands the engine a path that is ALREADY outside the root, so
    // what catches it is `resolve_within`'s prefix check on the canonical result. This
    // one spells the same destination with a parent component, which is a different arm
    // of the same function: `Component::ParentDir` is rejected outright, before
    // anything is canonicalized (`domain/path_policy.rs:89-95`). That arm had no
    // end-to-end coverage — nothing else in the suite sends a `..`, so an engine that
    // spelt a path this way would have been met by a branch no test watched, and a
    // prefix check alone would let it through whenever the resolved target still
    // started with the vault's own root.
    let scratch = temp_dir("traversal");
    let vault = scratch.join("vault");
    fs::create_dir_all(&vault).expect("the session root");
    // What `vault/..` resolves to. Kept unique per process: asserting on a shared
    // location would make this test's verdict depend on what else is on the machine.
    let outside = scratch.join("escape.txt");
    let _ = fs::remove_file(&outside);
    let traversing = vault.join("..").join("escape.txt");

    let capture = scratch.join("capture");
    let runtime = start(&vault, &capture, Some(write_request(&traversing))).await;

    assert!(wait_for(|| !reply(&capture).is_empty()).await);
    let reply = reply(&capture);
    assert!(
        reply.contains("\"error\"") && reply.contains("path escapes vault"),
        "a traversal spelling must be refused by the vault's own path policy, got: {reply}"
    );
    assert!(
        !outside.exists(),
        "the traversal was resolved and written: {} exists",
        outside.display()
    );
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

// What a read *serves* has moved: it is the window's buffer when a window holds the note, and
// the disk only when a window holding the vault says no tab holds this path. That behaviour and
// its refusals are `agent_live_note_test.rs`'s subject, end to end; what stays here is the one
// thing this file is about — the slice, applied to whichever text won, through the real request
// path.
//
// The two tests that used to live here asserted that a read serves the DISK. One of them
// (`a_read_serves_the_disk_and_not_a_windows_buffer`) pinned the very defect the seam removes,
// and the seam's own report said so: serving a buffer instead is a change that has to be made
// deliberately, with the test and the module header changed with it. This is that change.
// The host this file builds has no window registered, so a read is refused rather than served
// from disk — see `NoWindow`, and `agent_live_note_test.rs` for the served case.

#[tokio::test]
async fn a_read_this_host_cannot_ask_a_window_about_is_refused_rather_than_guessed() {
    let vault = temp_dir("no-window");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, "ON DISK\n").expect("seed the file");

    let runtime = start(&vault, &capture, Some(read_request(&note, None, None))).await;

    assert!(
        wait_for(|| !reply(&capture).is_empty()).await,
        "the read must be answered, one way or the other; captured: {:?}",
        captured(&capture)
    );
    let reply = reply(&capture);
    assert!(
        reply.contains("\"error\""),
        "with no window to ask, the read is refused: {reply}"
    );
    // The assertion that matters most in this file: the file's bytes are NOT in the reply. A
    // read that silently falls back to disk is indistinguishable from one that reached the
    // buffer, which is why the fallback is forbidden even as a "safe" default.
    let on_disk = serde_json::to_string("ON DISK\n").expect("a JSON string");
    assert!(
        !reply.contains(&format!("\"content\":{on_disk}")),
        "the disk must not be served when the window could not be asked: {reply}"
    );
    runtime.shutdown();
}
