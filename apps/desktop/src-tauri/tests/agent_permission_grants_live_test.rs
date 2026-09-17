//! The only evidence that matters for this surface: **a grant the user gave is removed, and the
//! engine asks again.**
//!
//! Two tests, and the difference between them is what drives the engine's own evaluation:
//!
//! - [`a_grant_that_is_revoked_stops_silencing_the_engine`] drives it with a **model** — three real
//!   prompts through the shipped host, so the whole product path is in the loop. It needs the test
//!   gateway's credential and skips without it.
//! - [`the_engines_own_evaluation_stops_silencing_after_the_revoke`] drives it with the **engine's
//!   own route**, the one its `edit` tool calls before it writes (`session.permission.create`,
//!   whose answer is the authenticated decision). No credential, no model, no prompt — and the same
//!   question, because "will the engine ask" is decided by that evaluation and by nothing else.
//!
//! The second exists because the first cannot always run, and a measurement that only happens on a
//! machine with a key is a measurement that quietly stops happening. It is deliberately the weaker
//! of the two and is not offered as a substitute where the prompt-driven one is available.
//!
//! `permission-configured.md` §5 measured what an `Always allow` costs: the engine writes it into
//! its own database, and a **later session is asked nothing at all** (`frames []`, the file still
//! written). This file re-measures that as its own control and then removes the grant through the
//! shipped path, so the three turns differ in exactly one thing — whether the engine still holds
//! the row this app's page would have shown.
//!
//! Three prompts, and each is load-bearing:
//!
//! 1. **Grant.** One `Always allow` on an edit; the file it asked about is written.
//! 2. **Control.** A *new session* asks for another file. It must be written **with no permission
//!    frame at all** — that is what "the engine stopped asking" means, and without it turn 3's
//!    frame would be unattributable.
//! 3. **Measurement.** The grant is revoked through `permission_grants::remove` — the same
//!    function `agent_permission_grant_revoke` calls — and a third session asks again. The frame
//!    must come back, and the file must still be written once it is answered.
//!
//! **Both live halves are imported, never retyped**: the launch gets its port from
//! `permission_grants::pin_http` with the adapter's own `HTTP_API`, and the removal goes through
//! the shipped client. A test that built its own URL would go green while the shipped one was
//! wrong, which is precisely the failure it exists to catch.
//!
//! **A run that never reaches the question is INCONCLUSIVE, not a pass**, for the reason the
//! sibling files give: a paid run may not end green without having asked the engine anything, so
//! every step asserts rather than printing.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    PermissionOptionKind, RequestPermissionOutcome, RequestPermissionResponse,
    SelectedPermissionOutcome, ToolKind,
};

use nekowite_lib::agent_runtime::adapters;
use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::permission_grants::{self, EngineHttp, GrantsReadout};
use nekowite_lib::agent_runtime::profile::shipped_permission_block;
use nekowite_lib::agent_runtime::{
    env_pairs, isolated_profile_env, AgentEventEnvelope, AgentEventKind, AgentIdentity,
    AgentRuntime, EngineConnection, EngineLaunch, RuntimeEvent, VaultFiles,
};

/// How long one turn gets. Three turns run in this file, so it is the sibling's bound rather than
/// a wider one: a run that needs longer than this is a run nobody would have waited for either.
const RUN_PATIENCE: Duration = Duration::from_secs(240);

/// The model this run is pinned to, by value like the sibling files. The pin is asserted before any
/// prompt is sent: an ACP session with no model set falls back to an engine-hosted free model, and
/// a run against a provider this test did not choose measures the wrong thing while paying for it.
const TEST_MODEL: &str = "iapp/deepseek-v4-flash";

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

/// A scratch directory inside the repository, removed when the test passes. A panicking test keeps
/// it, because while it is panicking the directory *is* the evidence.
struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(label: &str) -> Self {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp-permission-grants")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        Self {
            path: fs::canonicalize(&dir).expect("a real path"),
        }
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

// ---------------------------------------------------------------------------
// The app's own file path
// ---------------------------------------------------------------------------

/// The app's own read and write path, forwarded unchanged, so a write the engine delegates is
/// performed by `save_store` here exactly as it is in the product.
struct RealVault {
    delegated: Arc<Mutex<Vec<String>>>,
}

/// No window is registered for any vault, so a read is refused rather than served from disk.
struct NoWindow;

