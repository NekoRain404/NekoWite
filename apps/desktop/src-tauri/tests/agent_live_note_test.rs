//! The live-buffer seam: what `fs/read_text_file` serves, and what it refuses to serve.
//!
//! `fs_capability`'s read arm used to resolve to `std::fs::read_to_string`, so an agent reading
//! a note the user was mid-edit in received the older, saved text — silently, because a stale
//! read that succeeds is indistinguishable from a correct one. It now asks the window that
//! holds the vault, and the disk is reached in exactly one case: a window answered that no tab
//! holds this path.
//!
//! **The test that cannot pass by accident** is
//! [`a_read_serves_the_windows_buffer_and_not_the_disk`]: the file is seeded with one text, the
//! window answers with another, and then the file is DELETED and the same reply asserted — so
//! the bytes the engine received cannot have come from the disk by any path.
//!
//! **The test the whole change exists for** is
//! [`a_read_that_cannot_reach_the_window_is_an_error_and_never_disk`], which walks the three
//! ways the window side can fail to answer and asserts that none of them serves the file. Its
//! failing version — return disk on every error — is the one that looks finished.
//!
//! The fixture engine (`tests/fixtures/agent/fake_agent.sh`) sends one `fs/*` request verbatim
//! from the environment and has no read path of its own, so a green run here is a statement
//! about this host, never about the engine's routing.

use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteAnswerPayload, LiveNoteQuestion, LiveNoteRefusal, LiveNoteReply, LiveNoteTable,
    LiveNoteWindows, LiveNotes, LIVE_NOTE_ANSWER_CHANNEL, LIVE_NOTE_ATTACH_CHANNEL,
    LIVE_NOTE_BOUND, LIVE_NOTE_REQUEST_CHANNEL,
};
use nekowite_lib::agent_runtime::{
    env_pairs, AgentIdentity, AgentRuntime, EngineConnection, EngineLaunch, VaultFiles,
};

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Long enough for the fixture to answer, short enough that a hang is a failure.
const PATIENCE: Duration = Duration::from_secs(15);

/// The app's own file path, with no adapter of our own in between.
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

/// The window side, as a test drives it.
///
/// It answers the moment it is asked, which is the order of events the real one produces (the
/// table parks the question and records how many windows were asked before any reply can be
/// delivered). `reach` is what the host's own registry would have answered, and `None` for the
/// reply is a window that can be asked and never answers.
struct ScriptedWindow {
    reach: usize,
    reply: Option<LiveNoteReply>,
    /// A second answer to the same question, delivered straight after the first, with the
    /// refusal it produced. This is how the duplicate rule is exercised over the wire: the same
    /// question, the same window, twice.
    duplicate: bool,
    table: Mutex<Option<Arc<LiveNoteTable>>>,
    asked: Mutex<Vec<LiveNoteQuestion>>,
    duplicates: Mutex<Vec<Result<(), LiveNoteRefusal>>>,
}

impl ScriptedWindow {
    fn holding(text: &str) -> Arc<Self> {
        Arc::new(Self {
            reach: 1,
            reply: Some(LiveNoteReply::Held {
                revision: "page-a:tab-1:4".to_string(),
                text: text.to_string(),
                dirty: true,
            }),
            duplicate: false,
            table: Mutex::new(None),
            asked: Mutex::new(Vec::new()),
            duplicates: Mutex::new(Vec::new()),
        })
    }

    fn saying_no_tab_holds_it() -> Arc<Self> {
        Arc::new(Self {
            reach: 1,
            reply: Some(LiveNoteReply::NotHeld),
            duplicate: false,
            table: Mutex::new(None),
            asked: Mutex::new(Vec::new()),
            duplicates: Mutex::new(Vec::new()),
        })
    }

    fn that_cannot_answer(reason: &str) -> Arc<Self> {
        Arc::new(Self {
            reach: 1,
            reply: Some(LiveNoteReply::CannotAnswer {
                reason: reason.to_string(),
            }),
            duplicate: false,
            table: Mutex::new(None),
            asked: Mutex::new(Vec::new()),
            duplicates: Mutex::new(Vec::new()),
        })
    }

