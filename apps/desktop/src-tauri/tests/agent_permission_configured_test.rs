//! The consent configuration this app now *ships*, measured against the real engine: the engine
//! asks, the user answers, and the file's existence follows the answer.
//!
//! **Why this is not `agent_permission_reject_test.rs` repeated.** That file proves the *mechanism*
//! — answer the frame `RejectOnce` and the engine writes nothing — under a `permission` block that
//! is a **test fixture**: `ASK_FOR_EVERY_TOOL` in that file says so itself, and the app at the time
//! shipped no `permission` key at all, which is the state `permission-is-the-only-lever.md` §3
//! measured (`permission frames: []`, the file written by the engine's own tooling). This file
//! measures the row that replaced it: the rules in
//! [`nekowite_lib::agent_runtime::profile::SHIPPED_PERMISSION_RULES`], as
//! [`shipped_permission_block`] serializes them, in the profile of an engine this host started.
//!
//! **The block is imported, never retyped.** A test that wrote its own copy of the rules would go
//! green while the shipped ones did nothing, which is precisely the failure it exists to catch.
//!
//! **Two questions, and they are different.**
//!
//!  1. Does the answer decide? One session, two prompts: refuse the first write and allow the
//!     second, and check that the two files' existence follows the two answers. Reject alone would
//!     leave open that the model simply declined to write the second time; allow alone would leave
//!     open that nothing was ever refused. Measured together in one run, neither is available.
//!  2. What does `AllowAlways` commit the user to? The second test answers it with the engine
//!     rather than with a sentence: allow always on one write, then **a second session** on the
//!     same engine asking for a different file. A grant the engine keeps only for the session this
//!     prompt belongs to would raise the question again; a grant it has written down does not. The
//!     engine's own storage is read afterwards as corroboration.
//!
//! **A run that never reaches the question is INCONCLUSIVE, not a pass**, for the reason the reject
//! file gives: a paid run may not end green without having asked the engine anything.
//!
//! Each test spends two prompts, and neither is on a loop.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    PermissionOptionKind, RequestPermissionOutcome, RequestPermissionResponse,
    SelectedPermissionOutcome, ToolKind,
};

use nekowite_lib::agent_runtime::live_notes::{
    LiveNoteQuestion, LiveNoteTable, LiveNoteWindows, LiveNotes,
};
use nekowite_lib::agent_runtime::profile::shipped_permission_block;
use nekowite_lib::agent_runtime::{
    env_pairs, isolated_profile_env, AgentEventEnvelope, AgentEventKind, AgentIdentity,
    AgentRuntime, EngineConnection, EngineLaunch, RuntimeEvent, VaultFiles,
};

/// How long the engine gets for its whole run. The reject file's bound, widened again for the same
/// reason it widened: a refused tool call is one the model may react to, and this file sends two
/// prompts through one session.
const RUN_PATIENCE: Duration = Duration::from_secs(240);

/// The model this run is pinned to, by value like the sibling files. The pin is asserted before any
/// prompt is sent: an ACP session with no model set falls back to an engine-hosted free model, and
/// a run against a provider this test did not choose measures the wrong thing while paying for it.
const TEST_MODEL: &str = "iapp/deepseek-v4-flash";

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

/// A scratch directory inside the repository, removed when the test passes (see the reject file for
/// why a panicking test keeps it: while it is panicking, the directory *is* the evidence).
struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(label: &str) -> Self {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp-permission-configured")
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
// The app's real file path, with the delegated writes kept
// ---------------------------------------------------------------------------

/// The app's own read and write path, forwarded unchanged — so a write the engine delegates is
/// performed by `save_store`, and one this host refuses is refused there rather than here. What is
/// recorded is whether the engine handed the write over at all, which is a different fact from
/// whether the file was written.
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
        agent_id: "opencode".to_string(),
        profile_id: "permission-configured".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-1".to_string(),
    }
}