impl LiveNoteWindows for NoWindow {
    fn ask(&self, _question: &LiveNoteQuestion) -> usize {
        0
    }
}

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
        self.delegated.lock().unwrap().push(path.to_string());
        nekowite_lib::storage::save_store::write_file(vault_root, path, content, None)
    }
}

fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: adapters::opencode::AGENT_ID.to_string(),
        profile_id: "permission-grants".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-1".to_string(),
    }
}

/// The pinned engine, or the reason there is no live run.
fn artifact() -> Option<PathBuf> {
    let artifact =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/opencode-x86_64-unknown-linux-gnu");
    if !artifact.is_file() {
        eprintln!(
            "SKIP: {} is absent; run scripts/fetch-opencode-linux.sh",
            artifact.display()
        );
        return None;
    }
    Some(artifact)
}

/// What a *model-driven* run needs, or the reason there will not be one.
///
/// The credential is the whole of what a prompt costs, and the skip is loud for the reason
/// `scripts/verify-acp-live.sh` makes its own check fatal: a test that quietly passes without
/// having asked the engine anything is worse than a red one, because it looks like evidence. The
/// evaluation-driven test below runs without it — but it is not this test, and this file must not
/// let a reader mistake one for the other.
fn live_run_inputs() -> Option<(PathBuf, String)> {
    let artifact = artifact()?;
    // The key reaches this process through the environment and nowhere else: never `argv` (world
    // readable in `/proc`), never a config file, never a log line.
    match std::env::var("NWK_TEST_KEY") {
        Ok(key) if !key.trim().is_empty() => Some((artifact, key)),
        _ => {
            eprintln!(
                "SKIP: NWK_TEST_KEY is not set; it is read from /tmp/nwk-test-key the way \
                 scripts/verify-acp-live.sh does it. The model-driven measurement did NOT run."
            );
            None
        }
    }
}

/// The profile the engine is given: the credential reference the sibling files measured, and the
/// permission block this app ships, taken from the library rather than written out here.
fn profile_config() -> String {
    let provider = r#""provider": {
    "iapp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "iApp Gateway (test)",
      "options": {
        "baseURL": "https://ai.iapp.dpdns.org/v1",
        "apiKey": "{env:NWK_TEST_KEY}"
      },
      "models": {
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash" }
      }
    }
  }"#;
    format!(
        "{{\n  {provider},\n  \"permission\": {}\n}}\n",
        shipped_permission_block()
    )
}

// ---------------------------------------------------------------------------
// One engine, on the shipped launch path
// ---------------------------------------------------------------------------

struct Engine {
    /// Kept alive until the test is over: a panicking test must leave the scratch directory behind.
    root: TempRoot,
    profile: PathBuf,
    runtime: AgentRuntime,
    events: nekowite_lib::agent_runtime::AgentRuntimeEvents,
    vault: PathBuf,
    /// The engine's own HTTP surface, as the shipped launch gave it to this session.
    http: EngineHttp,
    _delegated: Arc<Mutex<Vec<String>>>,
}

impl Engine {
    /// One engine on the shipped launch path, with a credential when there is one.
    ///
    /// The credential only ever reaches the engine's environment; the model-driven test is the only
    /// caller that needs it, and a run that sends no prompt is a run that makes no provider call —
    /// so the evaluation-driven test starts the same engine through the same function with `None`.
    async fn launch(label: &str, artifact: PathBuf, key: Option<String>) -> Option<Self> {
        let root = TempRoot::new(label);
        let vault = root.path.join("vault");
        fs::create_dir_all(&vault).expect("the session root");

        let profile = root.path.join("profile");
        let config_dir = profile.join("XDG_CONFIG_HOME/opencode");
        fs::create_dir_all(&config_dir).expect("profile config dir");
        fs::write(config_dir.join("opencode.json"), profile_config()).expect("profile config");

        let mut env = isolated_profile_env(&profile);
        if let Some(key) = key {
            env.push(("NWK_TEST_KEY".to_string(), key));
        }
        let mut launch = EngineLaunch {
            program: artifact,
            args: adapters::opencode::LAUNCH_ARGS
                .iter()
                .map(|arg| arg.to_string())
                .collect(),
            // A `Secret` from here on, so the derived `Debug` on `EngineLaunch` cannot print it.
            env: env_pairs(env),
            ca_bundle: None,
        };
        // The shipped port pinning, not a copy of it: the routes below must address the process
        // this launch starts, and the flag that makes that possible is the adapter's — asked for
        // through the seam, the way `registry::start` asks for it.
        let api =
            adapters::lookup(adapters::opencode::ADAPTER_ID).and_then(|adapter| adapter.http_api());
        let http = permission_grants::pin_http(&mut launch, api)
            .expect("the bundled adapter declares an HTTP surface");

        let (connection, engine_events) = EngineConnection::connect(&launch)
            .await
            .expect("the real engine should start with a pinned port");
        let delegated = Arc::new(Mutex::new(Vec::new()));
        let (runtime, events) = AgentRuntime::new(
            identity(),
            connection,
            engine_events,
            Arc::new(RealVault {
                delegated: Arc::clone(&delegated),
            }),
            LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
        );
        runtime.initialize().await.expect("the engine initializes");
        Some(Self {
            root,
            profile,
            runtime,
            events,
            vault,
            http,
            _delegated: delegated,
        })
    }

