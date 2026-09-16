//! The session half of the agent IPC: does a window get a session, do its frames arrive, and does
//! the snapshot it takes before subscribing say the same thing the stream will?
//!
//! Everything but the window is real here. The engine is the fixture
//! (`tests/fixtures/agent/fake_agent.sh`), the runtime is T2's, the driver and the snapshot store
//! are the ones `agent_start` wires, and the commands are the `#[tauri::command]` functions
//! `generate_handler!` names — called directly, with the states a real app manages. Two things are
//! stood in for: the window's event channel is a collector this test reads (`install` takes a sink
//! rather than a Tauri handle, which is exactly what makes that possible), and `agent_start`
//! itself — its app-side half resolves a real app data directory, so what runs here is the second
//! half it performs, plus the program resolution it does first.
//!
//! The two claims this file exists for:
//!
//! - **A session can be started at all.** T4 delivered the adapter with six of its eight calls
//!   unimplemented, because the runtime's two receivers could only be reached through `&mut`. The
//!   tests below fail on that shape if it ever comes back.
//! - **The snapshot and the stream agree.** §6.2 requires the snapshot to be taken before the
//!   subscription starts, so a frame that is in neither is data the window never sees. The
//!   snapshot's own sequence and tail are asserted against the frames the sink received.

use nekowite_lib::agent_runtime;
use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::commands;
use nekowite_lib::state;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

use agent_runtime::binary_registry::BinaryRegistry;
use agent_runtime::driver;
use agent_runtime::events::{AgentEventEnvelope, AgentEventKind};
use agent_runtime::registry::{AgentRegistration, AgentRegistry, EnvPolicy, InstallSource};
use agent_runtime::snapshot::{SessionSnapshot, SessionState};
use agent_runtime::VaultFiles;
use commands::agent::{
    agent_open_session, agent_prompt, agent_session_snapshot, agent_set_config_option, agent_stop,
    AgentIpcState,
};
use state::AgentRuntimeState;

/// No test here reads or writes a vault: the runtime's file capability is never exercised — the
/// one frame that could make it happen is a permission *request*, which the driver answers by
/// putting the question to the user, not by touching the disk.
struct NoVault;

impl VaultFiles for NoVault {
    fn frontend_path(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("this test must not ask a window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("this test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("this test must not write a vault")
    }
}

/// The window side, for a test that never reads a note: no window is registered for any vault,
/// so a read would be refused rather than served from disk — the direction the seam is built to
/// fail in, which keeps a test that does not exercise reads honest about it.
struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

/// Generous enough that a slow machine does not flake, short enough that a genuine hang fails.
const PATIENCE: Duration = Duration::from_secs(10);

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-session-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// A registration for the fixture engine, written the way §3.4.3 has a user write one: an absolute
/// path to a program, and the arguments as an array.
fn fixture_agent(agent_id: &str, behaviour: &str) -> AgentRegistration {
    AgentRegistration {
        agent_id: agent_id.to_string(),
        display_name: format!("Fake {agent_id}"),
        source: InstallSource::External,
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            behaviour.to_string(),
        ],
        env: EnvPolicy::UserEnvironment,
        env_extra: Vec::new(),
        enabled: true,
        adapter_id: agent_runtime::adapters::opencode::ADAPTER_ID.to_string(),
        reported_version: None,
    }
}

/// The permission frame P0 §7.1 measured, trimmed to what the prompt is built from: the engine's
/// own tool call, and its own options with its own ids.
fn permission_frame(path: &Path) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": "fs-1",
        "method": "session/request_permission",
        "params": {
            "sessionId": "ses_fake_1",
            "toolCall": {
                "toolCallId": "call_session",
                "title": path.to_string_lossy(),
                "kind": "edit",
                "status": "pending",
                "rawInput": { "filepath": path.to_string_lossy() },
            },
            "options": [
                { "optionId": "once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
            ],
        },
    })
    .to_string()
}