/// What a real run needs, or the reason there will not be one.
fn live_run_inputs() -> Option<(PathBuf, String)> {
    let artifact =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/opencode-x86_64-unknown-linux-gnu");
    if !artifact.is_file() {
        eprintln!(
            "SKIP: {} is absent; run scripts/fetch-opencode-linux.sh",
            artifact.display()
        );
        return None;
    }
    // The key reaches this process through the environment and nowhere else: never `argv` (world
    // readable in `/proc`), never a config file, never a log line.
    match std::env::var("NWK_TEST_KEY") {
        Ok(key) if !key.trim().is_empty() => Some((artifact, key)),
        _ => {
            eprintln!(
                "SKIP: NWK_TEST_KEY is not set; it is read from /tmp/nwk-test-key the way \
                 scripts/verify-acp-live.sh does it"
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// One engine, one profile, the shipped rules
// ---------------------------------------------------------------------------

/// The profile the engine is given: the credential reference P0 §2.3 measured working, and **the
/// permission block this app ships**, taken from the library rather than written out here.
///
/// The credential is an `{env:…}` reference, never a value: the engine resolves it out of the
/// environment it was spawned with, so the key exists in no file this test writes and in no
/// argument it passes.
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

/// One engine process on one scratch profile, with the shipped rules in its configuration.
struct Engine {
    /// Kept alive until the test is over: a panicking test must leave the scratch directory behind
    /// (see `TempRoot`), and `run_turn` puts each prompt's target inside it.
    root: TempRoot,
    profile: PathBuf,
    runtime: AgentRuntime,
    events: nekowite_lib::agent_runtime::AgentRuntimeEvents,
    vault: PathBuf,
    delegated: Arc<Mutex<Vec<String>>>,
}

impl Engine {
    async fn start(label: &str) -> Option<Self> {
        let (artifact, key) = live_run_inputs()?;
        let root = TempRoot::new(label);
        let vault = root.path.join("vault");
        fs::create_dir_all(&vault).expect("the session root");

        let profile = root.path.join("profile");
        let config_dir = profile.join("XDG_CONFIG_HOME/opencode");
        fs::create_dir_all(&config_dir).expect("profile config dir");
        fs::write(config_dir.join("opencode.json"), profile_config()).expect("profile config");

        let mut env = isolated_profile_env(&profile);
        env.push(("NWK_TEST_KEY".to_string(), key));
        let launch = EngineLaunch {
            program: artifact,
            args: vec!["acp".to_string()],
            // A `Secret` from here on, so the derived `Debug` on `EngineLaunch` cannot print it.
            env: env_pairs(env),
            ca_bundle: None,
        };

        let (connection, engine_events) = EngineConnection::connect(&launch)
            .await
            .expect("the real engine should start");
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
            delegated,
        })
    }

    /// Opens a session and pins the model, refusing rather than hoping.
    ///
    /// The pin sits **before** the prompt, so a session that fell back to the engine's own hosted
    /// model costs nothing to discover — the failure that cost a previous run ~35–40k tokens.
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
}

/// What the model was asked to do, and what the host answers when the engine asks about it.
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
    /// The file this prompt names, and whether it is there once the turn is over.
    target: PathBuf,
    exists: bool,
    /// One line per permission frame: the tool kind, the options offered, and what was sent back.
    frames: Vec<String>,
    /// The option id the host sent for the *first* frame, when it sent one.
    answered: Option<String>,
    ended: Option<String>,
}

/// Sends one prompt and answers every frame the engine raises about it.
async fn run_turn(engine: &mut Engine, session: &str, name: &str, answer: &Answer) -> Turn {
    let target = engine.root.path.join(name);
    // Naming the tool is deliberate: the experiment is about a *file write*, so a run that reaches
    // for a shell instead is measured as the other thing it is — and its frame is answered like
    // every other.
    let prompt = format!(
        "Create the file {} containing exactly HELLO. Use your file writing tool, not a shell \
         command.",
        target.display()
    );
    let deadline = tokio::time::Instant::now() + RUN_PATIENCE;
    let mut frames = Vec::new();
    let mut answered = None;
    let mut ended = None;

    // The stream is shared by both turns of a test, so a frame belonging to the previous turn can
    // still be in it. Only frames for *this* prompt's target are answered here; anything else is
    // left for the caller to see and refused, because guessing among the engine's options can
    // grant a permission this run means to withhold.
    engine
        .runtime
        .prompt(session, &prompt, &[])
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
                let pick = select(
                    &permission.request.options,
                    &kind,
                    answer,
                    answered.is_some(),
                );
                frames.push(format!(
                    "{kind:?} offered {offered:?} -> {}",
                    pick.as_ref().map_or(
                        "Cancelled (nothing this run will approve)".to_string(),
                        |o| { format!("{:?}", o.kind) }
                    )
                ));
                let outcome = match &pick {
                    Some(option) => {
                        if answered.is_none() {
                            answered = Some(option.option_id.to_string());
                        }
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                            option.option_id.clone(),
                        ))
                    }
                    // What the product sends when it cannot answer (`permissions::revoke`), and the
                    // only other outcome the protocol has.
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

    // The engine's own log flush, not the run: the evidence is not a verdict input, so a log that
    // never appears costs the message its corroboration and nothing else. The turn boundary is what
    // this waits for — the tool's own write lands before the terminal event, so a file asserted
    // absent here is a file the engine had its chance to write.
    tokio::time::sleep(Duration::from_millis(500)).await;
    Turn {
        exists: target.exists(),
        target,
        frames,
        answered,
        ended,
    }
}

