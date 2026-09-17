//! What a turn carries beside its words, read off the wire.
//!
//! The unit tests in `src/agent_runtime/attachments.rs` hold the mapping down — text first, then
//! each attachment as the block ACP names for it, and a refusal where the engine's own report does
//! not license the block. What only a real process can answer is the other half of the same claim:
//! that the frame leaving this host is the one the engine was promised. So these tests read the
//! fixture's own capture of the `session/prompt` line, and the refusal is checked the same way —
//! by the absence of a line rather than by our own error type alone.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nekowite_lib::agent_runtime::attachments::PromptAttachment;
use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::{
    env_pairs, AgentIdentity, AgentRuntime, AgentRuntimeEvents, EngineConnection, EngineLaunch,
    SessionError, VaultFiles,
};

/// Reaching either of these means the test asked for something it did not set up.
struct NoVault;
struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

impl VaultFiles for NoVault {
    fn frontend_path(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a prompt-payload test asks no window about a note")
    }
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a prompt-payload test reads no vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("a prompt-payload test writes no vault")
    }
}

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn capture_path(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-attach-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir.join("capture")
}

fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "default".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-1".to_string(),
    }
}

async fn start(behaviour: &str, capture: &Path) -> (AgentRuntime, AgentRuntimeEvents) {
    let launch = EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            behaviour.to_string(),
        ],
        env: env_pairs(vec![(
            "NWK_FAKE_CAPTURE".to_string(),
            capture.to_string_lossy().into_owned(),
        )]),
        ca_bundle: None,
    };
    let (connection, events) = EngineConnection::connect(&launch)
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

/// Opens a session on a vault root the fixture never touches, and drains the opening frames so a
/// test's assertions see only what its own turn produced.
async fn open(runtime: &AgentRuntime, events: &mut AgentRuntimeEvents) -> String {
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(Path::new("/vault"))
        .await
        .expect("session/new");
    // The command list is published right after `session/new` (P0 §2.2); reading until it arrives
    // is what makes the capture below belong to the turn rather than to the opening.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.next_event()).await {
        if event.kind == nekowite_lib::agent_runtime::AgentEventKind::CommandsChanged {
            break;
        }
    }
    session.session_id
}

/// Every line the fixture captured that is a prompt frame.
fn prompts(capture: &Path) -> Vec<String> {
    fs::read_to_string(capture)
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with("prompt="))
        .map(str::to_string)
        .collect()
}

fn a_file() -> PromptAttachment {
    PromptAttachment::Resource {
        path: "notes/a.md".to_string(),
        text: "# a".to_string(),
        media_type: "text/markdown".to_string(),
    }
}

fn an_image() -> PromptAttachment {
    PromptAttachment::Image {
        name: "shot.png".to_string(),
        media_type: "image/png".to_string(),
        data: "QUJD".to_string(),
    }
}

/// The IPC payload the window sends for an image chosen in the `+` or dragged onto the field,
/// spelled exactly as `use-agent-composer-attachments.ts` hands it to the gateway: `{ kind, name,
/// mediaType, data }`, base64 with no `data:` prefix.
///
/// A literal rather than a built value, because the hop this spelling covers is the one a built
/// value skips: the tests below deserialize it, so a `PromptAttachment` whose serde shape stopped
/// matching the window's would fail here rather than silently accepting every attachment and
/// sending none. `agent-contracts-parity.test.ts` holds this enum's `kind` spellings to the
/// TypeScript union's, so the two sides of that literal cannot drift apart unnoticed either.
const PICKED_IMAGE_FROM_IPC: &str =
    r#"{"kind":"image","name":"knowledge-base-diagram.png","mediaType":"image/png","data":"QUJD"}"#;

/// The workspace file's payload, spelled the same way (`resourceAttachment`, same module).
const PICKED_FILE_FROM_IPC: &str =
    r##"{"kind":"resource","path":"notes/a.md","text":"# a","mediaType":"text/markdown"}"##;

/// Drain events until the run this turn started is over, so the capture below holds the whole turn.
async fn drain_run(events: &mut AgentRuntimeEvents) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.next_event()).await {
        if event.kind == nekowite_lib::agent_runtime::AgentEventKind::RunFinished {
            break;
        }
    }
}

