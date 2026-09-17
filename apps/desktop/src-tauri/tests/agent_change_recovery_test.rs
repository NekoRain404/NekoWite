//! The change an agent made, put back by the host that performed it — with no tab, no window and
//! no editor anywhere in the run.
//!
//! This is the half of §7.2 that had no way in. `agent_runtime::recovery` could judge a change and
//! `fs_capability` recorded one, and neither had a caller in the shipped app: a note the user
//! never opened could be *refused* (the editor's review needs a tab to write through) but not
//! un-changed. What is asserted here is the whole chain through the real host — the fixture
//! engine's `fs/write_text_file`, the app's own write path, the record the capability leaves, the
//! baseline stored beside it, and the recovery that uses it — and the last assertion of each case
//! is always **what the file holds on disk**, because "a recovery was reported" and "the user's
//! text is back" are two different facts.
//!
//! What this file cannot say is anything about which writes the engine delegates: the fixture
//! sends one `fs/*` request verbatim and has no write tool of its own, exactly as
//! `agent_fs_capability_test.rs` states for its own cases. The routing question is the engine's and
//! belongs to the live tests.
//!
//! No window is registered for the vault, and that is the point rather than a shortcut: `NoWindow`
//! answers every live-note question with "nobody holds this", so a run that needed a buffer to
//! recover through would fail here — and the claim is that this one does not.

// The library declares the runtime (`lib.rs`: `pub mod agent_runtime;`), so this imports the tree
// the app ships.
use nekowite_lib::agent_runtime;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_runtime::live_notes::{LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes};
use agent_runtime::recovery::RecoveryRefusal;
use agent_runtime::{
    env_pairs, AgentIdentity, AgentRuntime, ChangeRecord, EngineConnection, EngineLaunch,
    VaultFiles,
};

const PATIENCE: Duration = Duration::from_secs(10);

/// The host's own session id: the fixture engine answers `session/new` with this, so a request and
/// the session it is served under are the same string without either side being asked.
const SESSION: &str = "ses_fake_1";

/// The app's own file path, with no adapter of our own in between — the same implementation
/// `agent_fs_capability_test.rs` uses, for the same reason: what is under test is the app's write
/// path, and a stub would prove only that this file can call itself.
struct RealVault;

impl VaultFiles for RealVault {
    fn frontend_path(&self, vault_root: &str, path: &str) -> Result<String, String> {
        let (resolved, _relative) =
            nekowite_lib::domain::path_policy::resolve_within_rel(vault_root, path)?;
        Ok(nekowite_lib::domain::path_policy::ipc_path(&resolved))
    }
    fn read(&self, vault_root: &str, path: &str) -> Result<String, String> {
        nekowite_lib::storage::file_store::read_file(vault_root, path)
    }
    fn write(&self, vault_root: &str, path: &str, content: &str) -> Result<Option<String>, String> {
        nekowite_lib::storage::save_store::write_file(vault_root, path, content, None)
    }
}

/// No window holds anything: every live-note question is answered "nobody", which is the state a
/// closed note is in.
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
    let dir = std::env::temp_dir().join(format!(
        "nkw-change-recovery-{label}-{}",
        std::process::id()
    ));
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

/// The engine's own write request, verbatim: `fs/write_text_file` with the session, the path and
/// the content. The fixture sends it after `session/new`, so the session it names is registered by
/// the time the host serves it.
fn write_request(path: &Path, content: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":"fs-1","method":"fs/write_text_file","params":{{"sessionId":"{SESSION}","path":{},"content":{}}}}}"#,
        serde_json::to_string(&path.to_string_lossy().into_owned()).expect("path"),
        serde_json::to_string(content).expect("content")
    )
}