/// One started engine, wired the way `agent_start` wires it.
struct Wired {
    /// A real Tauri app holding the three states the commands address. The mock runtime is what
    /// makes `State<'_, T>` obtainable without a window.
    app: tauri::App<tauri::test::MockRuntime>,
    /// The window's half: every envelope the driver published, in order.
    received: Arc<Mutex<Vec<AgentEventEnvelope>>>,
    /// The vault the user "opened" — registered in the app's own `VaultRegistry`, because that is
    /// what a session's root is checked against.
    vault_root: PathBuf,
}

impl Wired {
    fn ipc(&self) -> tauri::State<'_, AgentIpcState> {
        self.app.state::<AgentIpcState>()
    }

    fn runtime(&self) -> tauri::State<'_, AgentRuntimeState> {
        self.app.state::<AgentRuntimeState>()
    }

    fn vaults(&self) -> tauri::State<'_, state::VaultRegistry> {
        self.app.state::<state::VaultRegistry>()
    }
}

/// Starts one fixture engine, installs the session the commands address, and registers a vault.
///
/// `fs_frame` is the frame the fixture sends after `session/new` — a permission request, in the
/// one test that has one.
async fn wired(label: &str, behaviour: &str, fs_frame: Option<String>) -> Wired {
    let dir = temp_dir(label);
    let vault_root = dir.join("vault");
    fs::create_dir_all(&vault_root).expect("the vault directory");

    let app = tauri::test::mock_app();
    app.manage(AgentIpcState::default());
    app.manage(AgentRuntimeState::default());
    app.manage(state::VaultRegistry::default());
    // The user's own two steps, in the order the folder dialog performs them: he *picks* a folder,
    // and then it is the open vault. Skipping the first is not a shortcut — `register` refuses a
    // root nothing vouches for, which is the rule these tests then rely on.
    let vaults = app.state::<state::VaultRegistry>();
    vaults
        .approve_pick(&vault_root.to_string_lossy())
        .expect("the user picked this folder");
    vaults
        .register(&vault_root.to_string_lossy(), None)
        .expect("and it is now the open vault");

    let mut registry = AgentRegistry::with_bundled("/opt/nekowite/opencode");
    let mut registration = fixture_agent("fake", behaviour);
    if let Some(frame) = fs_frame {
        registration
            .env_extra
            .push(("NWK_FAKE_FS_REQUEST".to_string(), frame));
    }
    registry.register(registration).expect("registers");
    registry.bind_profile("prof", "fake").expect("binds");

    let mut instance = registry
        .start(
            "fake",
            "prof",
            "vault-1",
            &dir,
            &agent_runtime::profile::Credentials::default(),
            Arc::new(NoVault),
            LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
        )
        .await
        .expect("the fixture engine starts");
    instance
        .runtime()
        .initialize()
        .await
        .expect("the fixture engine initializes");

    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    let session = driver::install(&mut instance, Some("model".to_string()), move |envelope| {
        sink.lock().unwrap().push(envelope);
    })
    .expect("the session installs");
    app.state::<AgentIpcState>().install(session);
    // The instance goes where `agent_start` puts it: the slot a stop empties. Dropping the app is
    // what ends the engine at the end of a test, through `AgentInstance`'s own `Drop`.
    *app.state::<AgentRuntimeState>().instance.lock().unwrap() = Some(instance);

    Wired {
        app,
        received,
        vault_root,
    }
}