#[tokio::test]
async fn the_engine_is_sent_the_blocks_a_turn_is_made_of() {
    let capture = capture_path("blocks");
    let (runtime, mut events) = start("good", &capture).await;
    let session = open(&runtime, &mut events).await;

    // The fixture's handshake is P0 §2.1's, so both blocks are licensed and this is the shape the
    // pinned engine would receive. `initialize` happens inside `open`, so the report is in hand.
    runtime
        .prompt(&session, "look at these", &[a_file(), an_image()])
        .expect("both capabilities were reported by the fixture's handshake");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.next_event()).await {
        if event.kind == nekowite_lib::agent_runtime::AgentEventKind::RunFinished {
            break;
        }
    }
    runtime.shutdown();

    let lines = prompts(&capture);
    assert_eq!(lines.len(), 1, "one turn, one prompt frame: {lines:?}");
    let frame = &lines[0];
    // The words, as text.
    assert!(
        frame.contains(r#""type":"text","text":"look at these""#),
        "the message's own words must be the first block: {frame}"
    );
    // The file, embedded whole and named by a URI the engine can resolve.
    assert!(
        frame.contains(r#""type":"resource""#),
        "a file must go out as a resource block: {frame}"
    );
    assert!(
        frame.contains(r#""uri":"file:///vault/notes/a.md""#),
        "the resource's uri must be the file's absolute path: {frame}"
    );
    assert!(
        frame.contains(r#""mimeType":"text/markdown""#),
        "the resource must carry the file's media type: {frame}"
    );
    assert!(
        frame.contains(r##""text":"# a""##),
        "the resource must carry the file's text: {frame}"
    );
    // The image, as base64 bytes with their type.
    assert!(
        frame.contains(r#""type":"image","data":"QUJD","mimeType":"image/png""#),
        "an image must go out as an image block: {frame}"
    );
    // The order the reader made: the words, then the file, then the image.
    let text_at = frame.find(r#""type":"text""#).expect("the text block");
    let file_at = frame.find(r#""type":"resource""#).expect("the resource");
    let image_at = frame.find(r#""type":"image""#).expect("the image");
    assert!(
        text_at < file_at && file_at < image_at,
        "the blocks must keep the order the turn was built in: {frame}"
    );
}

#[tokio::test]
async fn an_engine_that_reported_no_image_support_is_not_sent_one() {
    let capture = capture_path("refused");
    let (runtime, mut events) = start("modest-handshake", &capture).await;
    let session = open(&runtime, &mut events).await;

    let refused = runtime
        .prompt(&session, "look", &[an_image()])
        .expect_err("the fixture's handshake reports `promptCapabilities: {}`");
    let SessionError::AttachmentRefused { detail } = &refused else {
        panic!("the refusal must be its own condition, not a transport failure: {refused:?}");
    };
    assert!(detail.contains("image"), "{detail}");
    assert!(
        detail.contains("not supported"),
        "the sentence must say the engine reported it absent rather than that nobody looked: \
         {detail}"
    );
    runtime.shutdown();

    // The claim that matters, and the one only the wire can make: nothing was sent. A host that
    // dropped the block and prompted anyway would pass every assertion above and fail this one.
    assert!(
        prompts(&capture).is_empty(),
        "a refused turn must not reach the engine: {:?}",
        prompts(&capture)
    );
}

#[tokio::test]
async fn a_refused_turn_leaves_the_session_exactly_as_it_was() {
    let capture = capture_path("retry");
    let (runtime, mut events) = start("modest-handshake", &capture).await;
    let session = open(&runtime, &mut events).await;

    runtime
        .prompt(&session, "look", &[a_file()])
        .expect_err("no `embeddedContext` was reported");
    // The refusal above must not have registered a run: a second turn with nothing attached is
    // accepted, which it could not be if the first had left one in flight.
    runtime
        .prompt(&session, "just words", &[])
        .expect("the refused turn left no run behind");
    runtime.shutdown();
}

/// The claim the whole feature rests on, measured on the frame rather than on our own value: what a
/// reader attaches in the window is what the engine is sent.
///
/// The input is the window's own IPC spelling rather than a `PromptAttachment` built here, and the
/// assertion is on the captured `session/prompt` line rather than on `blocks()`'s return — because
/// the failure this guards against is not a wrong value, it is a *dropped* one. A host that built
/// the right block and then sent only the text would satisfy every assertion about its own struct
/// and fail this one.
#[tokio::test]
async fn what_the_window_attaches_is_what_the_engine_is_sent() {
    let capture = capture_path("picked");
    let (runtime, mut events) = start("good", &capture).await;
    let session = open(&runtime, &mut events).await;

    let picked: Vec<PromptAttachment> = [PICKED_FILE_FROM_IPC, PICKED_IMAGE_FROM_IPC]
        .iter()
        .map(|json| {
            serde_json::from_str(json).unwrap_or_else(|e| panic!("the window's own spelling: {e}"))
        })
        .collect();

    runtime
        .prompt(&session, "what is this?", &picked)
        .expect("the fixture's handshake reports both prompt capabilities");
    drain_run(&mut events).await;
    runtime.shutdown();

    let lines = prompts(&capture);
    assert_eq!(lines.len(), 1, "one turn, one prompt frame: {lines:?}");
    let frame = &lines[0];
    assert!(
        frame.contains(r#""type":"resource""#),
        "the picked file must go out as a resource block: {frame}"
    );
    assert!(
        frame.contains(r#""uri":"file:///vault/notes/a.md""#),
        "the resource must name the file the engine resolves: {frame}"
    );
    assert!(
        frame.contains(r#""type":"image","data":"QUJD","mimeType":"image/png""#),
        "the picked image must go out as an image block carrying its bytes: {frame}"
    );
}

/// The same pick against an engine that reported no image support, asserted the same way.
///
/// Two conditions have to hold together and only one of them is about this host: the turn is
/// refused, *and* nothing reached the wire. The second is the one a reader would believe was fine —
/// a silently dropped block leaves a model that was never shown the picture and a reader who was
/// never told.
#[tokio::test]
async fn the_same_pick_is_not_sent_to_an_engine_that_reads_no_images() {
    let capture = capture_path("picked-refused");
    let (runtime, mut events) = start("modest-handshake", &capture).await;
    let session = open(&runtime, &mut events).await;

    let image: PromptAttachment =
        serde_json::from_str(PICKED_IMAGE_FROM_IPC).expect("the window's own spelling");
    runtime
        .prompt(&session, "what is this?", &[image])
        .expect_err("the fixture's handshake reports `promptCapabilities: {}`");
    runtime.shutdown();

    assert!(
        prompts(&capture).is_empty(),
        "a turn holding an image the engine does not read must not reach it: {:?}",
        prompts(&capture)
    );
}