/// One started engine whose session is opened on `vault`, with `content` written to `note`.
///
/// Returns the runtime and the canonical root, which is what a change is looked up under.
async fn host_wrote(
    label: &str,
    note: &str,
    before: &str,
    content: &str,
) -> (AgentRuntime, PathBuf) {
    let dir = temp_dir(label);
    let vault = dir.join("vault");
    fs::create_dir_all(&vault).expect("the vault directory");
    let path = vault.join(note);
    fs::create_dir_all(path.parent().expect("a parent")).expect("the note's directory");
    if !before.is_empty() {
        fs::write(&path, before).expect("the note's first version");
    }

    let capture = dir.join("capture.txt");
    // `NWK_FAKE_FS_REQUEST` is how the fixture sends one reverse request after `session/new`; the
    // path travels absolute, because that is how the engine spells one.
    let launch = EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            "good".to_string(),
        ],
        env: env_pairs(vec![
            (
                "NWK_FAKE_CAPTURE".to_string(),
                capture.to_string_lossy().into_owned(),
            ),
            (
                "NWK_FAKE_FS_REQUEST".to_string(),
                write_request(&path, content),
            ),
        ]),
        ca_bundle: None,
    };

    let (connection, events) = EngineConnection::connect(&launch)
        .await
        .expect("the fixture engine should start");
    let (runtime, _events) = AgentRuntime::new(
        identity(),
        connection,
        events,
        Arc::new(RealVault),
        LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
    );
    runtime.initialize().await.expect("initialize");
    // The session's root is the vault the user opened, and the runtime is what holds it: this
    // returns the *host's* copy for the same reason the command reads it from there rather than
    // from its caller.
    runtime.open_session(&vault).await.expect("session/new");
    (runtime, vault)
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

/// The change the host recorded for `note`, waiting for the delegated write to have happened.
async fn recorded(runtime: &AgentRuntime, root: &Path, note: &str) -> ChangeRecord {
    let key = RealVault
        .frontend_path(&root.to_string_lossy(), note)
        .expect("the note is inside the vault");
    let arrived = wait_for(|| {
        runtime
            .change_for(SESSION, &key)
            .expect("the fixture's session is the host's own")
            .is_some()
    })
    .await;
    assert!(
        arrived,
        "the host performed the engine's write and recorded it: {:?}",
        runtime.changes()
    );
    runtime
        .change_for(SESSION, &key)
        .expect("the session is the host's own")
        .expect("the change was just waited for")
}

#[tokio::test]
async fn a_delegated_write_is_put_back_by_the_host_with_no_window_open() {
    // §7.2's whole chain in one run, and the order is the requirement: the write happens, the
    // record is kept, the baseline is kept with it, and the recovery puts the *bytes* back — not
    // the hash of them, which is all a record carries on its own.
    let (runtime, root) = host_wrote("put-back", "notes/a.md", "before\n", "after\n").await;
    let note = root.join("notes/a.md");
    let change = recorded(&runtime, &root, "notes/a.md").await;
    assert_eq!(
        fs::read_to_string(&note).expect("the note is on disk"),
        "after\n",
        "the engine's write landed through the app's own path"
    );

    let outcome = runtime
        .recover(&change)
        .expect("the host performed this write, so it can put it back");
    assert_eq!(outcome.path, change.path);
    assert_eq!(
        fs::read_to_string(&note).expect("the note is on disk"),
        "before\n",
        "the file holds the version the change replaced"
    );
    // The text that was put back is the *baseline*'s hash, and the one that was replaced is the
    // change's result — the pair the recovery reports is the pair that moved.
    assert_eq!(outcome.replaced_hash, change.result_hash);
    assert_eq!(Some(outcome.baseline_hash), change.baseline_hash);
}

#[tokio::test]
async fn a_file_the_engine_created_has_nothing_to_put_back() {
    // §7.2's 「没有基线时标记不可直接恢复」, in the one case where a delegated write really has no
    // baseline: the file did not exist. Putting "nothing" back would delete it, which is not what
    // the change did, and inventing an empty baseline is the fabricated undo the clause forbids.
    // `NoBaseline` rather than a silent no-op, so a surface can say which of the two it is.
    let (runtime, root) = host_wrote("created", "notes/new.md", "", "fresh\n").await;
    let change = recorded(&runtime, &root, "notes/new.md").await;

    assert_eq!(change.baseline_hash, None, "a creation replaces nothing");
    let refusal = runtime
        .recover(&change)
        .expect_err("a creation has nothing to put back");
    assert_eq!(
        refusal,
        RecoveryRefusal::NoBaseline {
            path: change.path.clone(),
            vault_root: change.vault_root.clone(),
        }
    );
    assert_eq!(
        fs::read_to_string(root.join("notes/new.md")).expect("the note is on disk"),
        "fresh\n",
        "a refused recovery leaves the file exactly as it was"
    );
}