    /// Starts the engine where a credential is available, or says why there is no run.
    async fn start(label: &str) -> Option<Self> {
        let (artifact, key) = live_run_inputs()?;
        Self::launch(label, artifact, Some(key)).await
    }

    /// The same engine, started to be *asked* rather than prompted: no credential, no model.
    async fn start_unprompted(label: &str) -> Option<Self> {
        Self::launch(label, artifact()?, None).await
    }

    /// Opens a session and pins the model, refusing rather than hoping.
    async fn session(&self) -> String {
        let session = self
            .runtime
            .open_session(&self.vault)
            .await
            .expect("session/new succeeds with no credentials configured");
        let options = self
            .runtime
            .set_config_option(&session.session_id, "model", TEST_MODEL)
            .await
            .expect("session/set_config_option");
        let selected = selected_model(&options);
        assert!(
            selected
                .as_deref()
                .is_some_and(|model| model.starts_with("iapp/")),
            "REFUSING TO RUN THIS SESSION: the engine reports {selected:?} as the selected model \
             after {TEST_MODEL} was set, which is not a model on this test's gateway. An ACP \
             session with no model set silently falls back to an opencode-hosted free model, and a \
             run against a provider this test did not choose measures the wrong thing while paying \
             for it. Nothing has been prompted. The engine's option list was: {options}",
        );
        session.session_id.to_string()
    }

    fn engine_log(&self) -> PathBuf {
        self.profile.join("XDG_DATA_HOME/opencode/log/opencode.log")
    }

    /// What the engine holds right now, through the shipped client.
    async fn grants(&self) -> Vec<nekowite_lib::agent_runtime::SavedGrant> {
        match permission_grants::list(Some(self.http)).await {
            Ok(GrantsReadout::Listed { grants }) => grants,
            other => panic!("the engine must answer its saved permissions, and answered {other:?}"),
        }
    }
}

/// What the host answers when the engine asks about a write.
enum Answer {
    /// Refuse every frame that offers a refusal.
    Reject,
    /// Allow the first frame once; refuse anything after it.
    AllowOnceThenReject,
    /// Allow the first frame always; refuse anything after it.
    AllowAlwaysThenReject,
}

/// One prompt, and what the engine did about it.
struct Turn {
    target: PathBuf,
    exists: bool,
    /// One line per permission frame: the tool kind, the options offered, and what was sent back.
    frames: Vec<String>,
    ended: Option<String>,
}