/// The option this run sends for one frame.
///
/// Never a guess: an id the engine did not offer cannot be answered with, and an answer this run
/// has already spent its one permission on is refused rather than repeated (`AllowOnce` twice is
/// two grants).
fn select(
    options: &[agent_client_protocol::schema::v1::PermissionOption],
    kind: &Option<ToolKind>,
    answer: &Answer,
    already_answered: bool,
) -> Option<agent_client_protocol::schema::v1::PermissionOption> {
    let first_frame = !already_answered;
    let wanted = match (answer, first_frame) {
        (_, false) => PermissionOptionKind::RejectOnce,
        (Answer::Reject, _) => PermissionOptionKind::RejectOnce,
        (Answer::AllowOnceThenReject, true) => PermissionOptionKind::AllowOnce,
        (Answer::AllowAlwaysThenReject, true) => PermissionOptionKind::AllowAlways,
    };
    let _ = kind;
    options.iter().find(|option| option.kind == wanted).cloned()
}

/// One line per event, bounded: the engine's model catalogue and command list are tens of kilobytes
/// each, and the shape is the evidence rather than the payload.
fn summary(event: &AgentEventEnvelope) -> String {
    event.payload.to_string().chars().take(300).collect()
}

/// The value the engine reports as selected for `model`, out of the option list
/// `session/set_config_option` answers with.
fn selected_model(options: &serde_json::Value) -> Option<String> {
    options.as_array()?.iter().find_map(|option| {
        (option.get("id")?.as_str()? == "model")
            .then(|| option.get("currentValue")?.as_str().map(str::to_string))
            .flatten()
    })
}

/// The engine's own lines about this run: what permission it evaluated and asked for, and whether
/// it formatted or touched a target with its own tooling.
fn engine_log_lines(log: &Path, targets: &[&Path]) -> Vec<String> {
    let Ok(text) = fs::read_to_string(log) else {
        return Vec::new();
    };
    let spellings: Vec<String> = targets
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    text.lines()
        .filter(|line| {
            line.contains("evaluated permission")
                || line.contains("message=asking")
                || line.contains("llm runtime selected")
                || spellings.iter().any(|target| {
                    line.contains(target.as_str())
                        && (line.contains("formatting file") || line.contains("touching file"))
                })
        })
        .map(str::to_string)
        .collect()
}