#[tokio::test]
async fn a_file_the_user_edited_since_is_refused_rather_than_overwritten() {
    // 不一致则三方比较/人工合并，不能覆盖用户后续编辑: the check is against the *file*, made at the
    // moment of the write and not trusted from an earlier plan. A recovery that overwrote here
    // would take away an edit that was never part of the change — and it would do it silently,
    // which is the one outcome §7.2 rules out by name.
    let (runtime, root) = host_wrote("edited-since", "notes/a.md", "before\n", "after\n").await;
    let note = root.join("notes/a.md");
    let change = recorded(&runtime, &root, "notes/a.md").await;
    fs::write(&note, "the user's own later edit\n").expect("the user saves");

    let refusal = runtime.recover(&change).expect_err("the file moved on");
    let RecoveryRefusal::Changed {
        found, expected, ..
    } = &refusal
    else {
        panic!("the file is not what the change left: {refusal:?}");
    };
    assert_eq!(
        expected, &change.result_hash,
        "what the change said it left"
    );
    assert_ne!(found, &change.result_hash, "and what the file holds now");
    assert_eq!(
        fs::read_to_string(&note).expect("the note is on disk"),
        "the user's own later edit\n",
        "nothing was written"
    );
}

#[tokio::test]
async fn a_path_this_host_never_wrote_is_no_change_rather_than_a_failure() {
    // The engine has a write path of its own (P0 §7's preamble measured it with zero reverse
    // requests), so "no record here" is an ordinary state of a file an agent changed — and it is
    // `Ok(None)`, not an error: the call worked and the answer is that this host has nothing.
    let (runtime, root) = host_wrote("never-wrote", "notes/a.md", "before\n", "after\n").await;
    recorded(&runtime, &root, "notes/a.md").await;

    let untouched = RealVault
        .frontend_path(&root.to_string_lossy(), "notes/b.md")
        .expect("inside the vault");
    assert!(
        runtime
            .change_for(SESSION, &untouched)
            .expect("the session is the host's own")
            .is_none(),
        "this host performed no write for that path"
    );
}

#[tokio::test]
async fn a_session_this_host_never_opened_is_refused_before_anything_is_looked_up() {
    // §6.1's guard, and it is the *rejection* channel rather than the answer: there is no root to
    // look a change up under, which is a different fact from a session that has no change. The
    // command turns this into `session-stale` (`commands/agent_recovery.rs`).
    let (runtime, _root) = host_wrote("unknown-session", "notes/a.md", "before\n", "after\n").await;
    let refusal = runtime
        .change_for("ses_somebody_elses", "notes/a.md")
        .expect_err("this host never opened that session");
    assert_eq!(
        refusal.failure_code(),
        agent_runtime::AgentFailureCode::SessionStale
    );
}

#[tokio::test]
async fn a_path_outside_the_vault_is_not_a_change_this_host_ever_made() {
    // The lookup goes through the app's own confinement, so a path that escapes the vault is
    // refused by it rather than searched for — and the answer is the same shape as "no record":
    // there is no file here this host may write, which is what the caller has to hear. What must
    // not happen is a recovery that resolves the path *after* finding a record: the confinement is
    // the first thing, exactly as it is on the write path.
    let (runtime, root) = host_wrote("outside", "notes/a.md", "before\n", "after\n").await;
    recorded(&runtime, &root, "notes/a.md").await;

    let outside = root
        .parent()
        .expect("the vault has a parent")
        .join("elsewhere.md");
    fs::write(&outside, "not the agent's\n").expect("a file outside the vault");
    assert!(
        runtime
            .change_for(SESSION, &outside.to_string_lossy())
            .expect("the session is the host's own")
            .is_none(),
        "a path outside the vault is not one this host can have written"
    );
}