fn rooted(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The snapshot of `session_id`, retried until it reports `state`.
///
/// The state moves when the *driver* sees a frame, on a different task from the one that called
/// `agent_prompt` — so a test that read once would be racing the very thing it asserts.
async fn wait_for_state(
    ipc: tauri::State<'_, AgentIpcState>,
    session_id: &str,
    state: SessionState,
) -> SessionSnapshot {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let snapshot = agent_session_snapshot(ipc.clone(), session_id.to_string())
            .await
            .expect("a session this host opened has a snapshot");
        if snapshot.state == state {
            return snapshot;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the session never reported {state:?}; it is {:?}",
            snapshot.state
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The first frame of `kind` the window's channel received.
///
/// Waited for rather than read once: the driver publishes on its own task, so a single read would
/// be racing the very frame the test asserts.
async fn wait_for_event(wired: &Wired, kind: AgentEventKind) -> AgentEventEnvelope {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let found = wired
            .received
            .lock()
            .unwrap()
            .iter()
            .find(|event| event.kind == kind)
            .cloned();
        if let Some(event) = found {
            return event;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the window never received a {kind:?} frame; it received {:?}",
            wired
                .received
                .lock()
                .unwrap()
                .iter()
                .map(|event| event.kind)
                .collect::<Vec<AgentEventKind>>()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn open(wired: &Wired) -> commands::agent::AgentHostSession {
    agent_open_session(
        wired.vaults(),
        wired.ipc(),
        "vault-1".to_string(),
        rooted(&wired.vault_root),
    )
    .await
    .expect("the fixture engine opens a session")
}

// --- The session, from the window's side ---

#[tokio::test]
async fn a_window_opens_a_session_and_reads_the_turn_it_runs() {
    // The path T4 could not deliver: `agent_open_session` builds an engine session, the snapshot
    // describes it before anything has been asked, `agent_prompt` starts a turn, and the turn's
    // ending arrives as a frame rather than as the prompt's answer.
    let wired = wired("turn", "good", None).await;
    let opened = open(&wired).await;
    assert_eq!(opened.session_id, "ses_fake_1", "the engine's own id");
    assert_eq!(
        opened.model_option_id.as_deref(),
        Some("model"),
        "the adapter's answer, not the renderer's guess"
    );
    assert!(
        opened.config_options.is_array(),
        "the engine's own option list, as it came: {:?}",
        opened.config_options
    );

    let before = agent_session_snapshot(wired.ipc(), opened.session_id.clone())
        .await
        .expect("snapshot");
    assert_eq!(
        before.state,
        SessionState::Ready,
        "nothing has been asked of it yet"
    );
    assert_eq!(before.run_id, None);
    assert_eq!(before.identity.session_id, "ses_fake_1");
    assert_eq!(before.identity.vault_id, "vault-1");
    assert!(
        !before.identity.runtime_epoch.is_empty(),
        "the epoch is minted, not guessed"
    );

    let run_id = agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
    )
    .await
    .expect("a prompt starts a turn");
    assert_eq!(run_id, "run-0", "the host's own name for the work");

    let after = wait_for_state(wired.ipc(), &opened.session_id, SessionState::Completed).await;
    assert_eq!(
        after.run_id.as_deref(),
        Some("run-0"),
        "the turn it is looking at"
    );
    assert!(
        after.sequence > before.sequence,
        "the stream moved: {} -> {}",
        before.sequence,
        after.sequence
    );
    // The tail a caller's snapshot is continued from: everything this session published, in the
    // runtime's own order, under the sequences it published them with.
    let kinds: Vec<AgentEventKind> = after.events.iter().map(|event| event.kind).collect();
    assert!(kinds.contains(&AgentEventKind::TextDelta), "{kinds:?}");
    assert_eq!(
        kinds.last(),
        Some(&AgentEventKind::RunFinished),
        "the ending is the last thing this session published: {kinds:?}"
    );
    assert!(
        after
            .events
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence),
        "the replay is ordered by the host's own sequence"
    );

    // And the same frames reached the window's channel: the half the snapshot cannot serve, for a
    // window that was already listening.
    let received = wired.received.lock().unwrap().clone();
    assert!(
        received
            .iter()
            .any(|event| event.kind == AgentEventKind::RunFinished),
        "the ending must be published, not only replayed"
    );
    assert!(received
        .iter()
        .all(|event| event.session_id == opened.session_id));
    assert!(received
        .iter()
        .any(|event| event.sequence == after.sequence));
}

#[tokio::test]
async fn every_frame_a_window_receives_after_its_snapshot_is_in_the_snapshot_or_newer_than_it() {
    // §6.2's handshake, asserted as the property the adapter depends on: the window subscribes
    // *from* the snapshot it took, and the two places it can be delivered from are that snapshot's
    // tail (`channel.ts` replays the frames above the position the caller holds) and the live
    // stream (frames above the host's own sequence, buffered while the handshake was in flight).
    // A frame that arrives after the snapshot and is in neither place is a hole no subscriber
    // could detect — the failure the snapshot exists to prevent.
    //
    // **Which frames are asserted over, and why they are the property.** The count is taken
    // immediately *before* the snapshot is asked for, so the set is every frame the window's
    // channel received from that moment on: the frames that arrived while the snapshot was being
    // taken, and every frame after it. A frame received strictly before it is not evidence about
    // this handshake — it is evidence about the replay window's bound, and there the contract's
    // answer is a *refusal*, not a silent loss: a caller whose position is older than the tail is
    // told `buffer-conflict` and takes a fresh snapshot (`channel.ts`'s `tailStart` check, covered
    // by `tauri-agent.test.ts`). Asserting over those too made this test depend on the window
    // being larger than the session's whole stream — a property of `REPLAY_WINDOW`, not of the
    // handshake it is named for.
    //
    // What it did go red on, and why it no longer does: frames received *after* the snapshot and in
    // neither place, which is the property the assertion is about. The one it caught was a frame
    // the host had published but not yet recorded — "nothing published yet" and "frame 0 was
    // published" were the same number in `SessionSnapshot::sequence`, because the emitter's counter
    // started at 0, and the window this set covers is exactly the one that lost it (measured: 6
    // failures in 150 runs of this binary). Numbering now starts at one
    // (`agent_runtime::session`'s `FIRST_SEQUENCE`), so an empty record says 0 and means it, and
    // `no_frame_a_runtime_publishes_carries_the_sequence_that_means_no_frame` is where that is
    // asserted rather than assumed.
    let wired = wired("handshake", "good", None).await;
    let opened = open(&wired).await;
    let delivered = wired.received.lock().unwrap().len();
    let before = agent_session_snapshot(wired.ipc(), opened.session_id.clone())
        .await
        .expect("snapshot");
    // "In the snapshot" is both of the lists a caller is handed, not the tail alone: a permission
    // request travels in the snapshot's own `permissions` list (that is where `channel.ts` reads
    // prompts from), and a caller holding it has it. This session is never asked to allow anything
    // — the harness passes no reverse request — so the second list is a statement of the property
    // rather than a path this run exercises.
    let replayed: Vec<u64> = before
        .events
        .iter()
        .chain(&before.permissions)
        .map(|event| event.sequence)
        .collect();

    agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
    )
    .await
    .expect("prompt");
    wait_for_state(wired.ipc(), &opened.session_id, SessionState::Completed).await;

    let received = wired.received.lock().unwrap().clone();
    let after = received.get(delivered..).expect("the sink only ever grows");
    assert!(!after.is_empty(), "the turn published frames");
    for event in after {
        assert!(
            replayed.contains(&event.sequence) || event.sequence > before.sequence,
            "sequence {} ({:?}) is neither in the snapshot nor newer than it ({}): a window that \
             took the snapshot would lose it. The snapshot's tail held {} frame(s), first {:?}",
            event.sequence,
            event.kind,
            before.sequence,
            replayed.len(),
            replayed.first()
        );
    }
}

#[tokio::test]
async fn no_frame_a_runtime_publishes_carries_the_sequence_that_means_no_frame() {
    // The invariant two other modules are written against, over the real runtime: the pet's
    // `FrameOrder::off_stream` says "zero is the sequence no runtime ever assigns", and the
    // notification ledger branches on `fact.sequence != 0` to tell a fact the host reports from its
    // own view from a frame off the stream. Both statements were false while the emitter's counter
    // started at 0, and what that cost was not a label but the first frame of every session — the
    // command list, the only source of the `/` menu — dropped by any window that had taken its
    // snapshot a moment earlier. The test above is where that was measured; this one is where the
    // property it depends on is stated.
    //
    // Two things, and the second is why the first cannot simply be asserted about one frame: the
    // stream starts at 1, and every frame after it is the next number, because the number and the
    // queue position are taken together. A frame delivered below the one before it is read by every
    // consumer as a replay and dropped with no hole recorded — the silent loss §6.2's handshake
    // exists to make impossible — so the numbering has to hold for the whole stream, which is what
    // the window from `wired()` captures: the sink is installed before the session opens and
    // appends in delivery order, so what it holds is a prefix of the stream and not a sample of it.
    let wired = wired("numbering", "good", None).await;
    let opened = open(&wired).await;
    agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
    )
    .await
    .expect("prompt");
    // Read once the ending has been published, so the frames checked are a whole turn's rather than
    // however many happened to have arrived.
    wait_for_event(&wired, AgentEventKind::RunFinished).await;

    let received = wired.received.lock().unwrap().clone();
    let numbering: Vec<u64> = received.iter().map(|event| event.sequence).collect();
    assert!(!numbering.is_empty(), "the turn published frames");
    assert_eq!(
        numbering[0], 1,
        "a stream starts at 1, so that 0 keeps meaning \"nothing has been published\": {numbering:?}"
    );
    assert!(
        numbering.windows(2).all(|pair| pair[0] + 1 == pair[1]),
        "every frame is numbered and delivered in one order: {numbering:?}"
    );
}

#[tokio::test]
async fn the_engines_own_options_reach_both_the_caller_and_the_window() {
    // A config change has two producers and this asserts both, because they answer different
    // halves of the same requirement: the *command's* answer is the engine's refreshed list, so a
    // caller never has to guess the new state or wait for an event to learn it (the reason Zed's
    // `set_config_option` answers the list), while the *notification* is the only route a change
    // the host did not ask for can travel on.
    //
    // A turn runs first, and deliberately: it leaves the session holding a run that has already
    // ended, which is the state a run-gated forwarder would swallow a session-scoped frame in —
    // and switching a model between turns is exactly when a user does it.
    let wired = wired("config", "config-update", None).await;
    let opened = open(&wired).await;
    agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
    )
    .await
    .expect("a turn");
    wait_for_state(wired.ipc(), &opened.session_id, SessionState::Completed).await;

    let options = agent_set_config_option(
        wired.ipc(),
        opened.session_id.clone(),
        "model".to_string(),
        "fake/model-b".to_string(),
    )
    .await
    .expect("the engine moves one of its own options");

    // The engine's own list, in the shape `agent_open_session` answers the first one in: the
    // runtime stores it when it answers, so this is that value and not a second read of it.
    assert_eq!(options[0]["id"], "model");
    assert_eq!(options[0]["currentValue"], "fake/model-b");

    let event = wait_for_event(&wired, AgentEventKind::ConfigChanged).await;
    assert_eq!(
        event.session_id, opened.session_id,
        "the session the engine named"
    );
    assert_eq!(
        event.run_id, None,
        "a config change belongs to the session, not to a turn: the one above has already ended"
    );
    // The contract's payload — the shape `readConfigChanged` reads and no other.
    assert_eq!(event.payload["options"][0]["id"], "model");
    assert_eq!(event.payload["options"][0]["value"]["kind"], "select");
    assert_eq!(
        event.payload["options"][0]["value"]["current"],
        "fake/model-b"
    );
    assert_eq!(
        event.payload["options"][0]["value"]["choices"][1]["value"], "fake/model-b",
        "the choices come with the option, which is what a selector draws"
    );
}

