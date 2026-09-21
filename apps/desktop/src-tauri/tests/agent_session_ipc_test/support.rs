//! The fixtures the behaviour files share: one started fixture engine wired the way `agent_start`
//! wires it, the collector that stands in for a window's event channel, and the readers a test
//! waits on a session's progress with.
//!
//! They are here rather than in the file that needed one first because more than one domain starts
//! an engine — a turn, a permission request and a load all do — and because the sink has to be
//! installed *before* the session opens: that ordering is what makes it a prefix of the stream
//! rather than a sample of it.

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

use agent_runtime::driver;
use agent_runtime::events::{AgentEventEnvelope, AgentEventKind};
use agent_runtime::registry::{AgentRegistration, AgentRegistry, EnvPolicy, InstallSource};
use agent_runtime::snapshot::{SessionSnapshot, SessionState};
use agent_runtime::VaultFiles;
use commands::agent::{agent_open_session, agent_session_snapshot, AgentIpcState};
use state::AgentRuntimeState;

/// No test here reads or writes a vault: the runtime's file capability is never exercised — the
/// one frame that could make it happen is a permission *request*, which the driver answers by
/// putting the question to the user, not by touching the disk.
pub struct NoVault;

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
pub struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

/// Generous enough that a slow machine does not flake, short enough that a genuine hang fails.
pub const PATIENCE: Duration = Duration::from_secs(10);

pub fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

pub fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-session-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// A registration for the fixture engine, written the way §3.4.3 has a user write one: an absolute
/// path to a program, and the arguments as an array.
pub fn fixture_agent(agent_id: &str, behaviour: &str) -> AgentRegistration {
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

/// One started engine, wired the way `agent_start` wires it.
pub struct Wired {
    /// A real Tauri app holding the three states the commands address. The mock runtime is what
    /// makes `State<'_, T>` obtainable without a window.
    pub app: tauri::App<tauri::test::MockRuntime>,
    /// The window's half: every envelope the driver published, in order.
    pub received: Arc<Mutex<Vec<AgentEventEnvelope>>>,
    /// The vault the user "opened" — registered in the app's own `VaultRegistry`, because that is
    /// what a session's root is checked against.
    pub vault_root: PathBuf,
}

impl Wired {
    pub fn ipc(&self) -> tauri::State<'_, AgentIpcState> {
        self.app.state::<AgentIpcState>()
    }

    pub fn runtime(&self) -> tauri::State<'_, AgentRuntimeState> {
        self.app.state::<AgentRuntimeState>()
    }

    pub fn vaults(&self) -> tauri::State<'_, state::VaultRegistry> {
        self.app.state::<state::VaultRegistry>()
    }
}

/// Starts one fixture engine, installs the session the commands address, and registers a vault.
///
/// `fs_frame` is the frame the fixture sends after `session/new` — a permission request, in the
/// one test that has one.
pub async fn wired(label: &str, behaviour: &str, fs_frame: Option<String>) -> Wired {
    wired_at(label, behaviour, fs_frame, None).await
}

/// The same, with the fixture's own record of what it was told and what it sent.
///
/// `capture` exists for the one question a host-side test cannot otherwise answer: whether a frame
/// that never reached the snapshot was dropped here or never sent. The fixture is the only thing
/// that can say, and `NWK_FAKE_CAPTURE` is how it says it.
pub async fn wired_at(
    label: &str,
    behaviour: &str,
    fs_frame: Option<String>,
    capture: Option<&Path>,
) -> Wired {
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
    if let Some(path) = capture {
        registration.env_extra.push((
            "NWK_FAKE_CAPTURE".to_string(),
            path.to_string_lossy().into_owned(),
        ));
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
    app.state::<AgentIpcState>()
        .install(session)
        .expect("the slot this harness just built is not poisoned");
    // The instance goes where `agent_start` puts it: the slot a stop empties. Dropping the app is
    // what ends the engine at the end of a test, through `AgentInstance`'s own `Drop`.
    *app.state::<AgentRuntimeState>().instance.lock().unwrap() = Some(instance);

    Wired {
        app,
        received,
        vault_root,
    }
}

pub fn rooted(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The snapshot of `session_id`, retried until it reports `state`.
///
/// The state moves when the *driver* sees a frame, on a different task from the one that called
/// `agent_prompt` — so a test that read once would be racing the very thing it asserts.
pub async fn wait_for_state(
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
pub async fn wait_for_event(wired: &Wired, kind: AgentEventKind) -> AgentEventEnvelope {
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

pub async fn open(wired: &Wired) -> commands::agent::AgentHostSession {
    agent_open_session(
        wired.vaults(),
        wired.ipc(),
        "vault-1".to_string(),
        rooted(&wired.vault_root),
    )
    .await
    .expect("the fixture engine opens a session")
}
