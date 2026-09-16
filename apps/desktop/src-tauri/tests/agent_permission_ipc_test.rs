//! R2 — the permission boundary: does *this host* answer the engine's request,
//! and does it refuse the answers it must?
//!
//! The engine half is the fixture (`tests/fixtures/agent/fake_agent.sh`), which sends a
//! `session/request_permission` frame verbatim from the environment — the shape P0 §7.1 measured on
//! the pinned engine, not one invented here. Every test drives that frame through the real runtime,
//! the real transport and the real permission table, then reads what the engine received back out
//! of the fixture's capture file.
//!
//! **Why the capture file is the assertion, and not "the call returned Ok".** A previous version of
//! the runtime's handlers was never invoked at all: `Responder<T>` defaults its type parameter to
//! `serde_json::Value`, so a handler registered without the annotation took requests of the wrong
//! type and the SDK answered them itself — and three tests passed on the SDK's answer. A success
//! response is therefore not evidence that our code produced it. What this file asserts instead is
//! the frame that reached the engine, plus a negative control: while a prompt is open and
//! unanswered, and after every refusal, the wire stays silent. If the SDK were answering for us,
//! that silence is the first assertion to fail.
//!
//! Module inclusion: `agent_runtime/mod.rs` does not declare `permissions` and `commands/mod.rs`
//! does not declare `agent` — registering either is T4's (`lib.rs` and `commands/mod.rs` are that
//! task's serialized files), and the same wiring point as registering the command. Both are
//! included by path, so this test compiles exactly the source the library will build.
//!
//! The runtime tree is declared here rather than pulled in with `include!(".../mod.rs")`, because
//! `include!` cannot carry that file's inner doc comments into a module body. The module list is
//! the same list: a name that drifted from `mod.rs` would fail to compile here rather than silently
//! test something else.

#[path = "../src/agent_runtime"]
mod agent_runtime {
    pub mod acp_transport;
    pub mod events;
    pub mod fs_capability;
    pub mod permissions;
    pub mod process;
    pub mod runs;
    pub mod session;

    pub use acp_transport::EngineConnection;
    pub use events::{AgentEventEnvelope, AgentEventKind, AgentIdentity};
    pub use fs_capability::VaultFiles;
    pub use process::EngineLaunch;
    pub use session::AgentRuntime;
}


#[path = "../src/commands"]
mod commands {
    pub mod agent;
}

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use agent_runtime::permissions::{
    PermissionAnswer, PermissionIdentity, PermissionPrompt, PermissionRefusal, PermissionTable,
    ToolInput, cancel_run,
};
use agent_runtime::{
    AgentEventEnvelope, AgentEventKind, AgentIdentity, AgentRuntime, EngineConnection, EngineLaunch,
    VaultFiles,
};
use commands::agent::{AgentIpcState, apply_permission_answer, pending_prompts, refusal_message};

/// T2's transport tests panic in a vault; this file's frame is a permission request, so the same
/// stub holds: reaching the vault would mean the fixture sent something unexpected.
struct NoVault;

