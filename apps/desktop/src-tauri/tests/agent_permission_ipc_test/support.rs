//! The fixture world the domain files share: the engine half is
//! `tests/fixtures/agent/fake_agent.sh` (the target's crate doc says why the capture file is the
//! assertion), and the host half is one `Asked` value — the engine asked, this host adopted the
//! request, and the renderer has a prompt.
//!
//! The two readers that judge the wire — [`answered_once`] and [`refused_and_silent`] — are here
//! rather than in a domain file because every domain needs the same negative control, and it has to
//! be the same one: an error frame, or a second frame, is what an unregistered handler produces. A
//! domain that needs a different question asked of the capture reads [`replies`] itself.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::permissions::{
    PermissionAnswer, PermissionIdentity, PermissionPrompt, PermissionTable,
};
use nekowite_lib::agent_runtime::{
    env_pairs, AgentEventEnvelope, AgentEventKind, AgentIdentity, AgentRuntime, AgentRuntimeEvents,
    EngineConnection, EngineLaunch, VaultFiles,
};

/// T2's transport tests panic in a vault; this file's frame is a permission request, so the same
/// stub holds: reaching the vault would mean the fixture sent something unexpected.
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
        panic!("a permission test must not ask a window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a permission test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("a permission test must not write a vault")
    }
}

/// Generous enough that a slow machine does not produce a flake, short enough that a genuine hang
/// fails rather than the suite's timeout.
pub const PATIENCE: Duration = Duration::from_secs(10);

/// How long a test waits before asserting that a refusal left the wire silent: long enough for an
/// answer that was going to be sent to have been sent. The assertion is worthless without a window.
pub const SILENCE: Duration = Duration::from_millis(300);

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

pub fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-perm-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

pub fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "default".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-1".to_string(),
    }
}

/// The permission frame, in the shape P0 §7.1 measured against the pinned
/// engine: a `toolCall` with a `rawInput` and a diff content block, and the
/// engine's own three options with its own ids.
///
/// The JSON-RPC id is `fs-1` deliberately: the fixture has one generic
/// reverse-request reply capture and keys it on that id, so reusing it is
/// reusing the fixture rather than teaching it a second protocol.
pub fn permission_frame(session_id: &str, path: &Path) -> String {
    let path = path.to_string_lossy().into_owned();
    json!({
        "jsonrpc": "2.0",
        "id": "fs-1",
        "method": "session/request_permission",
        "params": {
            "sessionId": session_id,
            "toolCall": {
                "toolCallId": "call_1",
                "title": path,
                "kind": "edit",
                "status": "pending",
                "locations": [{ "path": path }],
                "rawInput": { "filepath": path, "diff": format!("Index: {path}") },
                "content": [{
                    "type": "diff",
                    "path": path,
                    "oldText": "HELLO",
                    "newText": "HELLO",
                }],
            },
            "options": [
                { "optionId": "once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
                { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
            ],
        },
    })
    .to_string()
}

pub fn fixture(behaviour: &str, capture: &Path, frame: &str) -> EngineLaunch {
    EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            behaviour.to_string(),
        ],
        // The fixture prints this verbatim after `session/new`, which is where
        // the engine asks in practice: the request arrives inside a turn.
        env: env_pairs(vec![
            (
                "NWK_FAKE_CAPTURE".to_string(),
                capture.to_string_lossy().into_owned(),
            ),
            ("NWK_FAKE_FS_REQUEST".to_string(), frame.to_string()),
        ]),
        ca_bundle: None,
    }
}

pub async fn start(launch: &EngineLaunch) -> (AgentRuntime, AgentRuntimeEvents) {
    let (connection, events) = EngineConnection::connect(launch)
        .await
        .expect("the fixture engine should start");
    AgentRuntime::new(
        identity(),
        connection,
        events,
        Arc::new(NoVault),
        LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
    )
}

// --- What the engine received ---

/// Every frame the fixture saw that answered its reverse request, parsed.
pub fn replies(capture: &Path) -> Vec<Value> {
    fs::read_to_string(capture)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.strip_prefix("fs-reply="))
        .map(|frame| {
            serde_json::from_str(frame).expect("the fixture captured a JSON protocol frame")
        })
        .collect()
}