#[tokio::test]
async fn a_config_change_during_a_turn_belongs_to_the_session_not_the_turn() {
    // §6.2's envelope defines `runId` as the generation an event belongs to, and a config change
    // belongs to none — including when it arrives while a turn is in flight, which is the case a
    // forwarder with only a run-scoped path gets wrong. The stamp matters twice: it would say the
    // fact belongs to a turn it outlives, and an unreadable run-scoped payload fails that turn on
    // the way to the window (`tauri-agent/frames.ts` reports one as `run-failed`).
    let wired = wired("mid-run", "config-mid-run", None).await;
    let opened = open(&wired).await;

    let run_id = agent_prompt(
        wired.app.handle().clone(),
        wired.ipc(),
        opened.session_id.clone(),
        "hello".to_string(),
    )
    .await
    .expect("a turn");

    let event = wait_for_event(&wired, AgentEventKind::ConfigChanged).await;
    assert_eq!(
        event.run_id, None,
        "a session fact carries no run, even mid-turn"
    );
    assert_eq!(
        event.payload["options"][0]["value"]["current"],
        "fake/model-b"
    );

    // The turn it arrived during is untouched: it reaches its own ending, and nothing here was
    // reported as a failure of it.
    let after = wait_for_state(wired.ipc(), &opened.session_id, SessionState::Completed).await;
    assert_eq!(after.run_id.as_deref(), Some(run_id.as_str()));
    let received = wired.received.lock().unwrap().clone();
    assert!(
        received
            .iter()
            .all(|frame| frame.kind != AgentEventKind::RunFailed),
        "a session-scoped frame must not be able to fail the turn it arrived in"
    );
}

