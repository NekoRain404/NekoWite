//! Two app instances, one profile: what two engines do when they are handed the same roots.
//!
//! `agent_profile_isolation_test.rs` settled what a *single* launch sees. It deliberately did
//! not settle this, and said so: its three concurrent runs each got their own root, so they
//! shared no file and proved nothing about two engines on one root. This file is the other
//! half, and it is about the *product* case, not the test case.
//!
//! The shipped app resolves one profile root per (managed directory, profile id) pair —
//! `<managed>/agent-profiles/<id>/` — and hands it to the engine as `HOME` and the four XDG
//! roots (`isolated_profile_env`). Two instances of the app therefore launch two engines with
//! the same six values, and the engine keeps its session database and its `locks/` directory in
//! there — a directory named like a lock that is not one, which the last bullet below states
//! from the measurement. `tauri_plugin_single_instance` is what normally prevents the second instance; this
//! file measures the state the guard is protecting, so that the day the guard is bypassed the
//! consequence is a measured fact rather than a hypothesis.
//!
//! ## What is asserted
//!
//! 1. **The app derives one root, from a pure function of the managed directory and the
//!    profile id.** Two `ProfileStore` instances over one directory answer the same root,
//!    which is the whole reason a second process reaches the same files. Nothing here is
//!    per-process.
//! 2. **A second engine is not refused.** Both engines open a session against one root, with
//!    no error frame and no locking complaint.
//! 3. **The second engine can resume a session the first one created.** This is the
//!    shared-state result stated as one assertion, and it can only hold if the session row is
//!    in a file both engines read and write: the second engine has never seen that id except
//!    through the shared database. It is also the concrete failure — one conversation, two
//!    engines, and the app's own UI in each instance believing it owns the session.
//! 4. **There is exactly one database under the root.** A per-run database is what the
//!    isolation test gives each of its runs; the shipped app gives every run the same one.
//! 5. **A second root cannot load that session.** The negative control for assertion 3, and
//!    the reason it means anything: `session/load` is not a method that says yes to any id —
//!    pointed at a root that does not hold the session, the same engine refuses it. Without
//!    this, assertion 3 would be consistent with a resume that ignores its argument.
//!
//! ## What this file does not prove, and must not be read as proving
//!
//! * **It does not exercise the single-instance guard.** No Tauri app is launched here; the
//!    guard is a D-Bus name on the session bus, and this test has no session bus, no window
//!    and no second process of the app. Whether two instances can really run — and the
//!    paths that get around the guard — is a question about the plugin and the desktop, not
//!    about the engine.
//! * **It does not measure interleaved *writes*.** A run that prompts would spend money and
//!    need a credential; what is measured is that both engines attach to one session and one
//!    database, which is the state every write would then race in. `PRAGMA integrity_check`
//!    staying `ok` under two engines is what the probe recorded, not what this test asserts.
//! * **It says nothing about the engine's `locks/` directory, which is not a lock.** Measured
//!    separately (`two-instances-shared-state.md` §2): each entry is a 0700 directory named by a
//!    40-hex hash, holding `meta.json` (a token, a pid and a hostname) and an empty `heartbeat`
//!    — an ownership marker with liveness, and nothing else. No kernel lock is taken for it
//!    (`/proc/locks` has no entry for those inodes, at any point measured), the engine never
//!    refuses a second engine because of it — two, and at one point three, ran concurrently on
//!    one root with a marker present — and it is sometimes absent while engines run, and left
//!    behind with a dead pid afterwards, which the next start tolerates. **Nothing may read it
//!    as an exclusion.** The engine puts it in the profile root, so a file browser finds it
//!    beside the database; what actually keeps two engines from destroying that database is
//!    SQLite's own WAL locking inside it, and everything above the database (which session is
//!    being driven, which model, which message is in flight) is shared with no arbiter at all.
//!    A test asserting its contents would be pinning a hash this file cannot compute.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nekowite_lib::agent_runtime::profile::ProfileStore;
use nekowite_lib::agent_runtime::registry::DEFAULT_PROFILE;
use nekowite_lib::agent_runtime::{env_pairs, isolated_profile_env, EngineLaunch};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// The artifact the app ships. Gitignored and produced by the packaging pipeline, so a
/// checkout without it skips rather than fails — the same rule the other real-engine tests
/// follow.
const ENGINE: &str = "binaries/opencode-x86_64-unknown-linux-gnu";

/// Long enough for a cold `session/new`, which resolves the model catalog.
const PATIENCE: Duration = Duration::from_secs(120);

/// One profile root, inside the repository, built the way the app builds it.
///
/// The root is per-pid for the same reason the isolation test's is: two runs of this file must
/// not share a database either, or the concurrency result would be about *this* test.
struct ProfileTree {
    root: PathBuf,
}