/// Waits for `count` answers to reach the engine, then returns them.
pub async fn wait_for_replies(capture: &Path, count: usize) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let captured = replies(capture);
        if captured.len() >= count {
            return captured;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the engine was answered {count} times at most; it got {captured:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits until at least one frame has reached the engine. The callers below read the file again
/// for their assertions, so the wait is the whole point.
pub async fn wait_for_an_answer(capture: &Path) {
    wait_for_replies(capture, 1).await;
}

/// Asserts that the engine was answered exactly once, with `outcome`.
///
/// The frame is a JSON-RPC **result** carrying our outcome — not the SDK's own error frame, which
/// is what an unregistered handler produces.
pub async fn answered_once(capture: &Path, outcome: Value) {
    wait_for_an_answer(capture).await;
    tokio::time::sleep(SILENCE).await;
    let captured = replies(capture);
    assert_eq!(
        captured.len(),
        1,
        "the engine must be answered exactly once: {captured:?}"
    );
    assert_eq!(
        captured[0]["id"],
        json!("fs-1"),
        "the answer goes to the request"
    );
    assert!(
        captured[0].get("error").is_none(),
        "an error frame here would be the SDK answering, not us: {:?}",
        captured[0]
    );
    assert_eq!(captured[0]["result"]["outcome"], outcome);
}

/// Asserts that our code refused and *nothing* went out.
///
/// The negative control: this is what fails first if something else — the SDK's default handler, a
/// second code path — answers the engine for us.
pub async fn refused_and_silent(capture: &Path) {
    tokio::time::sleep(SILENCE).await;
    let captured = replies(capture);
    assert!(
        captured.is_empty(),
        "a refused answer must not reach the engine, but these did: {captured:?}"
    );
}

// --- Driving one request through the host ---

/// One permission request, all the way through: the engine asked, this host adopted it, and the
/// renderer has a prompt.
pub struct Asked {
    /// The asking half, shared the way the IPC state shares it: every call it answers takes
    /// `&self`, so a test can hand the state its own share and keep using the runtime.
    pub runtime: Arc<AgentRuntime>,
    /// The engine's stream. Kept beside the runtime because the runtime no longer owns it: the
    /// one task that reads an engine owns both of its receivers by value (`driver.rs`).
    events: AgentRuntimeEvents,
    pub table: Arc<PermissionTable>,
    pub prompt: PermissionPrompt,
    /// The envelope the prompt arrived in. The identity an answer must carry is the one the
    /// renderer was *told*, so the tests build their answers from here — exactly what a correct UI
    /// would echo back.
    pub envelope: AgentEventEnvelope,
    pub capture: PathBuf,
    pub session_id: String,
}

impl Asked {
    /// The four fields a runtime is started with — the identity `Session` carries (the fifth, the
    /// session id, is the engine's and arrives with `session/new`).
    pub fn runtime_identity(&self) -> AgentIdentity {
        AgentIdentity {
            agent_id: self.envelope.agent_id.clone(),
            profile_id: self.envelope.profile_id.clone(),
            runtime_epoch: self.envelope.runtime_epoch.clone(),
            vault_id: self.envelope.vault_id.clone(),
        }
    }

    fn identity(&self) -> PermissionIdentity {
        PermissionIdentity {
            agent_id: self.envelope.agent_id.clone(),
            profile_id: self.envelope.profile_id.clone(),
            runtime_epoch: self.envelope.runtime_epoch.clone(),
            vault_id: self.envelope.vault_id.clone(),
            session_id: self.envelope.session_id.clone(),
        }
    }

    /// A correct answer, which the forged ones below then spoil in one field.
    pub fn answer(&self, option_id: &str) -> PermissionAnswer {
        PermissionAnswer {
            session: self.identity(),
            request_id: self.prompt.request_id.clone(),
            option_id: option_id.to_string(),
        }
    }
}

/// Drives one permission frame through the runtime and returns the pending
/// prompt.
///
/// `open_run` issues a generation first, so the prompt is bound to a run id.
/// The `good` behaviour answers that generation immediately — the run is then
/// finished, but its id is still the identity the request was raised under,
/// which is the whole point of the binding.
pub async fn ask(label: &str, open_run: bool) -> Asked {
    ask_full(label, "good", open_run, None).await
}

/// As [`ask`], but the fixture's behaviour and the frame it sends can be
/// replaced. The frame may be more than one frame: the fixture prints whatever
/// it is given, which is how a peer cancellation is delivered.
pub async fn ask_full(
    label: &str,
    behaviour: &str,
    open_run: bool,
    frame: Option<String>,
) -> Asked {
    let dir = temp_dir(label);
    let capture = dir.join("capture");
    let vault = temp_dir(&format!("{label}-vault"));
    let frame = frame.unwrap_or_else(|| permission_frame("ses_fake_1", &vault.join("note.md")));
    let (runtime, mut events) = start(&fixture(behaviour, &capture, &frame)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(&vault)
        .await
        .expect("the fixture opens a session");
    let table = PermissionTable::new(identity(), &runtime);
    if open_run {
        runtime
            .prompt(&session.session_id, "write the note", &[])
            .expect("a prompt starts a run");
    }
    let prompt = table
        .adopt_next(&mut events)
        .await
        .expect("the engine asked for permission")
        .expect("the request belongs to a session this host opened");
    let envelope = event_of_kind(&mut events, AgentEventKind::PermissionRequest).await;
    Asked {
        runtime: Arc::new(runtime),
        events,
        table,
        prompt,
        envelope,
        capture,
        session_id: session.session_id,
    }
}

/// The next host event of `kind`, skipping whatever else the run produced.
async fn event_of_kind(
    events: &mut AgentRuntimeEvents,
    kind: AgentEventKind,
) -> AgentEventEnvelope {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let event = next_event(events, deadline).await;
        if event.kind == kind {
            return event;
        }
    }
}

/// Reads until the turn's first text delta, which is how a test knows the fixture has reached its
/// prompt branch.
pub async fn drain_until_text(asked: &mut Asked) {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let event = next_event(&mut asked.events, deadline).await;
        if event.kind == AgentEventKind::TextDelta {
            return;
        }
    }
}

async fn next_event(
    events: &mut AgentRuntimeEvents,
    deadline: tokio::time::Instant,
) -> AgentEventEnvelope {
    tokio::time::timeout_at(deadline, events.next_event())
        .await
        .expect("an event should arrive")
        .expect("the runtime should still be running")
}