#[tokio::test]
async fn a_session_this_host_never_opened_is_refused_rather_than_answered_about() {
    // §6.1: an id the host did not receive is not one it answers about — and the snapshot is the
    // surface a forged id would otherwise read state out of.
    let wired = wired("unknown", "good", None).await;
    let refusal = agent_session_snapshot(wired.ipc(), "ses_somebody_elses".to_string())
        .await
        .expect_err("this host never opened that session");
    assert!(refusal.contains("not one this app opened"), "{refusal}");
}

#[tokio::test]
async fn a_session_root_is_the_vault_the_user_opened() {
    // §6.1/§11.1: the renderer names a vault, it does not choose one. The root it sends becomes the
    // engine's confinement, so a root accepted on the request alone would be a sandbox drawn
    // around a directory the user never picked.
    let wired = wired("root", "good", None).await;
    let elsewhere = temp_dir("root-elsewhere");

    let refusal = agent_open_session(
        wired.vaults(),
        wired.ipc(),
        "vault-1".to_string(),
        rooted(&elsewhere),
    )
    .await
    .expect_err("that folder was never opened as a vault");
    assert!(
        refusal.contains("vault root is not open"),
        "the refusal is the one every path-confined command gives for a root the user never \
         opened: {refusal}"
    );

    // And the vault named has to be the one this engine was started for: a runtime is per (agent,
    // profile, vault), so another vault's session is not this runtime's to open.
    let refusal = agent_open_session(
        wired.vaults(),
        wired.ipc(),
        "another-vault".to_string(),
        rooted(&wired.vault_root),
    )
    .await
    .expect_err("this engine was started for one vault");
    assert!(
        refusal.contains("was started for the vault vault-1"),
        "{refusal}"
    );
}