impl VaultFiles for NoVault {
    fn read(&self, _: &str, _: &str) -> Result<String, String> {
        panic!("a permission test must not read a vault")
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<Option<String>, String> {
        panic!("a permission test must not write a vault")
    }
}

/// Generous enough that a slow machine does not produce a flake, short enough that a genuine hang
/// fails rather than the suite's timeout.
const PATIENCE: Duration = Duration::from_secs(10);

/// How long a test waits before asserting that a refusal left the wire silent: long enough for an
/// answer that was going to be sent to have been sent. The assertion is worthless without a window.
const SILENCE: Duration = Duration::from_millis(300);

fn fixture_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agent/fake_agent.sh")
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nkw-perm-{label}-{}", std::process::id()));
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

/// The permission frame, in the shape P0 §7.1 measured against the pinned
/// engine: a `toolCall` with a `rawInput` and a diff content block, and the
/// engine's own three options with its own ids.
///
/// The JSON-RPC id is `fs-1` deliberately: the fixture has one generic
/// reverse-request reply capture and keys it on that id, so reusing it is
/// reusing the fixture rather than teaching it a second protocol.
fn permission_frame(session_id: &str, path: &Path) -> String {
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

fn fixture(behaviour: &str, capture: &Path, frame: &str) -> EngineLaunch {
    EngineLaunch {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            fixture_script().to_string_lossy().into_owned(),
            behaviour.to_string(),
        ],
        // The fixture prints this verbatim after `session/new`, which is where
        // the engine asks in practice: the request arrives inside a turn.
        env: vec![
            (
                "NWK_FAKE_CAPTURE".to_string(),
                capture.to_string_lossy().into_owned(),
            ),
            ("NWK_FAKE_FS_REQUEST".to_string(), frame.to_string()),
        ],
        ca_bundle: None,
    }
}

async fn start(launch: &EngineLaunch) -> AgentRuntime {
    let (connection, events) = EngineConnection::connect(launch)
        .await
        .expect("the fixture engine should start");
    AgentRuntime::new(identity(), connection, events, Arc::new(NoVault))
}

// --- What the engine received ---

/// Every frame the fixture saw that answered its reverse request, parsed.
fn replies(capture: &Path) -> Vec<Value> {
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
async fn wait_for_replies(capture: &Path, count: usize) -> Vec<Value> {
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
async fn wait_for_an_answer(capture: &Path) {
    wait_for_replies(capture, 1).await;
}

/// Asserts that the engine was answered exactly once, with `outcome`.
///
/// The frame is a JSON-RPC **result** carrying our outcome — not the SDK's own error frame, which
/// is what an unregistered handler produces.
async fn answered_once(capture: &Path, outcome: Value) {
    wait_for_an_answer(capture).await;
    tokio::time::sleep(SILENCE).await;
    let captured = replies(capture);
    assert_eq!(captured.len(), 1, "the engine must be answered exactly once: {captured:?}");
    assert_eq!(captured[0]["id"], json!("fs-1"), "the answer goes to the request");
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
async fn refused_and_silent(capture: &Path) {
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
struct Asked {
    runtime: AgentRuntime,
    table: Arc<PermissionTable>,
    prompt: PermissionPrompt,
    /// The envelope the prompt arrived in. The identity an answer must carry is the one the
    /// renderer was *told*, so the tests build their answers from here — exactly what a correct UI
    /// would echo back.
    envelope: AgentEventEnvelope,
    capture: PathBuf,
    session_id: String,
}

impl Asked {
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
    fn answer(&self, option_id: &str) -> PermissionAnswer {
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
async fn ask(label: &str, open_run: bool) -> Asked {
    ask_full(label, "good", open_run, None).await
}

/// As [`ask`], but the fixture's behaviour and the frame it sends can be
/// replaced. The frame may be more than one frame: the fixture prints whatever
/// it is given, which is how a peer cancellation is delivered.
async fn ask_full(label: &str, behaviour: &str, open_run: bool, frame: Option<String>) -> Asked {
    let dir = temp_dir(label);
    let capture = dir.join("capture");
    let vault = temp_dir(&format!("{label}-vault"));
    let frame = frame.unwrap_or_else(|| permission_frame("ses_fake_1", &vault.join("note.md")));
    let mut runtime = start(&fixture(behaviour, &capture, &frame)).await;
    runtime.initialize().await.expect("initialize");
    let session = runtime
        .open_session(&vault)
        .await
        .expect("the fixture opens a session");
    let table = PermissionTable::new(identity(), &runtime);
    if open_run {
        runtime
            .prompt(&session.session_id, "write the note")
            .expect("a prompt starts a run");
    }
    let prompt = table
        .adopt_next(&mut runtime)
        .await
        .expect("the engine asked for permission")
        .expect("the request belongs to a session this host opened");
    let envelope = event_of_kind(&mut runtime, AgentEventKind::PermissionRequest).await;
    Asked {
        runtime,
        table,
        prompt,
        envelope,
        capture,
        session_id: session.session_id,
    }
}

/// The next host event of `kind`, skipping whatever else the run produced.
async fn event_of_kind(runtime: &mut AgentRuntime, kind: AgentEventKind) -> AgentEventEnvelope {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let event = next_event(runtime, deadline).await;
        if event.kind == kind {
            return event;
        }
    }
}

/// Reads until the turn's first text delta, which is how a test knows the fixture has reached its
/// prompt branch.
async fn drain_until_text(asked: &mut Asked) {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let event = next_event(&mut asked.runtime, deadline).await;
        if event.kind == AgentEventKind::TextDelta {
            return;
        }
    }
}

async fn next_event(
    runtime: &mut AgentRuntime,
    deadline: tokio::time::Instant,
) -> AgentEventEnvelope {
    tokio::time::timeout_at(deadline, runtime.recv_event())
        .await
        .expect("an event should arrive")
        .expect("the runtime should still be running")
}

/// Compile-time claims about what T4 will wire: the state `tauri::State` needs is `Send + Sync +
/// 'static`, and the command entry points and constructor referenced here are the ones that exist —
/// nothing in this crate registers them yet (`generate_handler!` is in `lib.rs`, T4's file), and a
/// rename that no handler noticed would otherwise only surface there.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync + 'static>() {}
    assert_send_sync::<AgentRuntime>();
    assert_send_sync::<PermissionTable>();
    assert_send_sync::<AgentIpcState>();
    let _ = AgentIpcState::new;
    let _ = commands::agent::agent_permission_answer;
    let _ = commands::agent::agent_cancel_run;
};

// --- The proof that our handler answered ---

#[tokio::test]
async fn our_handler_answers_the_engines_permission_request() {
    // The one test this task exists for: a real permission frame, through our runtime, answered by
    // our code, with the engine's own option id in the answer — an id only our table could have
    // picked out of the three.
    let asked = ask("answers", true).await;

    // The negative control, before any answer exists: the engine is blocking on this request and
    // nothing has answered it. If the SDK were replying on our behalf — the failure that made three
    // earlier tests pass for the wrong reason — this is the assertion that would fail.
    refused_and_silent(&asked.capture).await;

    apply_permission_answer(&asked.table, asked.answer("always")).expect("the engines own option");
    answered_once(
        &asked.capture,
        json!({ "outcome": "selected", "optionId": "always" }),
    )
    .await;
    assert!(asked.table.pending().is_empty(), "the prompt is over");
    asked.runtime.shutdown();
}

#[tokio::test]
async fn the_prompt_carries_the_engines_own_options_and_its_identity() {
    let asked = ask("payload", true).await;
    let prompt = &asked.prompt;

    // §6.3: the option set is the engine's, ids included — the prompt shows what the engine sent,
    // not a list this host rebuilt — and all four kinds survive rather than a collapsed pair.
    let offered: Vec<&str> = prompt.options.iter().map(|option| option.option_id.as_str()).collect();
    assert_eq!(offered, ["once", "always", "reject"]);
    assert_eq!(prompt.options[1].name, "Always allow");
    assert_eq!(
        serde_json::to_value(prompt.options[1].kind).expect("a kind serializes"),
        json!("allow_always")
    );

    // What the user is asked to approve, out of the engine's own frame: its title, and the
    // arguments it sent (the measured frame carries `rawInput` with the diff in it).
    assert!(prompt.title.ends_with("note.md"), "{}", prompt.title);
    let ToolInput::Text { json } = &prompt.input else {
        panic!("the measured frame carries rawInput, so the input is text: {:?}", prompt.input);
    };
    assert!(json.contains("Index:"), "{json}");

    // The payload is the contract's `AgentPermissionRequest`, field for field: the reader that
    // validates it at the gateway drops anything it cannot read, so a renamed or missing field
    // here would silently take the prompt away from the user.
    let payload = serde_json::to_value(prompt).expect("the payload serializes");
    for key in ["requestId", "toolCallId", "title", "input", "options"] {
        assert!(payload.get(key).is_some(), "the contract reads {key}: {payload}");
    }
    assert_eq!(payload["input"]["state"], json!("text"));
    assert_eq!(payload["options"][0]["kind"], json!("allow_once"));

    // §6.1: the identity the renderer is told is the identity an answer must come back with — the
    // envelope's fields and the binding agree by construction, since `adopt` builds both from one
    // identity.
    assert_eq!(prompt.tool_call_id, "call_1");
    assert_eq!(asked.envelope.agent_id, "opencode");
    assert_eq!(asked.envelope.vault_id, "vault-1");
    assert_eq!(asked.envelope.session_id, asked.session_id);
    assert_eq!(asked.envelope.run_id.as_deref(), Some("run-0"));

    // And the answer built from that envelope is accepted — the other half of the claim: the
    // binding is not stricter than what the UI is given.
    apply_permission_answer(&asked.table, asked.answer("once")).expect("the identity matches");
    asked.runtime.shutdown();
}

// --- The refusals ---

#[tokio::test]
async fn an_option_the_engine_never_offered_is_refused() {
    // §6.3 with §2.0b: the host must not invent a decision the engine did not offer.
    // `always-forever` is not one of the engine's ids, so it is refused — and the prompt stays
    // answerable, because a bad answer must not be able to consume a live request.
    let asked = ask("unknown-option", false).await;

    let refusal = apply_permission_answer(&asked.table, asked.answer("always-forever"))
        .expect_err("an id the engine did not offer is not a decision");
    assert_eq!(
        refusal,
        PermissionRefusal::OptionNotOffered { option_id: "always-forever".to_string() }
    );
    refused_and_silent(&asked.capture).await;

    apply_permission_answer(&asked.table, asked.answer("once")).expect("an offered id");
    answered_once(&asked.capture, json!({ "outcome": "selected", "optionId": "once" })).await;
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_second_answer_to_the_same_request_is_refused() {
    // §6.3's 「重复点击幂等」, made a no-op where the decision is taken rather than relying on the
    // engine ignoring it (spec §3.5: Zed's duplicate still repaints the tool call). The evidence is
    // that the engine was answered once, with the option that won.
    let asked = ask("duplicate", false).await;

    apply_permission_answer(&asked.table, asked.answer("once")).expect("the first click");
    let refusal = apply_permission_answer(&asked.table, asked.answer("reject"))
        .expect_err("the second click is not a second decision");
    assert_eq!(
        refusal,
        PermissionRefusal::AlreadyAnswered { request_id: asked.prompt.request_id.clone() }
    );
    // The renderer is told which fact it hit, not only that something failed.
    assert!(
        refusal_message(&refusal).contains("answered already"),
        "{}",
        refusal_message(&refusal)
    );
    answered_once(&asked.capture, json!({ "outcome": "selected", "optionId": "once" })).await;
    asked.runtime.shutdown();
}

#[tokio::test]
async fn an_answer_for_another_vault_is_refused() {
    // §10.2's cross-vault case. The engine session outlives a vault switch, so a window still
    // holding this prompt would otherwise authorize work in a vault the user has left.
    let asked = ask("cross-vault", false).await;

    let mut answer = asked.answer("once");
    answer.session.vault_id = "vault-2".to_string();
    let refusal = apply_permission_answer(&asked.table, answer).expect_err("not this vault");
    assert_eq!(refusal, PermissionRefusal::IdentityMismatch { field: "vaultId" });
    refused_and_silent(&asked.capture).await;

    apply_permission_answer(&asked.table, asked.answer("once")).expect("the real vault still wins");
    answered_once(&asked.capture, json!({ "outcome": "selected", "optionId": "once" })).await;
    asked.runtime.shutdown();
}

#[tokio::test]
async fn forged_identity_fields_are_refused_one_by_one() {
    // §11.1: the renderer is not a trusted source of identity. Each field is checked against what
    // the backend recorded, so a forged session, engine, profile or runtime incarnation is refused
    // rather than acted on — and the prompt survives every one of them.
    let asked = ask("forged", true).await;
    let forgeries: [(&str, fn(&mut PermissionIdentity)); 4] = [
        ("sessionId", |session| session.session_id = "ses_someone_elses".to_string()),
        ("agentId", |session| session.agent_id = "another-engine".to_string()),
        ("profileId", |session| session.profile_id = "another-profile".to_string()),
        ("runtimeEpoch", |session| session.runtime_epoch = "epoch-0".to_string()),
    ];

    for (field, spoil) in forgeries {
        let mut answer = asked.answer("once");
        spoil(&mut answer.session);
        let refusal = apply_permission_answer(&asked.table, answer)
            .expect_err("a forged field must be refused");
        assert_eq!(refusal, PermissionRefusal::IdentityMismatch { field });
    }

    refused_and_silent(&asked.capture).await;
    apply_permission_answer(&asked.table, asked.answer("reject")).expect("the real answer works");
    answered_once(&asked.capture, json!({ "outcome": "selected", "optionId": "reject" })).await;
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_request_for_an_unknown_session_is_refused_to_the_engine() {
    // The engine asked about a session this host never opened: nothing to bind the request to, so
    // no prompt — and the engine is told, because it is blocking on this request (spec §2.5: an
    // error naming the id, not silence).
    let dir = temp_dir("unknown-session");
    let capture = dir.join("capture");
    let frame = permission_frame("ses_not_ours", &dir.join("note.md"));
    let mut runtime = start(&fixture("good", &capture, &frame)).await;
    runtime.initialize().await.expect("initialize");
    let vault = temp_dir("unknown-session-vault");
    runtime.open_session(&vault).await.expect("a session of our own");
    let table = PermissionTable::new(identity(), &runtime);

    let refused = table
        .adopt_next(&mut runtime)
        .await
        .expect("the engine asked anyway")
        .expect_err("that session is not this host's");
    assert!(matches!(refused, PermissionRefusal::UnknownSession { .. }));

    let captured = wait_for_replies(&capture, 1).await;
    let error = &captured[0]["error"];
    assert_eq!(error["code"], json!(-32603), "{captured:?}");
    assert_eq!(error["data"], json!("unknown session: ses_not_ours"));
    assert!(table.pending().is_empty(), "no prompt was published");
    runtime.shutdown();
}

// --- Ending a request: cancel, exit, and the engine giving up ---

#[tokio::test]
async fn cancelling_ends_the_prompt_and_answers_it_cancelled() {
    // §6.2: cancelling ends the pending request and the old authorise button is inert afterwards.
    // The answer is `cancelled`, not a rejection: the turn died and the user decided nothing (spec
    // §2.0b) — and the engine is blocking on this request either way.
    let asked = ask("cancel", true).await;

    cancel_run(&asked.runtime, &asked.table, &asked.session_id)
        .await
        .expect("the session is this host's");
    answered_once(&asked.capture, json!({ "outcome": "cancelled" })).await;

    let refusal = apply_permission_answer(&asked.table, asked.answer("once"))
        .expect_err("a prompt that ended cannot be answered");
    assert_eq!(
        refusal,
        PermissionRefusal::Expired { request_id: asked.prompt.request_id.clone() }
    );
    // The refused click adds nothing: the engine's one answer is the `cancelled`
    // above, and it stays that way.
    tokio::time::sleep(SILENCE).await;
    assert_eq!(
        replies(&asked.capture).len(),
        1,
        "a refused answer must not reach the engine"
    );
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_stop_resolves_the_prompt_before_the_engine_is_told_to_cancel() {
    // §2.0b's ordering requirement — resolve outstanding permissions *before*
    // sending the turn cancel — measured rather than assumed.
    //
    // The instrument is the fixture's own read loop: while a turn is in flight it sits in an inner
    // `read` that only looks for `session/cancel` and swallows everything else, returning to the
    // loop that records reverse-request replies only after it has seen the cancel. A permission
    // answer sent *before* the cancel is therefore never recorded, and one sent after it always is.
    // `stream` is the behaviour that holds a turn open like that.
    //
    // The guards are what keep this from passing for the wrong reason: the fixture must have
    // entered that inner loop, the prompt must have been adopted and revoked, and the connection
    // must still be alive when its answer is written — so an empty capture cannot mean "we sent
    // nothing".
    let mut asked = ask_full("stop-order", "stream", true, None).await;
    drain_until_text(&mut asked).await;
    // The fixture waits 300 ms inside its prompt branch before it starts
    // reading; the turn's first delta is written before that.
    tokio::time::sleep(Duration::from_millis(500)).await;

    cancel_run(&asked.runtime, &asked.table, &asked.session_id)
        .await
        .expect("the session is this host's");

    assert!(asked.table.pending().is_empty(), "the prompt was resolved");
    let refusal = apply_permission_answer(&asked.table, asked.answer("once"))
        .expect_err("a prompt that ended cannot be answered");
    assert_eq!(
        refusal,
        PermissionRefusal::Expired { request_id: asked.prompt.request_id.clone() }
    );
    // Alive, and still answering the engine: a dead transport would make the
    // empty capture below meaningless.
    asked
        .runtime
        .cancel(&asked.session_id)
        .await
        .expect("the engine is still connected");
    tokio::time::sleep(SILENCE).await;
    let captured = replies(&asked.capture);
    assert!(
        captured.is_empty(),
        "the prompt was answered after the cancel, not before it: {captured:?}"
    );
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_cancel_and_an_authorization_race_and_exactly_one_wins() {
    // §2.3's 「取消与授权同时发生」: a click and a Stop can land in the same instant, and the
    // protocol allows exactly one answer per request. Whichever wins, the losing side must have
    // changed nothing on the wire.
    let asked = ask("race", true).await;
    let answer = asked.answer("once");
    let table = Arc::clone(&asked.table);
    let session_id = asked.session_id.clone();

    let clicked = tokio::spawn(async move { apply_permission_answer(&table, answer) });
    let stopped = asked.table.revoke_session(&session_id);
    let click = clicked.await.expect("the click task finished");

    wait_for_an_answer(&asked.capture).await;
    tokio::time::sleep(SILENCE).await;
    let captured = replies(&asked.capture);
    assert_eq!(captured.len(), 1, "a race is still one answer: {captured:?}");
    let outcome = captured[0]["result"]["outcome"].clone();
    // Either side may win, and the pair of results has to agree about which did: an accepted click
    // means nothing was cancelled, a revoked prompt means the click was refused.
    if click.is_ok() {
        assert_eq!(stopped, 0, "the click won, so there was nothing to revoke");
        assert_eq!(outcome["outcome"], json!("selected"));
    } else {
        assert_eq!(stopped, 1, "the cancel won, so it revoked the prompt");
        assert_eq!(outcome["outcome"], json!("cancelled"));
    }
    assert!(asked.table.pending().is_empty(), "and it is over either way");
    asked.runtime.shutdown();
}

#[tokio::test]
async fn a_process_exit_ends_every_pending_request() {
    // §6.2's other route to the same rule: 「进程退出使所有悬挂请求结束」. Zed implements neither
    // this nor the cancel case (spec §6 item 6), so the only authority is what happens here.
    let asked = ask("exit", false).await;
    let pid = wait_for_pid(&asked.capture).await;

    asked.runtime.shutdown();
    assert!(
        wait_until_gone(pid).await,
        "the fixture engine should have exited"
    );

    assert_eq!(
        asked.table.revoke_all(),
        1,
        "the exit ends the one request still open"
    );
    let refusal = apply_permission_answer(&asked.table, asked.answer("once"))
        .expect_err("a request that ended with the process cannot be answered");
    assert_eq!(
        refusal,
        PermissionRefusal::Expired { request_id: asked.prompt.request_id.clone() }
    );
    // Nothing was sent: the engine it would have been sent to is gone.
    refused_and_silent(&asked.capture).await;
}

#[tokio::test]
async fn the_engine_cancelling_its_own_request_revokes_the_prompt() {
    // The other half of §2.3's mechanism: the side that raised a request can cancel it, and then
    // the prompt must go. The answer is an error, not `cancelled` — which would tell the engine the
    // turn died — and not a silent drop.
    let vault = temp_dir("peer-cancel-vault");
    let frame = format!(
        "{}\n{}",
        permission_frame("ses_fake_1", &vault.join("note.md")),
        json!({
            "jsonrpc": "2.0",
            "method": "$/cancel_request",
            "params": { "requestId": "fs-1" },
        })
    );
    let asked = ask_full("peer-cancel", "good", false, Some(frame)).await;

    let captured = wait_for_replies(&asked.capture, 1).await;
    assert_eq!(
        captured[0]["error"]["code"],
        json!(-32800),
        "the peer gets the standard cancellation error: {captured:?}"
    );
    assert!(captured[0]["error"]["message"].is_string(), "{captured:?}");
    assert!(asked.table.pending().is_empty(), "the prompt was revoked");
    let refusal = apply_permission_answer(&asked.table, asked.answer("once"))
        .expect_err("a revoked prompt cannot be answered");
    assert_eq!(
        refusal,
        PermissionRefusal::Expired { request_id: asked.prompt.request_id.clone() }
    );
    asked.runtime.shutdown();
}

// --- The IPC layer, as the composition root will hold it ---

#[tokio::test]
async fn the_ipc_state_carries_the_runtime_and_the_prompt_snapshot() {
    // The state Tauri registers, built the way `lib.rs` will build it: the runtime and the table in
    // one state, with the sharing the commands need. §6.2's remount snapshot — taken before the
    // subscription starts — has to see the open prompt, or a reloaded window would answer blind.
    let asked = ask("ipc-state", false).await;
    assert_eq!(pending_prompts(&asked.table).len(), 1, "the open prompt is in the snapshot");

    // Built the way the composition has to: the table exists *before* the runtime is shared, since
    // the driver that feeds it takes requests off the runtime through `&mut`, and a state made by
    // `AgentIpcState::new` would hold a second table that never saw this prompt.
    let answer = asked.answer("once");
    let state = AgentIpcState {
        runtime: Arc::new(asked.runtime),
        permissions: Arc::clone(&asked.table),
    };
    apply_permission_answer(&state.permissions, answer).expect("through the state's own table");

    assert!(pending_prompts(&state.permissions).is_empty(), "answered, so nothing is pending");
    wait_for_an_answer(&asked.capture).await;
    state.runtime.shutdown();
}

// --- Watching the process itself ---

/// The fixture's own pid, which it reports as its first capture line.
async fn wait_for_pid(capture: &Path) -> i32 {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        if let Ok(recorded) = fs::read_to_string(capture) {
            if let Some(pid) = recorded
                .lines()
                .find_map(|line| line.strip_prefix("pid="))
                .and_then(|value| value.trim().parse().ok())
            {
                return pid;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the fixture never reported its pid"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Whether the process is gone. Nothing here signals anything: this pid is evidence that the exit
/// happened, not a target.
async fn wait_until_gone(pid: i32) -> bool {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