    /// No window registered for the vault at all.
    fn nobody() -> Arc<Self> {
        Arc::new(Self {
            reach: 0,
            reply: None,
            duplicate: false,
            table: Mutex::new(None),
            asked: Mutex::new(Vec::new()),
            duplicates: Mutex::new(Vec::new()),
        })
    }

    /// A window that is asked and never answers.
    fn silent() -> Arc<Self> {
        Arc::new(Self {
            reach: 1,
            reply: None,
            duplicate: false,
            table: Mutex::new(None),
            asked: Mutex::new(Vec::new()),
            duplicates: Mutex::new(Vec::new()),
        })
    }

    fn asked(&self) -> Vec<LiveNoteQuestion> {
        self.asked.lock().unwrap().clone()
    }

    fn duplicate_refusal(&self) -> Option<LiveNoteRefusal> {
        match self.duplicates.lock().unwrap().first() {
            Some(Err(refusal)) => Some(refusal.clone()),
            _ => None,
        }
    }
}

impl LiveNoteWindows for ScriptedWindow {
    fn ask(&self, question: &LiveNoteQuestion) -> usize {
        self.asked.lock().unwrap().push(question.clone());
        let Some(table) = self.table.lock().unwrap().clone() else {
            return self.reach;
        };
        let Some(reply) = self.reply.clone() else {
            return self.reach;
        };
        let payload = |reply: LiveNoteReply| match reply {
            LiveNoteReply::Held {
                revision,
                text,
                dirty,
            } => LiveNoteAnswerPayload::Held {
                request_id: question.request_id.clone(),
                vault_id: question.vault_id.clone(),
                path: question.path.clone(),
                window_id: "page-a".to_string(),
                revision,
                text,
                dirty,
            },
            LiveNoteReply::NotHeld => LiveNoteAnswerPayload::NotHeld {
                request_id: question.request_id.clone(),
                vault_id: question.vault_id.clone(),
                path: question.path.clone(),
                window_id: "page-a".to_string(),
            },
            LiveNoteReply::CannotAnswer { reason } => LiveNoteAnswerPayload::CannotAnswer {
                request_id: question.request_id.clone(),
                vault_id: question.vault_id.clone(),
                path: question.path.clone(),
                window_id: "page-a".to_string(),
                reason,
            },
        };
        let _ = table.answer(payload(reply.clone()));
        if self.duplicate {
            // The same window, the same question, a second time.
            self.duplicates
                .lock()
                .unwrap()
                .push(table.answer(payload(reply)));
        }
        self.reach
    }
}

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-livenote-{label}-{}", std::process::id()));
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

fn read_request(path: &Path) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":"fs-1","method":"fs/read_text_file","params":{{"sessionId":"ses_fake_1","path":{}}}}}"#,
        serde_json::to_string(&path.to_string_lossy().into_owned()).expect("path")
    )
}

/// Starts the fixture engine with its session opened on `vault`, and hands the runtime a window
/// side the test controls — the same place `RealVault` is injected in the fs capability's tests.
async fn start(vault: &Path, capture: &Path, window: Arc<ScriptedWindow>) -> AgentRuntime {
    let env = vec![
        (
            "NWK_FAKE_CAPTURE".to_string(),
            capture.to_string_lossy().into_owned(),
        ),
        (
            "NWK_FAKE_FS_REQUEST".to_string(),
            read_request(&vault.join("note.md")),
        ),
    ];
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
    let table = Arc::new(LiveNoteTable::new());
    *window.table.lock().unwrap() = Some(Arc::clone(&table));
    // The reading half is dropped: these tests assert on what the engine RECEIVED (the capture
    // file), not on the host's event stream.
    let (runtime, _events) = AgentRuntime::new(
        identity(),
        connection,
        events,
        Arc::new(RealVault),
        LiveNotes::new(table, window),
    );
    runtime.initialize().await.expect("initialize");
    runtime.open_session(vault).await.expect("session/new");
    runtime
}