/// Sends one prompt and answers every frame the engine raises about it.
async fn run_turn(engine: &mut Engine, session: &str, name: &str, answer: &Answer) -> Turn {
    let target = engine.root.path.join(name);
    // Naming the tool is deliberate: the experiment is about a *file write*, so a run that reached
    // for a shell instead would be measured as the other thing it is — and its frame answered too.
    let prompt = format!(
        "Create the file {} containing exactly HELLO. Use your file writing tool, not a shell \
         command.",
        target.display()
    );
    let deadline = tokio::time::Instant::now() + RUN_PATIENCE;
    let mut frames = Vec::new();
    let mut answered = false;
    let mut ended = None;

    engine
        .runtime
        .prompt(session, &prompt)
        .expect("the session accepts a prompt");

    loop {
        let event = match tokio::time::timeout_at(deadline, engine.events.next()).await {
            Ok(event) => event,
            Err(_) => break,
        };
        let Some(event) = event else { break };
        match event {
            RuntimeEvent::Permission(permission) => {
                let kind = permission.request.tool_call.fields.kind;
                let offered: Vec<String> = permission
                    .request
                    .options
                    .iter()
                    .map(|option| format!("{:?}", option.kind))
                    .collect();
                let pick = select(&permission.request.options, &kind, answer, answered);
                frames.push(format!(
                    "{kind:?} offered {offered:?} -> {}",
                    pick.as_ref().map_or(
                        "Cancelled (nothing this run will approve)".to_string(),
                        |option| format!("{:?}", option.kind)
                    )
                ));
                let outcome = match &pick {
                    Some(option) => {
                        answered = true;
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                            option.option_id.clone(),
                        ))
                    }
                    // What the product sends when it cannot answer (`permissions::revoke`), and
                    // the only other outcome the protocol has.
                    None => RequestPermissionOutcome::Cancelled,
                };
                let _ = permission
                    .responder
                    .respond(RequestPermissionResponse::new(outcome));
            }
            RuntimeEvent::Event(envelope) => {
                eprintln!("event seq={} {}", envelope.sequence, summary(&envelope));
                if matches!(
                    envelope.kind,
                    AgentEventKind::RunFinished | AgentEventKind::RunFailed
                ) {
                    ended = Some(format!("{:?}", envelope.kind));
                    break;
                }
            }
        }
    }

    // The turn boundary is what this waits for, so a file asserted absent here is a file the engine
    // had its chance to write.
    tokio::time::sleep(Duration::from_millis(500)).await;
    Turn {
        exists: target.exists(),
        target,
        frames,
        ended,
    }
}

/// The option this run sends for one frame.
///
/// Never a guess: an id the engine did not offer cannot be answered with, and an answer this run
/// has already spent its one permission on is refused rather than repeated.
fn select(
    options: &[agent_client_protocol::schema::v1::PermissionOption],
    kind: &Option<ToolKind>,
    answer: &Answer,
    already_answered: bool,
) -> Option<agent_client_protocol::schema::v1::PermissionOption> {
    let wanted = match (answer, already_answered) {
        (_, true) => PermissionOptionKind::RejectOnce,
        (Answer::Reject, _) => PermissionOptionKind::RejectOnce,
        (Answer::AllowOnceThenReject, false) => PermissionOptionKind::AllowOnce,
        (Answer::AllowAlwaysThenReject, false) => PermissionOptionKind::AllowAlways,
    };
    let _ = kind;
    options.iter().find(|option| option.kind == wanted).cloned()
}

/// One line per event, bounded: the engine's model catalogue and command list are tens of kilobytes
/// each, and the shape is the evidence rather than the payload.
fn summary(event: &AgentEventEnvelope) -> String {
    event.payload.to_string().chars().take(300).collect()
}

