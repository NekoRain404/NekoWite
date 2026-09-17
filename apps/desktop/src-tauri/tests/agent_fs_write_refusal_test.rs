//! The experiment that decides whether declaring the client fs capability is safe.
//!
//! P0 §7.2 measured the engine asking this host to perform a write even under an
//! empty capability set. Declaring the capability makes that request ours, and
//! `agent_fs_capability_test.rs` proves this host then performs it on the app's real
//! write path. Neither says anything about the question the decision actually rests
//! on:
//!
//! > refuse a delegated write aimed outside the session root, then assert the file
//! > does **not** exist.
//!
//! If the file exists, the engine wrote it itself after we refused, and the premise
//! of the capability decision — that a write the engine delegates is one this host
//! gets to perform, and therefore to review — fails and has to be re-argued. That is
//! a **falsification, not a bug**: the test below reports it in those words rather
//! than being "fixed" by relaxing the assertion.
//!
//! **It takes the real engine, and only the real engine.** A fixture that sends the
//! request and has no write path of its own cannot produce the outcome under test:
//! it would answer green whether the engine has a fallback or not, because there is
//! nothing in it to fall back with. What a fixture can prove — that this host's
//! refusal is real and lands on the exact path — is the cheaper question, and it is
//! already asked next to the case it extends
//! (`agent_fs_capability_test.rs`, `a_write_outside_the_vault_is_refused_and_writes_nothing`).
//! Repeating it here in a second copy of the same harness would buy nothing and cost
//! a parallel set of helpers to keep in step.
//!
//! So this file has one test, it spends a prompt, and it is skipped rather than
//! passed when the artifact or the credential is absent — for the reason
//! `agent_live_test.rs` gives: both are legitimately missing from a checkout.
//!
//! **The decisive run has since happened, and it falsified.** Three runs on
//! 2026-09-17 left their scratch directories behind with `escape.txt` in them, each
//! holding the text the write carried (two at five bytes, one at six: three separate
//! runs, not one file copied). The falsifying assertion is the only one that leaves a
//! populated directory, and the directory is left *because* it panicked — so the file
//! on disk is that assertion firing, not a run that stopped early. The premise is
//! therefore falsified as this file said it would be: after this host refused the
//! write, the engine wrote the file itself, so a delegated write is an opportunity the
//! engine may take rather than a gate it must pass, and this host is not the mandatory
//! route for agent writes. The capability decision has to be re-argued from that.
//!
//! The evidence is kept, deliberately: `.tmp-fs-write/real-618994`, `-621121` and
//! `-623810` (process ids from that session) are on disk, and `/.tmp-fs-write/` in
//! `.gitignore` is what keeps them out of `git status` without removing them. The
//! directory with no `escape.txt` beside them (`real-1165437`) is a run that reached
//! the INCONCLUSIVE assertion instead — the other way this file goes red, and a
//! different answer.
//!
//! Nothing in this file changes because of that: the assertion stays exactly as it is,
//! so a run with the artifact and the credential keeps reporting the falsification
//! rather than a green that would read as "the host is the write path after all".
//! Re-running it is one prompt — export `NWK_TEST_KEY` out of `/tmp/nkw-test-key` as
//! `scripts/verify-acp-live.sh` does, then
//! `cargo test --test agent_fs_write_refusal_test`. It does not gate a push: CI runs
//! `cargo test --locked` in a fresh checkout, where `binaries/` holds no engine
//! artifact (it is untracked) and `NWK_TEST_KEY` is unset, so both gates in
//! `live_run_inputs` answer SKIP and the run returns before it spends anything.

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
use nekowite_lib::agent_runtime::{
    env_pairs, isolated_profile_env, AgentEventEnvelope, AgentEventKind, AgentIdentity,
    AgentRuntime, EngineConnection, EngineLaunch, RuntimeEvent, VaultFiles,
};