fn captured(capture: &Path) -> String {
    fs::read_to_string(capture).unwrap_or_default()
}

fn reply(capture: &Path) -> String {
    captured(capture)
        .lines()
        .find_map(|line| line.strip_prefix("fs-reply=").map(str::to_string))
        .unwrap_or_default()
}

async fn wait_for_reply(capture: &Path) -> String {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let seen = reply(capture);
        if !seen.is_empty() {
            return seen;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the read was never answered; captured: {:?}",
            captured(capture)
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("a JSON string")
}

// ---------------------------------------------------------------------------
// The buffer is what is served
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_read_serves_the_windows_buffer_and_not_the_disk() {
    let vault = temp_dir("buffer");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, "ON DISK\n").expect("seed the file");

    let window = ScriptedWindow::holding("IN THE BUFFER\n");
    let runtime = start(&vault, &capture, Arc::clone(&window)).await;
    let seen = wait_for_reply(&capture).await;

    assert!(
        seen.contains(&format!("\"content\":{}", json_string("IN THE BUFFER\n"))),
        "the engine must receive the window's buffer, got: {seen}"
    );
    assert!(
        !seen.contains(&json_string("ON DISK\n")),
        "the disk bytes must not be in the reply at all: {seen}"
    );

    // The window was asked about the note's path in the spelling an open tab uses — the
    // canonical absolute path, which is what `list_dir_entries` renders and what a window can
    // match. A key the window cannot match is a lookup that never hits, and a lookup that never
    // hits answers "no tab holds it" and serves disk.
    let canonical = fs::canonicalize(&note)
        .expect("canonical")
        .to_string_lossy()
        .into_owned();
    let asked = window.asked();
    assert_eq!(asked.len(), 1, "one read, one question");
    assert_eq!(
        asked[0].path, canonical,
        "the question must name the path as the editor spells it"
    );
    assert_eq!(
        asked[0].vault_id,
        fs::canonicalize(&vault)
            .expect("canonical")
            .to_string_lossy()
            .into_owned()
    );
    assert_eq!(asked[0].request_id, "live-0");

    // And now the file is gone. The same read must be answered from the buffer, which is only
    // possible if the reply above came from the buffer and not from a disk read that happened
    // to agree with it.
    fs::remove_file(&note).expect("delete the note");
    let runtime2 = start(&vault, &capture, Arc::clone(&window)).await;
    let seen = wait_for_reply(&capture).await;
    assert!(
        seen.contains(&format!("\"content\":{}", json_string("IN THE BUFFER\n"))),
        "with the file deleted the buffer is still the answer: {seen}"
    );
    assert!(
        !seen.contains("\"error\""),
        "a held buffer is not an error: {seen}"
    );
    runtime.shutdown();
    runtime2.shutdown();
}

#[tokio::test]
async fn a_read_falls_back_to_the_disk_only_when_the_window_says_no_tab_holds_it() {
    let vault = temp_dir("disk");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, "ON DISK\n").expect("seed the file");

    let runtime = start(&vault, &capture, ScriptedWindow::saying_no_tab_holds_it()).await;
    let seen = wait_for_reply(&capture).await;

    // The disk is correct here because it was ASKED FOR: a window holding this vault said no
    // tab holds the path. This is the only place in the feature the file may be read.
    assert!(
        seen.contains(&format!("\"content\":{}", json_string("ON DISK\n"))),
        "an explicit no must reach the disk: {seen}"
    );
    assert!(!seen.contains("\"error\""), "{seen}");
    runtime.shutdown();
}