/// The value the engine reports as selected for `model`.
fn selected_model(options: &serde_json::Value) -> Option<String> {
    options.as_array()?.iter().find_map(|option| {
        (option.get("id")?.as_str()? == "model")
            .then(|| option.get("currentValue")?.as_str().map(str::to_string))
            .flatten()
    })
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/// Grant one lasting permission, revoke it through the shipped path, and watch the engine ask
/// again. Three prompts; see the module comment for what each one buys.
#[tokio::test]
async fn a_grant_that_is_revoked_stops_silencing_the_engine() {
    let Some(mut engine) = Engine::start("revoke").await else {
        return;
    };

    // 1. The grant. `Always allow` is what writes the row this whole surface is about.
    let first_session = engine.session().await;
    let granted = run_turn(
        &mut engine,
        &first_session,
        "granted.txt",
        &Answer::AllowAlwaysThenReject,
    )
    .await;
    assert!(
        granted.exists,
        "the granted write must land: {:?}",
        granted.frames
    );
    assert_eq!(
        granted.frames.len(),
        1,
        "the engine must have asked once about the granted write: {:?}",
        granted.frames
    );
    assert!(
        granted.ended.as_deref() == Some("RunFinished"),
        "the granted turn must finish: {:?}",
        granted.ended
    );

    // The engine's own record, not this app's belief about it: one blanket rule for `edit`.
    let held = engine.grants().await;
    eprintln!("saved permissions after the grant: {held:?}");
    assert_eq!(
        held.len(),
        1,
        "one `Always allow` writes exactly one row: {held:?}"
    );
    assert_eq!(held[0].action, "edit");
    assert_eq!(
        held[0].resource, "*",
        "the edit tool saves a blanket rule for the project, which is what the copy on the prompt \
         tells the user it does"
    );
    let grant_id = held[0].id.clone();

    // 2. The control. A *new* session, and the engine is asked nothing at all — which is what the
    //    grant costs, and without this turn the frame in step 3 would be unattributable.
    let silenced_session = engine.session().await;
    let silenced = run_turn(
        &mut engine,
        &silenced_session,
        "silenced.txt",
        &Answer::Reject,
    )
    .await;
    assert!(
        silenced.frames.is_empty(),
        "the whole point of the grant is that the engine asks nothing afterwards, and it asked: \
         {:?}",
        silenced.frames
    );
    assert!(
        silenced.exists,
        "nothing was asked, so nothing could refuse: the write happens unasked"
    );

    // 3. The measurement. The removal goes through the same function the command calls.
    let after = permission_grants::remove(Some(engine.http), &grant_id)
        .await
        .expect("the engine answers a removal");
    eprintln!("saved permissions after the revoke: {after:?}");
    assert_eq!(
        after,
        GrantsReadout::Listed { grants: Vec::new() },
        "the row the page would have drawn is gone from the engine's own list"
    );

    let after_session = engine.session().await;
    let asked_again = run_turn(
        &mut engine,
        &after_session,
        "asked-again.txt",
        &Answer::AllowOnceThenReject,
    )
    .await;
    assert!(
        !asked_again.frames.is_empty(),
        "revoking must put the question back: the engine raised no frame, so the app offered a \
         control that removed nothing. ended={:?}",
        asked_again.ended
    );
    assert!(
        asked_again.frames[0].starts_with("Some(Edit)"),
        "the frame that came back is the edit the grant covered: {:?}",
        asked_again.frames
    );
    assert!(
        asked_again.exists,
        "and answering it once still lets the write through: {:?}",
        asked_again.frames
    );

    // The engine's own log, as corroboration and never as a verdict: it names the permission it
    // evaluated for all three turns' targets.
    let log = fs::read_to_string(engine.engine_log()).unwrap_or_default();
    for target in [&granted.target, &silenced.target, &asked_again.target] {
        eprintln!(
            "engine log mentions {}: {}",
            target.display(),
            log.contains(&target.to_string_lossy().into_owned())
        );
    }
}

// ---------------------------------------------------------------------------
// The same question, asked of the engine's own evaluation
// ---------------------------------------------------------------------------

/// One call to an engine route, as this experiment's stimulus.
///
/// The shipped read/remove path is `permission_grants`, and this file never re-implements it. What
/// is written here is the *other* direction — the call the engine's own `edit` tool makes before it
/// writes (`session.permission.create`), and the answer it records (`session.permission.reply`).
/// They are the experiment rather than the product, which is why they live in the test: a product
/// path that created permission requests would be a second way to approve something.
async fn engine_call(
    http: EngineHttp,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> serde_json::Value {
    let client = reqwest::Client::builder().build().expect("an HTTP client");
    let mut request = client
        .request(method, format!("http://127.0.0.1:{}{path}", http.port))
        .timeout(Duration::from_secs(15));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .expect("the engine answers its own route");
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    assert!(
        status.is_success(),
        "the engine refused {path} with {status}: {text}"
    );
    if text.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text).expect("the engine answers JSON")
    }
}

/// What the engine answers when asked whether it will ask: `allow` / `ask` / `deny`.
async fn effect_of(engine: &Engine, session: &str, target: &Path) -> String {
    let answer = engine_call(
        engine.http,
        reqwest::Method::POST,
        &format!("/api/session/{session}/permission"),
        Some(serde_json::json!({
            "action": "edit",
            "resources": [target.to_string_lossy()],
            "save": ["*"],
        })),
    )
    .await;
    let effect = answer["data"]["effect"]
        .as_str()
        .unwrap_or_else(|| panic!("the engine must report an effect: {answer}"))
        .to_string();
    // The request the evaluation produced, which is the row a reply would be addressed to. Kept
    // beside the effect because for `ask` they are the two halves of the same answer.
    if effect == "ask" {
        assert!(
            answer["data"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("per")),
            "an `ask` names the request it raised: {answer}"
        );
    }
    effect
}