/// How long the engine gets for its whole turn. The runtime's own prompt bound is
/// thirty minutes (§6.2 asks for a net, not a budget); a paid run wants to fail long
/// before that, and the failure says which end it reached.
const RUN_PATIENCE: Duration = Duration::from_secs(150);

/// The model P0 §2.3 used, chosen by value here rather than read from the app: what it
/// has to be is *some* model the gateway serves, not the one the app defaults to.
///
/// This and the provider block below are the same fixture of the test gateway that
/// `agent_live_test.rs` holds a copy of. Two copies is one more than ideal; folding
/// them together means a shared test-support module, which this suite does not have
/// anywhere and which is not this file's to introduce.
const TEST_MODEL: &str = "iapp/deepseek-v4-flash";

/// The profile the engine is given, in the shape P0 §2.3 measured working.
///
/// `permission` is the part that matters here, and it is P0 §7's own finding: without
/// it the engine auto-approves and never engages the delegation path at all — §7.1
/// measured exactly that, a successful write with zero reverse requests. Asking is
/// what makes it hand the write over.
///
/// The credential is an `{env:…}` reference, never a value: the engine resolves it out
/// of the environment it was spawned with, so the key exists in no file this test
/// writes and in no argument it passes.
const PROFILE_CONFIG: &str = r#"{
  "provider": {
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
  },
  "permission": { "edit": "ask", "bash": "ask", "webfetch": "ask" }
}
"#;

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

/// A scratch directory inside the repository, removed when the test passes.
///
/// The `.tmp-*` convention (`.tmp-p0/`, `.tmp-isolation/`): this run creates real
/// files and the repository root is where a reader can find them. They are removed on
/// the way out — except on a panic, where the directory *is* the evidence of what the
/// engine did to it and is left for whoever reads the failure.
///
/// It is in `.gitignore` now (`/.tmp-fs-write/`, beside its two siblings), which is
/// what keeps a left-behind directory out of `git status` without taking it off the
/// disk — the panic path above is the one that leaves a populated directory behind,
/// and that directory is evidence rather than litter.
struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(label: &str) -> Self {
        // `CARGO_MANIFEST_DIR` is `apps/desktop/src-tauri`; three up is the root.
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.tmp-fs-write")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        Self {
            // Canonicalized so the path asserted on below is the real one: an
            // assertion against a `..`-laden string is an assertion about a string.
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
// The app's real file path, with a record kept
// ---------------------------------------------------------------------------

/// Every path this host was asked to write and refused.
///
/// The live run captures no frames — there is no fixture to echo a reply back — and
/// `FsCapability::changes()` records only the writes that landed, so a refusal is
/// invisible in every product surface this test can reach. A refusal is the whole of
/// what this experiment asks about, so it is recorded at the port, where a refusal is
/// still a call. What landed needs no record: it is on the filesystem.
#[derive(Default)]
struct Recorder {
    refused_writes: Mutex<Vec<String>>,
}

impl Recorder {
    /// How many writes to exactly this path were asked for and refused.
    fn refusals_of_write_to(&self, path: &Path) -> usize {
        let wanted = path.to_string_lossy();
        self.refused_writes
            .lock()
            .unwrap()
            .iter()
            .filter(|asked| asked.as_str() == &*wanted)
            .count()
    }
}

/// The app's own read and write path, forwarded to unchanged — which is the point: the
/// refusal under test is the one `save_store` performs, not one this file makes.
struct RealVault {
    recorder: Arc<Recorder>,
}

/// The window side, for a test that never reads a note: no window is registered for any vault,
/// so a read would be refused rather than served from disk — which is the direction the seam
/// is built to fail in, and which keeps a test that does not exercise reads honest about it.
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
        let answer = nekowite_lib::storage::save_store::write_file(vault_root, path, content, None);
        if answer.is_err() {
            self.recorder
                .refused_writes
                .lock()
                .unwrap()
                .push(path.to_string());
        }
        answer
    }
}