#[tokio::test]
async fn a_pending_prompt_holds_the_session_in_waiting_permission() {
    // The engine blocks on a permission request, so the one thing the snapshot may not do is lose
    // it: a window that remounts while one is open would show a turn with nothing to allow. The
    // state and the prompt list come from one read of the permission table, so they cannot
    // disagree about whether a decision is due.
    let dir = temp_dir("prompt");
    let vault_root = dir.join("vault");
    fs::create_dir_all(&vault_root).expect("the vault directory");
    let wired = wired(
        "prompt",
        "good",
        Some(permission_frame(&vault_root.join("note.md"))),
    )
    .await;
    let opened = open(&wired).await;

    let waiting = wait_for_state(
        wired.ipc(),
        &opened.session_id,
        SessionState::WaitingPermission,
    )
    .await;
    assert_eq!(
        waiting.permissions.len(),
        1,
        "the question is in the snapshot"
    );
    let prompt = &waiting.permissions[0].payload;
    assert!(
        prompt.get("requestId").is_some(),
        "an answer names this, so the window has to be told it: {prompt}"
    );
    assert_eq!(prompt["toolCallId"], "call_session");
    assert_eq!(
        prompt["options"].as_array().map(Vec::len),
        Some(2),
        "the engine's own options, as the engine spelled them"
    );
    assert!(
        prompt["title"]
            .as_str()
            .is_some_and(|title| !title.is_empty()),
        "a prompt whose title is empty is refused by the contract on the other side: {prompt}"
    );
    assert!(
        waiting
            .events
            .iter()
            .all(|event| event.kind != AgentEventKind::PermissionRequest),
        "a question is not part of the stream a caller replays events from — it would be delivered \
         once as a frame and once again here"
    );
    // The envelope is the runtime's own: the identity an answer is checked against is the one the
    // window was told.
    assert_eq!(waiting.permissions[0].session_id, opened.session_id);
    assert!(waiting.permissions[0].sequence <= waiting.sequence);
}