impl ProfileTree {
    fn plant(label: &str) -> Self {
        let repo = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .expect("the repository root");
        // The isolation test's scratch parent, rather than a directory of this file's own: the
        // ignore rule is `/.tmp-isolation*/`, and a tree planted here is the same kind of thing
        // — a throwaway profile root inside the checkout, which is what the engine's project
        // walk has to be able to reach — so it belongs under the rule that already covers one.
        // `label` carries this file's pid and keeps its two trees, and the sibling test's, apart
        // exactly as it already keeps two runs of one test apart.
        let root = repo.join(".tmp-isolation-run").join(label);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("case")).expect("the working directory");
        Self { root }
    }

    fn cwd(&self) -> PathBuf {
        self.root.join("case")
    }

    /// The launch the app performs today, as `EnvPolicy::ProfileIsolated` builds it: the roots
    /// and the one switch, from the function the launch itself calls. Nothing is spelled out a
    /// second time here, so this test cannot drift from what a start actually injects.
    fn launch(&self) -> EngineLaunch {
        EngineLaunch {
            program: PathBuf::new(),
            args: vec!["acp".to_string()],
            env: env_pairs(isolated_profile_env(&self.root)),
            ca_bundle: None,
        }
    }

    /// Every database file under the root, so "one database" can be asserted rather than
    /// assumed. A walk rather than one path: a second file at a second path is exactly the
    /// thing that would make this test wrong.
    fn databases(&self) -> Vec<PathBuf> {
        fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, found);
                } else if path.file_name().is_some_and(|name| name == "opencode.db") {
                    found.push(path);
                }
            }
        }
        let mut found = Vec::new();
        walk(&self.root, &mut found);
        found.sort();
        found
    }
}

/// One engine process, with everything it said.
///
/// The frames are kept rather than filtered as they arrive: this file's questions are about
/// *which* answer came back to *which* request, and a matcher that only looked for the session
/// id would accept a response to the wrong request — a mistake this measurement makes once, in
/// a probe, where it read a successful `session/load` as a timeout.
struct Engine {
    /// Which engine this is, in the failure messages: "the second engine never answered" is
    /// only useful if the message also says which process it was talking about.
    label: String,
    child: tokio::process::Child,
    frames: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<String>>,
    next_id: u64,
}