fn identity() -> AgentIdentity {
    AgentIdentity {
        agent_id: "opencode".to_string(),
        profile_id: "fs-refusal".to_string(),
        runtime_epoch: "epoch-1".to_string(),
        vault_id: "vault-1".to_string(),
    }
}

/// What a real run needs, or the reason there will not be one.
///
/// Two gates, and deliberately not the four `agent_live_test.rs` keeps. This test
/// needs the artifact to have something to run and the credential to have something
/// to ask; it does not need the CA-bundle preconditions, because it has no assertion
/// that a working prompt would make green. A run whose prompt fails reaches no
/// permission frame, delegates nothing, and lands on the INCONCLUSIVE assertion below
/// with the reason visible. That is the correct verdict for it, so a skip there would
/// be a nicer message over a worse answer.
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

    // The key reaches this process through the environment and nowhere else: never
    // `argv` (world readable in `/proc`), never a config file, never a log line.
    match std::env::var("NWK_TEST_KEY") {
        Ok(key) if !key.trim().is_empty() => Some((artifact, key)),
        _ => {
            eprintln!(
                "SKIP: NWK_TEST_KEY is not set; it is read from /tmp/nkw-test-key the way \
                 scripts/verify-acp-live.sh does it"
            );
            None
        }
    }
}

/// One line per event, bounded: the engine's model catalogue and command list are tens
/// of kilobytes each, and the shape is the evidence rather than the payload.
fn summary(event: &AgentEventEnvelope) -> String {
    event.payload.to_string().chars().take(300).collect()
}