/// Grant one lasting permission, revoke it through the shipped path, and watch the engine's own
/// evaluation go back to asking. **Zero prompts and no credential.**
///
/// **What this measures, exactly.** The engine's `edit` tool calls `session.permission.create`
/// before it writes and raises a frame when the answer is `ask` — so the effect *is* the question
/// "will the user be asked", asked of the authority that decides it. What it does not measure is
/// the model choosing to use the tool, which is the part the prompt-driven test above adds and
/// this one cannot.
#[tokio::test]
async fn the_engines_own_evaluation_stops_silencing_after_the_revoke() {
    let Some(engine) = Engine::start_unprompted("evaluation").await else {
        return;
    };
    let session = engine
        .runtime
        .open_session(&engine.vault)
        .await
        .expect("session/new succeeds")
        .session_id
        .to_string();
    let target = engine.root.path.join("evaluated.txt");

    // 1. Nothing has been granted, and the shipped rules make the engine ask.
    assert_eq!(
        effect_of(&engine, &session, &target).await,
        "ask",
        "the shipped permission block must make the engine ask about an edit"
    );

    // 2. The answer a user gives with `Always allow`, recorded by the engine's own reply route.
    let raised = engine_call(
        engine.http,
        reqwest::Method::POST,
        &format!("/api/session/{session}/permission"),
        Some(serde_json::json!({
            "action": "edit",
            "resources": [target.to_string_lossy()],
            "save": ["*"],
        })),
    )
    .await;
    let request_id = raised["data"]["id"]
        .as_str()
        .expect("an `ask` names its request")
        .to_string();
    engine_call(
        engine.http,
        reqwest::Method::POST,
        &format!("/api/session/{session}/permission/{request_id}/reply"),
        Some(serde_json::json!({ "reply": "always" })),
    )
    .await;

    // 3. The engine wrote it down, and the shipped client is what reads it back.
    let held = engine.grants().await;
    eprintln!("saved permissions after the grant: {held:?}");
    assert_eq!(held.len(), 1, "one `always` writes one row: {held:?}");
    assert_eq!(held[0].action, "edit");
    assert_eq!(
        held[0].resource, "*",
        "the edit tool saves a blanket rule for the project, which is what the prompt's own copy \
         tells the user it does"
    );
    // The scope, read from the engine rather than assumed: a saved permission is keyed by the
    // project the session is in, and the engine's project for a folder with no version control is
    // `global` while one inside a repository is a hash of it. Whichever this checkout gives, the
    // grant must be keyed by *the session's own* project — that is what makes "the engine stops
    // asking" true only for the notes it covers.
    let session_project = engine_call(
        engine.http,
        reqwest::Method::GET,
        &format!("/api/session/{session}"),
        None,
    )
    .await["data"]["projectID"]
        .as_str()
        .unwrap_or_else(|| panic!("a session names the project it is in"))
        .to_string();
    assert_eq!(
        held[0].project_id, session_project,
        "a grant covers the project it was given in, and the page draws that key"
    );
    let grant_id = held[0].id.clone();

    // 4. The control: with the grant in force the engine no longer asks at all. Without this,
    //    step 6's `ask` would be unattributable — it could have been the grant never applying.
    assert_eq!(
        effect_of(&engine, &session, &target).await,
        "allow",
        "the whole cost of `Always allow` is that the question stops being asked"
    );

    // 5. The removal, through the function `agent_permission_grant_revoke` calls.
    let after = permission_grants::remove(Some(engine.http), &grant_id)
        .await
        .expect("the engine answers a removal");
    eprintln!("saved permissions after the revoke: {after:?}");
    assert_eq!(
        after,
        GrantsReadout::Listed { grants: Vec::new() },
        "the row the page would have drawn is gone from the engine's own list"
    );

    // 6. And the question is back. This is the measurement: the same evaluation, on the same
    //    session, in the same process, with nothing restarted — differing only in the revoke.
    assert_eq!(
        effect_of(&engine, &session, &target).await,
        "ask",
        "a revoke that did not put the question back would be a control the app offers and the \
         engine ignores"
    );
}