// ---------------------------------------------------------------------------
// A read that cannot reach the window is an error, and never disk
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_read_that_cannot_reach_the_window_is_an_error_and_never_disk() {
    let cases: Vec<(&str, Arc<ScriptedWindow>)> = vec![
        // No window registered for this vault: answered at once, not after the bound. The
        // elapsed check below is what makes this case meaningful rather than slow.
        ("no window holds the vault", ScriptedWindow::nobody()),
        // A window that knows it cannot answer yet — the tab is still on its first read, so
        // what it holds is a placeholder wearing the note's path. Folding this into `not-held`
        // is the defect the whole feature is about.
        (
            "the tab is still reading the file",
            ScriptedWindow::that_cannot_answer("the tab is still reading the file"),
        ),
    ];

    for (reason, window) in cases {
        let vault = temp_dir("unknown");
        let capture = vault.join("capture");
        let note = vault.join("note.md");
        fs::write(&note, "ON DISK\n").expect("seed the file");

        let started = std::time::Instant::now();
        let runtime = start(&vault, &capture, window).await;
        let seen = wait_for_reply(&capture).await;

        assert!(
            seen.contains("\"error\""),
            "{reason}: a read that could not reach the live buffer must be refused: {seen}"
        );
        assert!(
            seen.contains(&json_string(&note.to_string_lossy())) || seen.contains("note.md"),
            "{reason}: the refusal must name the note it is about: {seen}"
        );
        assert!(
            !seen.contains(&json_string("ON DISK\n")),
            "{reason}: DISK TEXT MUST NOT BE SERVED — this is the defect the change removes: {seen}"
        );
        if reason == "no window holds the vault" {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "a vault no window holds must not be waited for"
            );
        }
        runtime.shutdown();
    }
}

#[tokio::test]
async fn a_read_no_window_answers_is_refused_at_the_bound_and_never_disk() {
    // The deadline, exercised through the real loop. Ten seconds is the product's bound, and
    // the only thing this test changes is who is waiting for it.
    let vault = temp_dir("deadline");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, "ON DISK\n").expect("seed the file");

    let runtime = start(&vault, &capture, ScriptedWindow::silent()).await;
    let seen = wait_for_reply(&capture).await;

    assert!(
        seen.contains("\"error\""),
        "an unanswered read must be refused rather than served from disk: {seen}"
    );
    assert!(
        !seen.contains(&json_string("ON DISK\n")),
        "the deadline must never become disk: {seen}"
    );
    runtime.shutdown();
}

#[tokio::test]
async fn two_windows_holding_one_path_is_refused_rather_than_picked_between() {
    let vault = temp_dir("ambiguous");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, "ON DISK\n").expect("seed the file");

    // Two answers from two windows to one question, which is the shape §2.2 forbids deciding
    // by tie-break. The scripted window answers as `page-a` twice — the duplicate rule refuses
    // the second — so the two-window case is exercised by two *different* window ids, which is
    // what the next ask would carry.
    let window = Arc::new(TwoWindows {
        table: Mutex::new(None),
    });

    let launch_env = vec![
        (
            "NWK_FAKE_CAPTURE".to_string(),
            capture.to_string_lossy().into_owned(),
        ),
        ("NWK_FAKE_FS_REQUEST".to_string(), read_request(&note)),
    ];
    let launch = EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            "good".to_string(),
        ],
        env: env_pairs(launch_env),
        ca_bundle: None,
    };
    let (connection, events) = EngineConnection::connect(&launch)
        .await
        .expect("the fixture engine should start");
    let table = Arc::new(LiveNoteTable::new());
    *window.table.lock().unwrap() = Some(Arc::clone(&table));
    let (runtime, _events) = AgentRuntime::new(
        identity(),
        connection,
        events,
        Arc::new(RealVault),
        LiveNotes::new(table, window),
    );
    runtime.initialize().await.expect("initialize");
    runtime.open_session(&vault).await.expect("session/new");

    let seen = wait_for_reply(&capture).await;
    assert!(
        seen.contains("\"error\""),
        "two windows holding one path is Unknown, never a pick: {seen}"
    );
    assert!(!seen.contains(&json_string("ON DISK\n")), "{seen}");
    runtime.shutdown();
}

/// Two windows, one path, one question: the disagreement §2.2 refuses to resolve.
struct TwoWindows {
    table: Mutex<Option<Arc<LiveNoteTable>>>,
}