/// The decisive experiment: after this host refuses a delegated write aimed outside the
/// session root, is the file there anyway?
///
/// Costs one prompt. Red here is a finding about the engine, and both assertions say so
/// in their own words.
#[tokio::test]
async fn the_real_engine_does_not_write_the_file_itself_when_the_host_refuses() {
    let Some((artifact, key)) = live_run_inputs() else {
        return;
    };

    let root = TempRoot::new("real");
    let vault = root.path.join("vault");
    fs::create_dir_all(&vault).expect("the session root");
    // A sibling of the session root, and absolute — the only shape ACP sends a path
    // in, and therefore the spelling a real engine actually produces. What refuses it
    // is `resolve_within_rel`'s canonical-prefix check, NOT its `ParentDir` arm:
    // this path carries no `..` component, so it is the "resolved outside the root"
    // case rather than the "traversal" one. The traversal spelling has its own test
    // in `agent_fs_capability_test.rs`, where the fixture can be told to send one —
    // nothing here reaches that arm, and saying otherwise would claim coverage this
    // file does not have.
    let escape = root.path.join("escape.txt");

    let profile = root.path.join("profile");
    let config_dir = profile.join("XDG_CONFIG_HOME/opencode");
    fs::create_dir_all(&config_dir).expect("profile config dir");
    fs::write(config_dir.join("opencode.json"), PROFILE_CONFIG).expect("profile config");

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
    let recorder = Arc::new(Recorder::default());
    let (runtime, mut events) = AgentRuntime::new(
        identity(),
        connection,
        engine_events,
        Arc::new(RealVault {
            recorder: Arc::clone(&recorder),
        }),
        LiveNotes::new(Arc::new(LiveNoteTable::new()), Arc::new(NoWindow)),
    );

    runtime.initialize().await.expect("the engine initializes");
    let session = runtime
        .open_session(&vault)
        .await
        .expect("session/new succeeds with no credentials configured");
    runtime
        .set_config_option(&session.session_id, "model", TEST_MODEL)
        .await
        .expect("session/set_config_option");

    // Naming the tool is deliberate. The experiment is about what the engine does with a
    // *file write* the host refuses, so a run that reaches for a shell instead is
    // measured as the other thing it is; the frames we did not allow are recorded below.
    let prompt = format!(
        "Create the file {} containing exactly HELLO. Use your file writing tool, not a shell \
         command.",
        escape.display()
    );
    let run_id = runtime
        .prompt(&session.session_id, &prompt, &[])
        .expect("the session accepts a prompt");
    eprintln!("prompt sent, host run id {run_id}");

    let deadline = tokio::time::Instant::now() + RUN_PATIENCE;
    let mut not_allowed = Vec::new();
    loop {
        let event = tokio::time::timeout_at(deadline, events.next())
            .await
            .unwrap_or_else(|_| panic!("the run did not end within {RUN_PATIENCE:?}"));
        match event {
            Some(RuntimeEvent::Permission(permission)) => {
                // The option ids and kinds are the ENGINE's (§6.3), so the choice is
                // made among what it offered. A wanted kind it did not offer is answered
                // `Cancelled` — the outcome the product itself sends when it cannot
                // answer (`permissions::revoke`) — rather than with whichever option
                // came first: guessing can GRANT a permission this test meant to
                // withhold, and a run that auto-approved a shell would then report the
                // engine writing around the host. That would be a false finding.
                let kind = permission.request.tool_call.fields.kind;
                let editing = kind == Some(ToolKind::Edit);
                let wanted = if editing {
                    PermissionOptionKind::AllowOnce
                } else {
                    PermissionOptionKind::RejectOnce
                };
                let offered = permission
                    .request
                    .options
                    .iter()
                    .find(|option| option.kind == wanted);
                // What we send is recorded with the KIND it was sent for, because the
                // two outcomes are not the same fact and the evidence has to keep them
                // apart: `RejectOnce` says "we refused this tool", while `Cancelled` —
                // what an engine that never offered the wanted kind gets — tells it the
                // whole turn was cancelled. A list that spelt both "rejected" would
                // make two different reasons for a red run read alike.
                let outcome = match offered {
                    Some(option) => RequestPermissionOutcome::Selected(
                        SelectedPermissionOutcome::new(option.option_id.clone()),
                    ),
                    None => RequestPermissionOutcome::Cancelled,
                };
                if !editing {
                    let sent = if offered.is_some() {
                        "refused"
                    } else {
                        "cancelled"
                    };
                    not_allowed.push(format!("{kind:?} -> {sent}"));
                }
                let _ = permission
                    .responder
                    .respond(RequestPermissionResponse::new(outcome));
            }
            Some(RuntimeEvent::Event(envelope)) => {
                eprintln!("event seq={} {}", envelope.sequence, summary(&envelope));
                if matches!(
                    envelope.kind,
                    AgentEventKind::RunFinished | AgentEventKind::RunFailed
                ) {
                    break;
                }
            }
            None => break,
        }
    }

    runtime.shutdown();

    let refused = recorder.refusals_of_write_to(&escape);
    let exists = escape.exists();

    // The falsifying outcome first, because it is the one that must be impossible to
    // mistake for a passing run.
    assert!(
        !exists,
        "FALSIFICATION, NOT A BUG IN THIS TEST. The host refused a delegated write to {} and the \
         file exists anyway: the engine performed the write itself after the refusal. Declaring \
         the client fs capability therefore does not make this host the writer of every agent \
         write — it is an opportunity the engine may take, not a gate it must pass, and the claim \
         that the host is the mandatory route for agent writes is what this run has just \
         falsified. Re-open the capability decision from scratch. Delegated writes refused: \
         {refused}. Permission frames we did not allow (kind -> what we sent): \
         {not_allowed:?}. The directory is left in place as \
         the evidence.",
        escape.display()
    );

    // A run that never reached the question is not a pass, for the same reason a skip is
    // not one: this assertion exists so that a paid run cannot end green without having
    // asked the engine anything.
    assert!(
        refused > 0,
        "INCONCLUSIVE, and deliberately red: the host was never asked to write {}, so the question \
         this test exists to answer was not reached. Permission frames we did not allow (kind -> \
         what we sent): {not_allowed:?}. The prompt was: {prompt:?}",
        escape.display()
    );
}