#[tokio::test]
async fn stopping_empties_the_state_and_ends_the_session() {
    // `agent_stop` takes the session out before the engine goes, so no command can address a
    // runtime whose process is being torn down — and a call afterwards is refused with a sentence
    // naming the condition, not with a failure from inside the transport.
    let wired = wired("stop", "good", None).await;
    let opened = open(&wired).await;
    assert!(wired.ipc().session().is_ok(), "a session is running");

    agent_stop(wired.app.handle().clone(), wired.runtime(), wired.ipc())
        .await
        .expect("stopping a running session is not an error");

    assert!(wired.ipc().session().is_err(), "and now nothing is running");
    assert!(
        wired.runtime().instance.lock().unwrap().is_none(),
        "the instance is gone with it: the registration is free for the next start"
    );
    let refusal = agent_session_snapshot(wired.ipc(), opened.session_id)
        .await
        .expect_err("there is no session to snapshot");
    assert!(refusal.contains("no agent session is running"), "{refusal}");
}

// --- The start path's own half ---

#[test]
fn the_program_a_start_launches_is_the_promoted_release_or_the_sidecar() {
    // §3.1.1's two places, in the order §3.3 defines: a promoted release when the pointer names a
    // launchable one, and otherwise the engine shipped beside the executable. Nothing is searched
    // for on `PATH`, because the engine this app runs is the one it ships or installed itself.
    let managed = temp_dir("program-managed");
    let beside = temp_dir("program-beside");

    let refusal = state::program_to_launch(&managed, &beside).expect_err("no engine anywhere");
    assert!(
        refusal.contains(&rooted(&beside)),
        "the refusal names the directory it looked in: {refusal}"
    );

    let sidecar = beside.join("opencode");
    make_executable(&sidecar, "#!/bin/sh\nexit 0\n");
    assert_eq!(
        state::program_to_launch(&managed, &beside).expect("the sidecar is launchable"),
        sidecar
    );

    // A promoted release wins: it is the version this app installed and verified itself.
    let layout = BinaryRegistry::new(&managed).expect("the managed layout");
    let promoted = layout.program_of("1.2.3");
    fs::create_dir_all(promoted.parent().expect("a release directory")).expect("releases");
    make_executable(&promoted, "#!/bin/sh\nexit 0\n");
    layout.set_active("1.2.3").expect("the pointer moves to it");
    assert_eq!(
        state::program_to_launch(&managed, &beside).expect("the promoted release"),
        promoted
    );
}

fn make_executable(path: &Path, content: &str) {
    fs::write(path, content).expect("the file");
    let mut mode = fs::metadata(path).expect("metadata").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut mode, 0o755);
    fs::set_permissions(path, mode).expect("an executable file");
}