impl Engine {
    async fn start(tree: &ProfileTree, engine: &Path, label: &str) -> Self {
        // The environment is read back out of the launch description the runtime hands
        // `execve`, rather than restated here: a test that spelled the variables out again
        // would be measuring its own copy of them.
        let described = serde_json::to_value(tree.launch().agent_config())
            .expect("the launch serializes");
        let env = described["env"].as_object().expect("the launch's env").clone();

        let mut command = tokio::process::Command::new(engine);
        command
            .arg("acp")
            .current_dir(tree.cwd())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Drained on its own task: a pipe nobody reads would block the engine on its own
            // logging, and this file's failure messages are built from it.
            .stderr(Stdio::piped());
        for (name, value) in &env {
            command.env(name, value.as_str().expect("a string value"));
        }
        let mut child = command.spawn().expect("the engine starts");

        let frames = Arc::new(Mutex::new(Vec::new()));
        let stdout = child.stdout.take().expect("stdout");
        let sink = Arc::clone(&frames);
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                sink.lock().unwrap().push(line);
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let err = child.stderr.take().expect("stderr");
        let err_sink = Arc::clone(&stderr);
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut held = err_sink.lock().unwrap();
                held.push_str(&line);
                held.push('\n');
            }
        });

        Self {
            label: label.to_string(),
            child,
            frames,
            stderr,
            next_id: 0,
        }
    }

    /// Sends one request and answers the id it will be replied to under.
    async fn send(&mut self, method: &str, params: serde_json::Value) -> u64 {
        let id = self.next_id + 1;
        self.next_id = id;
        let message = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        });
        self.child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(format!("{message}\n").as_bytes())
            .await
            .expect(method);
        id
    }

    /// The frame that answered request `id`, once it arrives.
    async fn answer(&self, id: u64) -> Option<String> {
        let needle = format!("\"id\":{id}");
        let deadline = tokio::time::Instant::now() + PATIENCE;
        loop {
            if let Some(line) = self
                .frames
                .lock()
                .unwrap()
                .iter()
                .find(|line| line.contains(&needle))
            {
                return Some(line.clone());
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn said(&self, needle: &str) -> bool {
        self.frames.lock().unwrap().iter().any(|l| l.contains(needle))
    }

    /// The session id in a frame, for the caller that has just been told one.
    fn session_id(line: &str) -> Option<String> {
        let marker = "\"sessionId\":\"";
        let start = line.find(marker)? + marker.len();
        let rest = &line[start..];
        let end = rest.find('"')?;
        Some(rest[..end].to_string())
    }

    fn diagnostics(&self) -> String {
        let stderr = self.stderr.lock().unwrap();
        let tail: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
        let start = tail.len().saturating_sub(6);
        format!(
            "engine {}: frames {}, stderr:\n    {}",
            self.label,
            self.frames.lock().unwrap().len(),
            if tail.is_empty() {
                "(none)".to_string()
            } else {
                tail[start..].join("\n    ")
            }
        )
    }

    async fn open_session(&mut self, cwd: &Path) -> String {
        self.send(
            "initialize",
            serde_json::json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        )
        .await;
        let opened = self
            .send(
                "session/new",
                serde_json::json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
            )
            .await;
        let answer = self.answer(opened).await.unwrap_or_else(|| {
            panic!(
                "the engine never opened a session, so nothing below measured shared state.\n    {}",
                self.diagnostics()
            )
        });
        assert!(
            !answer.contains("\"error\""),
            "session/new was refused: {answer}\n    {}",
            self.diagnostics()
        );
        Self::session_id(&answer).expect("a session id in a session/new result")
    }

    async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

/// The measurement, in one test: one root, two engines, and the session crossing between them.
///
/// One test rather than three because the engine is the expensive part and the assertions are
/// only meaningful together — the shared database is what makes the cross-engine resume
/// possible, and the resume is what proves the database is shared rather than merely present.
#[tokio::test]
async fn two_engines_on_one_profile_share_the_database_and_the_session() {
    let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join(ENGINE);
    if !engine.is_file() {
        eprintln!("SKIP: {} is absent; run scripts/fetch-opencode-linux.sh", engine.display());
        return;
    }

    let tree = ProfileTree::plant(&format!("two-instances-{}", std::process::id()));

    // 1. The app's own root resolution. Two stores over one managed directory — which is what
    //    two app processes have, since `app_data_dir()` reads the same environment in both —
    //    answer one root. Nothing in this path is per-process, which is why the second
    //    instance does not get a root of its own.
    let managed = tree.root.join("managed");
    let first = ProfileStore::new(&managed)
        .root_of(DEFAULT_PROFILE)
        .expect("the default profile id is a path component");
    let second = ProfileStore::new(&managed)
        .root_of(DEFAULT_PROFILE)
        .expect("the default profile id is a path component");
    assert_eq!(
        first, second,
        "two stores over one managed directory must resolve one profile root"
    );

    // 2. Engine A: a session, created against this root.
    let mut a = Engine::start(&tree, &engine, "A").await;
    let first_session = a.open_session(&tree.cwd()).await;

    // 3. Engine B: a second engine, same root, started while A is live. It is not refused,
    //    and it resumes the session A created — an id B has never seen except through the
    //    database the two share.
    let mut b = Engine::start(&tree, &engine, "B").await;
    b.send(
        "initialize",
        serde_json::json!({ "protocolVersion": 1, "clientCapabilities": {} }),
    )
    .await;
    let resumed = b
        .send(
            "session/load",
            serde_json::json!({
                "sessionId": first_session,
                "cwd": tree.cwd().to_string_lossy(),
                "mcpServers": [],
            }),
        )
        .await;
    let answer = b.answer(resumed).await.unwrap_or_else(|| {
        panic!(
            "the second engine never answered session/load for the session the first engine \
             created ({first_session}), so this root's database is not one both engines read.\n    \
             {}",
            b.diagnostics()
        )
    });
    assert!(
        !answer.contains("\"error\""),
        "the second engine was refused the first engine's session: {answer}\n    {}",
        b.diagnostics()
    );
    // The load result carries the session's own id back; the engine that answers with a
    // session it did not create is the engine reading the other instance's rows.
    assert!(
        b.said(&first_session),
        "the second engine answered without ever naming the shared session\n    {}",
        b.diagnostics()
    );

    // 4. One database, not two. A per-run database is what the isolation test's concurrency
    //    result rests on; this is the same measurement showing the shipped app does the
    //    opposite.
    let databases = tree.databases();
    assert_eq!(
        databases.len(),
        1,
        "two engines on one profile must share one database, found {databases:?}"
    );
    assert!(
        databases[0].starts_with(&tree.root),
        "the database must be inside the profile root: {:?}",
        databases[0]
    );

    // 5. The control that makes 3 a measurement: an engine on a *different* root, asked for
    //    the same session, must be refused. If it were not, the resume above would be a
    //    property of the method rather than of the shared root.
    let elsewhere = ProfileTree::plant(&format!("two-instances-other-{}", std::process::id()));
    let mut c = Engine::start(&elsewhere, &engine, "C").await;
    c.send(
        "initialize",
        serde_json::json!({ "protocolVersion": 1, "clientCapabilities": {} }),
    )
    .await;
    let refused = c
        .send(
            "session/load",
            serde_json::json!({
                "sessionId": first_session,
                "cwd": elsewhere.cwd().to_string_lossy(),
                "mcpServers": [],
            }),
        )
        .await;
    let answer = c.answer(refused).await.unwrap_or_else(|| {
        panic!(
            "an engine on a different root never answered session/load, so the resume above \
             was never put in question.\n    {}",
            c.diagnostics()
        )
    });
    assert!(
        answer.contains("\"error\""),
        "an engine whose root does not hold this session answered session/load with a result, \
         so the shared-root resume above proves nothing about sharing: {answer}\n    {}",
        c.diagnostics()
    );

    a.kill().await;
    b.kill().await;
    c.kill().await;
}