impl LiveNoteWindows for TwoWindows {
    fn ask(&self, question: &LiveNoteQuestion) -> usize {
        let table = self.table.lock().unwrap().clone().expect("installed");
        for (window_id, text) in [("page-a", "A"), ("page-b", "B")] {
            let _ = table.answer(LiveNoteAnswerPayload::Held {
                request_id: question.request_id.clone(),
                vault_id: question.vault_id.clone(),
                path: question.path.clone(),
                window_id: window_id.to_string(),
                revision: format!("{window_id}:tab-1:1"),
                text: text.to_string(),
                dirty: true,
            });
        }
        2
    }
}

// ---------------------------------------------------------------------------
// The wire itself
// ---------------------------------------------------------------------------

/// The channel names are one decision with two spellings, and nothing but this test can catch a
/// drift between them: a mismatch is a wire that silently never connects, which is the failure
/// class this whole feature exists to remove. Read from the file rather than restated, so it is
/// the frontend's literals that are being checked and not this test's idea of them.
#[test]
fn the_channel_names_are_the_ones_the_window_listens_on_and_answers_over() {
    let source = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/agent/services/live-note-responder.ts"),
    )
    .expect("the window's half of the seam");

    for (constant, value) in [
        ("LIVE_NOTE_REQUEST_CHANNEL", "agent-live-note-request"),
        ("LIVE_NOTE_ANSWER_CHANNEL", "agent-live-note-answer"),
        ("LIVE_NOTE_ATTACH_CHANNEL", "agent-live-note-attach"),
    ] {
        let declared = format!("export const {constant} = '{value}'");
        assert!(
            source.contains(&declared),
            "the window does not declare {constant} as {value}"
        );
        assert!(
            source.contains(&format!("'{value}'")),
            "the window does not mention the channel {value}"
        );
    }

    // And the three names this side publishes on, from the module that owns them.
    // And this side's three, from the module that owns the wire's vocabulary. A constant that
    // exists on both sides and is compared on neither is two decisions wearing one name.
    assert_eq!(LIVE_NOTE_REQUEST_CHANNEL, "agent-live-note-request");
    assert_eq!(LIVE_NOTE_ANSWER_CHANNEL, "agent-live-note-answer");
    assert_eq!(LIVE_NOTE_ATTACH_CHANNEL, "agent-live-note-attach");
}

/// The bound, pinned where a reader of the seam's decision can find it. It is a judgement call
/// rather than a measurement — the report says so in as many words — so a change to it should be
/// a deliberate one, and this is the line that makes it so.
#[test]
fn the_bound_is_the_ten_seconds_the_seam_decided() {
    assert_eq!(LIVE_NOTE_BOUND, std::time::Duration::from_secs(10));
}

#[tokio::test]
async fn the_same_window_answering_twice_is_refused_as_a_duplicate() {
    let vault = temp_dir("duplicate");
    let capture = vault.join("capture");
    let note = vault.join("note.md");
    fs::write(&note, "ON DISK\n").expect("seed the file");

    let window = ScriptedWindow::holding("IN THE BUFFER\n");
    let duplicated = Arc::new(ScriptedWindow {
        reach: window.reach,
        reply: window.reply.clone(),
        duplicate: true,
        table: Mutex::new(None),
        asked: Mutex::new(Vec::new()),
        duplicates: Mutex::new(Vec::new()),
    });
    let runtime = start(&vault, &capture, Arc::clone(&duplicated)).await;
    let seen = wait_for_reply(&capture).await;

    assert!(
        seen.contains(&format!("\"content\":{}", json_string("IN THE BUFFER\n"))),
        "the first answer stands: {seen}"
    );
    assert!(
        matches!(
            duplicated.duplicate_refusal(),
            Some(LiveNoteRefusal::Expired { .. })
        ),
        "a second answer from the same window is the question being over: {:?}",
        duplicated.duplicate_refusal()
    );
    runtime.shutdown();
}