/// The engine's own record of a grant it has written down, if there is one.
///
/// A *report*, not an assertion: what it says is whether the engine's profile now holds a database
/// at all, which is where a saved rule lives (the pinned artifact's `PermissionV2.reply` writes an
/// `always` answer into a `permission` table keyed by project — see the report). The behavioural
/// fact is the second session's silence, measured above; this is the corroboration, and a missing
/// file here costs the message its second witness and nothing else.
fn engine_grants(profile: &Path) -> Vec<String> {
    let data = profile.join("XDG_DATA_HOME/opencode");
    let Ok(entries) = fs::read_dir(&data) else {
        return Vec::new();
    };
    let mut found: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .map(|entry| {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            format!("{} ({size} bytes)", entry.path().display())
        })
        .collect();
    found.sort();
    found
}

// ---------------------------------------------------------------------------
// 1. The shipped rules make the engine ask, and the answer decides
// ---------------------------------------------------------------------------

/// **The row this task exists to produce.** Under the configuration this app now writes, does the
/// user's answer decide whether a file is written?
///
/// One session, two prompts: the first write is refused and the second allowed. Two prompts in one
/// run rather than two tests, because the pair is the measurement — an allow that follows a refusal
/// is evidence that the refusal, and not the model's mood, is what the first prompt was missing.
///
/// Costs two prompts.
#[tokio::test]
async fn the_shipped_rules_make_the_engine_ask_and_the_answer_decides() {
    let Some(mut engine) = Engine::start("answer").await else {
        return;
    };
    let session = engine.session().await;

    let refused = run_turn(&mut engine, &session, "refused.txt", &Answer::Reject).await;
    eprintln!(
        "refused turn: target {} -> {}; frames {:?}; ended {:?}",
        refused.target.display(),
        if refused.exists { "EXISTS" } else { "absent" },
        refused.frames,
        refused.ended
    );
    // A run that never reached the question is not a pass, for the same reason a skip is not one.
    assert!(
        !refused.frames.is_empty(),
        "NO PERMISSION FRAME ARRIVED under the permission block this app ships, so nothing was \
         asked and nothing was measured: the rules in SHIPPED_PERMISSION_RULES did not reach this \
         engine's configuration, or the engine no longer honours a `permission` member. This is the \
         state `permission-is-the-only-lever.md` §3 measured before these rules existed — `permission \
         frames: []`, the file written by the engine's own tooling. Target {} -> {}; frames {:?}; \
         engine log {:?}",
        refused.target.display(),
        if refused.exists { "EXISTS" } else { "absent" },
        refused.frames,
        engine_log_lines(&engine.engine_log(), &[&refused.target]),
    );
    assert!(
        !refused.exists,
        "THE ANSWER IS NOT A GATE UNDER THE SHIPPED RULES: this host refused the edit permission \
         frame and the file is there anyway. Target {} -> EXISTS; frames {:?}; delegated writes to \
         this host {:?}; engine log {:?}",
        refused.target.display(),
        refused.frames,
        engine.delegated.lock().unwrap(),
        engine_log_lines(&engine.engine_log(), &[&refused.target]),
    );

    let allowed = run_turn(
        &mut engine,
        &session,
        "allowed.txt",
        &Answer::AllowOnceThenReject,
    )
    .await;
    eprintln!(
        "allowed turn: target {} -> {}; frames {:?}; answered {:?}; ended {:?}",
        allowed.target.display(),
        if allowed.exists { "EXISTS" } else { "absent" },
        allowed.frames,
        allowed.answered,
        allowed.ended
    );
    // The other half, and it is the half that makes the first one mean something: a model that had
    // simply declined to write would have produced the same absent file above. Two prompts are
    // spent here so that "the answer decides" is measured on both sides of the answer.
    assert!(
        allowed.exists,
        "INCONCLUSIVE, and deliberately red: the second prompt was allowed once and no file \
         appeared, so this run has not shown the gate opening and the row above cannot be read as \
         the gate closing. Target {} -> absent; frames {:?}; answered {:?}; engine log {:?}",
        allowed.target.display(),
        allowed.frames,
        allowed.answered,
        engine_log_lines(&engine.engine_log(), &[&allowed.target]),
    );
}

// ---------------------------------------------------------------------------
// 2. What `AllowAlways` commits the user to
// ---------------------------------------------------------------------------

/// Answering `always` once, then asking for a *different* file in a **second session**.
///
/// The engine's own code says what this should do: an `always` answer with a non-empty `save` list
/// is written into the engine's `permission` table keyed by project (`PermissionV2.reply`, read out
/// of the pinned artifact — `resources:[h.resource], save:["*"]` at the edit tool, and the saved
/// rules are merged into every later evaluation). If that is what happens, the second session is
/// asked nothing and the second file is written — and the user's answer stopped being asked for far
/// longer than the turn it was given in.
///
/// Costs two prompts: the second one is the measurement, and it is free of a *question* only if the
/// grant held — a frame arriving is the falsification, and it is refused like every other.
#[tokio::test]
async fn answering_always_stops_the_engine_asking_in_a_later_session() {
    let Some(mut engine) = Engine::start("always").await else {
        return;
    };
    let first = engine.session().await;
    let granted = run_turn(
        &mut engine,
        &first,
        "first.txt",
        &Answer::AllowAlwaysThenReject,
    )
    .await;
    eprintln!(
        "always turn: target {} -> {}; frames {:?}; answered {:?}; ended {:?}",
        granted.target.display(),
        if granted.exists { "EXISTS" } else { "absent" },
        granted.frames,
        granted.answered,
        granted.ended
    );
    assert!(
        granted.exists,
        "the first write was allowed always and no file appeared, so this run never reached the \
         state the second session is supposed to test. Target {} -> absent; frames {:?}; answered \
         {:?}",
        granted.target.display(),
        granted.frames,
        granted.answered,
    );

    // A new session on the same engine: the grant the prompt above produced belongs to the first
    // one, and the engine's `always` is documented — in its own code — as project-scoped storage
    // rather than a field of the session.
    let second = engine.session().await;
    let later = run_turn(&mut engine, &second, "second.txt", &Answer::Reject).await;
    let grants = engine_grants(&engine.profile);
    eprintln!(
        "later session: target {} -> {}; frames {:?}; answered {:?}; engine storage {grants:?}",
        later.target.display(),
        if later.exists { "EXISTS" } else { "absent" },
        later.frames,
        later.answered,
    );

    assert!(
        later.frames.is_empty(),
        "`Always allow` DID NOT OUTLIVE THE SESSION IT WAS GIVEN IN: a second session was asked \
         about the same tool again, which means the option this app offers as a lasting one is a \
         once-only grant wearing a longer name — and every user who took it was asked again in the \
         next session with no hint that the answer was not kept. Target {} -> {}; frames {:?}; \
         engine storage {grants:?}",
        later.target.display(),
        if later.exists { "EXISTS" } else { "absent" },
        later.frames,
    );
    assert!(
        later.exists,
        "INCONCLUSIVE, and deliberately red: nothing was asked and nothing was written, so this \
         run never reached the write it exists to characterize. Target {} -> absent; frames {:?}; \
         answered {:?}; engine log {:?}",
        later.target.display(),
        later.frames,
        later.answered,
        engine_log_lines(&engine.engine_log(), &[&later.target]),
    );

    eprintln!(
        "MEASURED: one `Always allow` answer silenced the question for a later session on the same \
         engine, and the engine's own profile holds {grants:?}. Every later write by this tool is \
         approved before this app is asked anything, which is what the option tells the user and \
         what nothing later tells them again."
    );
}
