//! What the environment this app *inherits* can still reach, measured one variable at a time.
//!
//! `df97348` closed the four variables that redirect the engine's configuration or its storage
//! (`OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DB`) and named
//! what it had not measured rather than leaving it implied: the pinned engine's string table
//! carries 82 `OPENCODE_*` names, and the rest of them were an open question. This file is the
//! answer for the six that can put *something of the developer's own* into this profile, and
//! `agent_runtime::environment`'s module comment is the classification of all of them — including
//! the ones this file does not exercise, and why.
//!
//! ## The read-out, and why it costs nothing
//!
//! `session/new` answers with `configOptions`, whose model selector enumerates every provider the
//! engine resolved. Measured against the pinned 1.18.29, what a developer's own environment can
//! add to it:
//!
//! | inherited variable | what appears with it |
//! | --- | --- |
//! | `OPENCODE_AUTH_CONTENT` | `anthropic` and its 16 models — 8 models become 24 |
//! | `OPENCODE_API_KEY` | `opencode-go` and its 84 models — 8 models become 92 |
//! | `OPENCODE_TEST_HOME` | a provider from the config document under *that* home |
//! | `OPENCODE_MODELS_PATH` | a provider from the developer's own catalogue file |
//! | `OPENCODE_MODELS_URL` | a provider from the developer's own catalogue server |
//! | `OPENCODE_SERVER_PASSWORD` | nothing here — it is read from the engine's own HTTP surface |
//!
//! No prompt and no credential of this app's is spent: a provider is *discovered* whether or not
//! its key works, and what the first two rows describe is the engine resolving a credential that
//! comes from the developer's own environment. The last row is the one that needs another read-out,
//! and it is the shipped client's: `permission_grants::list` answers 401 while an inherited password
//! is in force, which is the app's own page reporting the engine as unreadable.
//!
//! ## Both directions, and the second is not optional
//!
//! Five launches: three of the app as it was, one per variable group, and two of the app as it
//! ships. The **before** launch is the shipped environment with exactly these six entries taken out
//! and the same inherited values delivered — and it has to find every decoy. Without it, "not
//! discovered" and "never looked for" are the same observation, and the shipped launch would be
//! credited with closing something that was never open. The **after** launch is the launch this app
//! performs, with the same inherited values, and it must find none of them while still finding the
//! profile's own configuration document.
//!
//! Two *after* launches rather than one, because the catalogue decoys mask the credential ones: a
//! launch that resolves its model list from the developer's own catalogue has no `anthropic` in it
//! to authenticate, so a negative about `OPENCODE_AUTH_CONTENT` could not fail there. The catalogue
//! routes are also measured in separate *before* launches, for the mirror reason: measured,
//! `OPENCODE_MODELS_PATH` wins over `OPENCODE_MODELS_URL` inside one launch, so the file's arrival
//! would hide the URL's.
//!
//! The inherited values are delivered the way an inherited variable arrives — set on the command
//! *before* the launch's own description is applied, which is what the ACP SDK does
//! (`AcpAgentConfig`'s `env` is `Command::envs` on a command that never calls `env_clear`). A test
//! that appended them afterwards would be measuring an override no launch performs.
//!
//! Re-run this against a new engine artifact: the assertions are exact, so a version that reads one
//! of these names differently fails loudly rather than silently widening what this profile reads.

use std::collections::BTreeSet;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nekowite_lib::agent_runtime::adapters;
use nekowite_lib::agent_runtime::permission_grants::{self, EngineHttp, GrantsReadout};
use nekowite_lib::agent_runtime::{env_pairs, isolated_profile_env, EngineLaunch};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

/// The artifact the app ships. Gitignored and produced by the packaging pipeline, so a checkout
/// without it skips rather than fails — the same rule the runtime's real-engine tests follow.
const ENGINE: &str = "binaries/opencode-x86_64-unknown-linux-gnu";

/// Long enough for a cold `session/new`, which resolves the model catalog; short enough that a
/// genuine hang is a failure rather than a suite timeout.
const PATIENCE: Duration = Duration::from_secs(120);

/// The six entries the launch now carries for the inherited environment.
///
/// Named here so the first launch of each pair can be built by taking exactly these out of the
/// shipped environment, which is what makes it the launch this app performed before them. A rename
/// inside [`isolated_profile_env`] would leave this list naming nothing, which the guard in the
/// test refuses.
const CLOSED: [&str; 6] = [
    "OPENCODE_AUTH_CONTENT",
    "OPENCODE_API_KEY",
    "OPENCODE_TEST_HOME",
    "OPENCODE_MODELS_PATH",
    "OPENCODE_MODELS_URL",
    "OPENCODE_SERVER_PASSWORD",
];

/// The decoy provider the profile's own configuration document declares. Every launch has to find
/// it: it is the positive that keeps a launch that stopped reading configuration at all from
/// passing every assertion below.
const PROFILE_PROVIDER: &str = "nwk-decoy-profile";

/// A provider the shipped catalogue carries and this profile holds no credential for. Its
/// appearing at all is the statement that a credential arrived from outside: nothing in this
/// profile names `anthropic`, and no configuration can invent it.
const AUTH_PROVIDER: &str = "anthropic";

/// The zen provider an `OPENCODE_API_KEY` unlocks. The engine's own, not a decoy: what the variable
/// buys is exactly this second provider, measured as 8 models becoming 92.
const KEYED_PROVIDER: &str = "opencode-go";

/// The provider planted in the config document under the decoy *home*. Reachable only through
/// `OPENCODE_TEST_HOME`, which is the one variable that moves the engine's home past the `HOME`
/// this launch pins.
const HOME_PROVIDER: &str = "nwk-decoy-test-home";

/// The providers planted in the two catalogues the developer can name. One per route, because the
/// file and the URL are different variables and a single decoy could not tell them apart.
const FILE_PROVIDER: &str = "nwk-decoy-models-path";
const URL_PROVIDER: &str = "nwk-decoy-models-url";

/// The engine's own provider, carried by the catalogue this app ships and by the real models.dev.
/// Its appearing is the positive for "the catalogue in force is not one a developer named", since
/// neither decoy catalogue carries it.
const SHIPPED_CATALOGUE: &str = "opencode/";

/// The variable that makes a decoy catalogue's provider usable, standing in for whatever the
/// developer's own shell exported. A catalogued provider is only *active* — and so only listed —
/// once something resolves it a credential, which is the engine's own rule and the reason this
/// exists at all.
const CATALOGUE_KEY: &str = "NWK_DECOY_CATALOGUE_KEY";

/// A decoy tree, rooted inside the repository.
///
/// Inside the repository for the sibling file's reason: the engine's project walk stops at the
/// worktree, so a tree outside the checkout would not be walked. Nothing here depends on that walk,
/// but keeping every measurement harness in one place is worth more than a directory in `/tmp`.
struct DecoyTree {
    root: PathBuf,
    /// Where the decoy catalogue is served from, set once the server is listening. Empty until
    /// then, which is what an inherited `OPENCODE_MODELS_URL` never is.
    catalogue_url: String,
}

impl DecoyTree {
    fn plant(label: &str) -> Self {
        let repo = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .expect("the repository root");
        let root = repo.join(".tmp-isolation-run").join(label);
        let _ = fs::remove_dir_all(&root);
        let tree = Self {
            root,
            catalogue_url: String::new(),
        };
        tree.write_all();
        tree
    }

    /// The profile root, as the launch's own roots spell it: each variable's name is the
    /// directory's, one level under it.
    fn profile(&self) -> PathBuf {
        self.root.clone()
    }

    fn config_dir(&self) -> PathBuf {
        self.root.join("XDG_CONFIG_HOME/opencode")
    }

    fn cwd(&self) -> PathBuf {
        self.root.join("vault")
    }

    /// The home an inherited `OPENCODE_TEST_HOME` names — the developer's own, in this measurement.
    fn decoy_home(&self) -> PathBuf {
        self.root.join("decoy-home")
    }

    /// The catalogue file an inherited `OPENCODE_MODELS_PATH` names.
    fn catalogue_file(&self) -> PathBuf {
        self.root.join("catalogue.json")
    }

    fn write_all(&self) {
        let at = |path: PathBuf, body: String| {
            fs::create_dir_all(path.parent().expect("a parent")).expect("decoy directory");
            fs::write(path, body).expect("decoy file");
        };
        at(
            self.config_dir().join("opencode.json"),
            configured(PROFILE_PROVIDER).to_string(),
        );
        // The decoy home's own `.opencode`, which the engine reads from `Path.home` — the walk
        // `$HOME` cannot reach when the variable that overrides it is inherited.
        at(
            self.decoy_home().join(".opencode/opencode.json"),
            configured(HOME_PROVIDER).to_string(),
        );
        at(
            self.catalogue_file(),
            catalogue(FILE_PROVIDER, &[CATALOGUE_KEY]).to_string(),
        );
        fs::create_dir_all(self.cwd()).expect("the session root");
    }

    /// The launch this app performs today, as `EnvPolicy::ProfileIsolated` builds it.
    fn launch(&self) -> EngineLaunch {
        EngineLaunch {
            program: PathBuf::new(),
            args: vec!["acp".to_string()],
            // The *root*, not the home: the function forms each variable's value by joining the
            // variable's own name onto what it is given.
            env: env_pairs(isolated_profile_env(&self.profile())),
            ca_bundle: None,
        }
    }

    /// The same launch with the six entries taken out: the environment this app produced before
    /// they existed. Nothing else differs, which is what makes the pair a measurement.
    fn launch_without_the_closures(&self) -> EngineLaunch {
        let mut launch = self.launch();
        launch
            .env
            .retain(|(name, _)| !CLOSED.contains(&name.as_str()));
        launch
    }

    /// What the developer's own shell exported, per group. One group per launch, so every
    /// assertion names one variable rather than a mixture of them.
    fn inherited(&self, group: Group) -> Vec<(String, String)> {
        let path = |value: PathBuf| value.to_string_lossy().into_owned();
        match group {
            Group::Credentials => vec![
                (
                    "OPENCODE_AUTH_CONTENT".to_string(),
                    serde_json::json!({
                        AUTH_PROVIDER: { "type": "api", "key": "nwk-decoy-anthropic-key" }
                    })
                    .to_string(),
                ),
                (
                    "OPENCODE_API_KEY".to_string(),
                    "nwk-decoy-api-key-0123456789".to_string(),
                ),
                ("OPENCODE_TEST_HOME".to_string(), path(self.decoy_home())),
                (
                    "OPENCODE_SERVER_PASSWORD".to_string(),
                    "nwk-decoy-server-password".to_string(),
                ),
            ],
            Group::CatalogueFile => vec![
                (
                    "OPENCODE_MODELS_PATH".to_string(),
                    path(self.catalogue_file()),
                ),
                (CATALOGUE_KEY.to_string(), "nwk-decoy-value".to_string()),
            ],
            Group::CatalogueUrl => vec![
                (
                    "OPENCODE_MODELS_URL".to_string(),
                    self.catalogue_url.clone(),
                ),
                (CATALOGUE_KEY.to_string(), "nwk-decoy-value".to_string()),
            ],
        }
    }

    /// The two catalogue routes at once, for the launch that measures whether either is still
    /// reachable: `OPENCODE_MODELS_PATH` wins over the URL inside one launch (measured), so their
    /// *reachability* is measured in separate launches above and their *closure* together here.
    fn both_catalogue_routes(&self) -> Vec<(String, String)> {
        let mut both = self.inherited(Group::CatalogueFile);
        both.extend(self.inherited(Group::CatalogueUrl));
        both
    }
}

impl Drop for DecoyTree {
    /// Removed when the test passes, kept when it panics — while it is panicking the directory *is*
    /// the evidence, and the engine's own cache and database are inside it. The harnesses already in
    /// this parent keep every tree they plant, and each one holds an engine cache of tens of
    /// megabytes: `.tmp-isolation-run/` had reached 7.4 GiB on this machine when this was written.
    /// A harness for one measurement should not add to that.
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

/// Which of the developer's variables one launch delivers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Group {
    /// The credentials and the home: `OPENCODE_AUTH_CONTENT`, `OPENCODE_API_KEY`,
    /// `OPENCODE_TEST_HOME`, `OPENCODE_SERVER_PASSWORD`.
    Credentials,
    /// `OPENCODE_MODELS_PATH`, with the variable that makes its provider usable.
    CatalogueFile,
    /// `OPENCODE_MODELS_URL`, the same way.
    CatalogueUrl,
}

/// One provider as the engine's *configuration* spells it.
///
/// A config document and a catalogue are different languages and the engine reads both: a document
/// names its providers under a `provider` member and a model needs nothing but a name, while a
/// catalogue is a map keyed by provider id and every model carries a `limit` and a `cost`. Written
/// with the wrong one, a decoy is silently not a provider at all — this file's first version put a
/// catalogue entry in the decoy home's `.opencode` and measured the variable as inert.
fn configured(id: &str) -> serde_json::Value {
    serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            id: {
                "npm": "@ai-sdk/openai-compatible",
                "name": id,
                "options": { "baseURL": "http://127.0.0.1:9/v1", "apiKey": "placeholder" },
                "models": { format!("{id}-model"): { "name": format!("{id}-model") } }
            }
        }
    })
}

/// A models.dev catalogue entry, in the shape the engine's own `api.json` uses.
///
/// The `limit` and `cost` members are not decoration: measured, the engine dereferences
/// `limit.context` while resolving a catalogued provider, so an entry without one makes
/// `session/new` fail rather than resolve — a probe that omitted it reported an empty model list
/// and would have been read as "the catalogue was ignored".
fn catalogue_provider(id: &str, env: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": id,
        "npm": "@ai-sdk/openai-compatible",
        "api": "http://127.0.0.1:9/v1",
        "env": env,
        "models": {
            format!("{id}-model"): {
                "id": format!("{id}-model"),
                "name": format!("{id}-model"),
                "limit": { "context": 100_000, "output": 10_000 },
                "cost": { "input": 0, "output": 0 },
                "modalities": { "input": ["text"], "output": ["text"] },
                "tool_call": true,
                "attachment": false,
                "reasoning": false,
            }
        }
    })
}

/// One catalogue, keyed by provider id, exactly as the engine's own document is.
fn catalogue(id: &str, env: &[&str]) -> serde_json::Value {
    serde_json::json!({ id: catalogue_provider(id, env) })
}

/// Everything one conversation with the engine produced.
///
/// The stderr is kept for the sibling file's reason: this file's assertions are mostly about what
/// was **not** discovered, and a transport failure produces exactly the same silence as a closed
/// surface. Without it, a broken launch would be reported as an isolation result.
struct Readout {
    frames: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<String>>,
    /// What the shipped grants client said while this engine was running — `Err` carrying the
    /// engine's own refusal when one arrived.
    grants: Result<GrantsReadout, String>,
}

impl Readout {
    fn text(&self) -> String {
        self.frames.lock().unwrap().join("\n")
    }

    fn saw(&self, marker: &str) -> bool {
        self.text().contains(marker)
    }

    fn diagnostics(&self) -> String {
        let text = self.text();
        let mut seen: Vec<&str> = [
            PROFILE_PROVIDER,
            AUTH_PROVIDER,
            KEYED_PROVIDER,
            HOME_PROVIDER,
            FILE_PROVIDER,
            URL_PROVIDER,
        ]
        .into_iter()
        .filter(|marker| text.contains(marker))
        .collect();
        seen.sort_unstable();
        let stderr = self.stderr.lock().unwrap();
        let lines: Vec<&str> = stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let tail = lines[lines.len().saturating_sub(6)..].join("\n    ");
        format!(
            "markers seen: {seen:?}, grants: {:?}, engine stderr:\n    {}",
            self.grants
                .as_ref()
                .map(|_| "answered")
                .unwrap_or("refused"),
            if tail.is_empty() { "(none)" } else { &tail },
        )
    }
}

/// Runs one engine to a session and returns everything it said.
///
/// The environment is read back out of [`EngineLaunch::agent_config`], which is the description the
/// runtime hands `execve` — a test that spelled the variables out again would be measuring its own
/// copy of them. `inherited` is set on the command *before* that description, which is what an
/// inherited variable is; setting them second would be a launch that could not exist.
///
/// **The environment is cleared first, and that is not tidiness.** Without it the engine inherits
/// the *test runner's* environment, and this file's read-out is a real provider name: a shell with
/// an `ANTHROPIC_API_KEY` in it — which is an ordinary thing for a development machine to have —
/// authenticates `anthropic` in every launch here, and the failure lands on the assertion about
/// `OPENCODE_AUTH_CONTENT` while that variable was closed the whole time. Measured: that is exactly
/// what happened on the machine this was written on, and `AUTH_PROVIDER` was the marker that found
/// it. What the developer's own environment *is* has to be decided by the measurement rather than
/// by whoever runs it.
async fn converse(
    tree: &DecoyTree,
    engine: &Path,
    launch: &EngineLaunch,
    http: EngineHttp,
    inherited: &[(String, String)],
) -> Readout {
    let described = serde_json::to_value(launch.agent_config()).expect("the launch serializes");
    let env = described["env"]
        .as_object()
        .expect("the launch's env")
        .clone();

    let mut command = tokio::process::Command::new(engine);
    command
        .args(&launch.args)
        .current_dir(tree.cwd())
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Drained on its own task rather than dropped: a pipe nobody reads blocks the engine on
        // its own logging, which would be a hang invented by the test.
        .stderr(Stdio::piped());
    for (name, value) in inherited {
        command.env(name, value);
    }
    for (name, value) in &env {
        command.env(name, value.as_str().expect("a string value"));
    }
    let mut child = command.spawn().expect("the engine starts");

    let frames = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&frames);
    let stdout = child.stdout.take().expect("stdout");
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            sink.lock().unwrap().push(line);
        }
    });
    let stderr = Arc::new(Mutex::new(String::new()));
    let stderr_sink = Arc::clone(&stderr);
    let err = child.stderr.take().expect("stderr");
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(err).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut held = stderr_sink.lock().unwrap();
            held.push_str(&line);
            held.push('\n');
        }
    });

    let mut stdin = child.stdin.take().expect("stdin");
    let send = |message: serde_json::Value| format!("{message}\n").into_bytes();
    stdin
        .write_all(&send(serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": 1, "clientCapabilities": {} },
        })))
        .await
        .expect("initialize");
    wait_for(&frames, "\"id\":1", PATIENCE).await;

    stdin
        .write_all(&send(serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "session/new",
            "params": { "cwd": tree.cwd().to_string_lossy(), "mcpServers": [] },
        })))
        .await
        .expect("session/new");

    let mut readout = Readout {
        frames: Arc::clone(&frames),
        stderr: Arc::clone(&stderr),
        grants: Ok(GrantsReadout::Unsupported),
    };
    // The preconditions, asserted before any question about discovery is asked. Without them a
    // broken transport reads as a closed surface: every "must not be discovered" assertion below
    // would pass while having measured nothing.
    assert!(
        wait_for(&frames, "sessionId", PATIENCE).await,
        "the engine never opened a session, so nothing below measured discovery at all. {}",
        readout.diagnostics()
    );
    assert!(
        wait_for(&frames, "configOptions", PATIENCE).await,
        "the engine opened a session but never sent its configuration options, so every claim \
         below about the model list would be a claim about a frame that never arrived. {}",
        readout.diagnostics()
    );
    // The shipped client, while the engine is up: the app's own read of the engine's HTTP surface,
    // through the port this launch pinned and the adapter's own route.
    readout.grants = permission_grants::list(Some(http)).await;

    let _ = child.kill().await;
    readout
}

async fn wait_for(frames: &Arc<Mutex<Vec<String>>>, needle: &str, patience: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + patience;
    loop {
        if frames
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains(needle))
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// One launch with the adapter's own port pinned.
///
/// The shipped `permission_grants::pin_http`, not a copy of it: the grants client below has to
/// address the process *this* launch started, and the flag that makes that possible is the
/// adapter's — asked for through the seam, the way `registry::start` asks for it.
fn pinned(mut launch: EngineLaunch) -> (EngineLaunch, EngineHttp) {
    let api =
        adapters::lookup(adapters::opencode::ADAPTER_ID).and_then(|adapter| adapter.http_api());
    let http = permission_grants::pin_http(&mut launch, api)
        .expect("the bundled adapter declares an HTTP surface");
    (launch, http)
}

/// One catalogue, served on loopback until the process ends.
///
/// The engine fetches `{url}/api.json`, which is the route models.opencode.ai answers — so this is
/// the smallest thing that can stand in for "the server a developer's own environment named".
fn serve_catalogue(body: String) -> SocketAddr {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let address = listener.local_addr().expect("the bound address");
    listener
        .set_nonblocking(true)
        .expect("a non-blocking listener");
    let listener = tokio::net::TcpListener::from_std(listener).expect("the tokio listener");
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let body = body.clone();
            tokio::spawn(async move {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: \
                     {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    address
}

/// The measurement, in one test: three launches of the app as it was, two of the app as it ships.
///
/// One test rather than five because the engine is the expensive part and the launches are only
/// meaningful next to each other — a negative in a shipped launch is evidence *because* the
/// matching launch before it found the same decoy.
#[tokio::test]
async fn an_inherited_environment_reaches_no_configuration_this_profile_did_not_name() {
    let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join(ENGINE);
    if !engine.is_file() {
        eprintln!(
            "SKIP: {} is absent; run scripts/fetch-opencode-linux.sh",
            engine.display()
        );
        return;
    }

    let mut tree = DecoyTree::plant(&format!("inherited-environment-{}", std::process::id()));
    let address = serve_catalogue(catalogue(URL_PROVIDER, &[CATALOGUE_KEY]).to_string());
    tree.catalogue_url = format!("http://{address}");

    // The guard the whole file rests on: the pair of launches differs by exactly these six entries,
    // so a rename inside `isolated_profile_env` has to fail here rather than turn the first launch
    // into a copy of the second.
    let installed: BTreeSet<String> = tree
        .launch()
        .env
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    for name in CLOSED {
        assert!(
            installed.contains(name),
            "the shipped launch does not carry {name}, so the pair below would measure nothing: \
             {installed:?}"
        );
    }

    // ---- The app as it was: one launch per group, each with its own decoys ------------------
    let credentials = tree.inherited(Group::Credentials);
    let (launch, http) = pinned(tree.launch_without_the_closures());
    let before = converse(&tree, &engine, &launch, http, &credentials).await;
    let seen = before.diagnostics();
    for marker in [AUTH_PROVIDER, KEYED_PROVIDER, HOME_PROVIDER] {
        assert!(
            before.saw(marker),
            "{marker} was delivered as an inherited variable and the engine has to read it, or \
             the shipped launch below is being credited with closing something that was never \
             open. Seen: {seen}"
        );
    }
    assert!(
        before.grants.is_err(),
        "an inherited OPENCODE_SERVER_PASSWORD has to be what the engine's own surface answers to, \
         and the shipped client was answered instead: {:?}. Seen: {seen}",
        before.grants
    );

    let file = tree.inherited(Group::CatalogueFile);
    let (launch, http) = pinned(tree.launch_without_the_closures());
    let before_file = converse(&tree, &engine, &launch, http, &file).await;
    assert!(
        before_file.saw(FILE_PROVIDER),
        "a catalogue file delivered as an inherited OPENCODE_MODELS_PATH has to be the catalogue \
         the engine resolves: {FILE_PROVIDER} is defined nowhere else. Seen: {}",
        before_file.diagnostics()
    );

    let url = tree.inherited(Group::CatalogueUrl);
    let (launch, http) = pinned(tree.launch_without_the_closures());
    let before_url = converse(&tree, &engine, &launch, http, &url).await;
    assert!(
        before_url.saw(URL_PROVIDER),
        "a catalogue served from an inherited OPENCODE_MODELS_URL has to be the catalogue the \
         engine resolves: {URL_PROVIDER} is defined nowhere else. Seen: {}",
        before_url.diagnostics()
    );

    // ---- As it ships: the same two groups again, on the launch this app performs -------------
    //
    // Two launches and not one, because the catalogue decoys mask the credential ones: a launch
    // that resolves its model list from the developer's own catalogue has no `anthropic` in it to
    // authenticate, so `AUTH_PROVIDER` could not appear there whatever the credentials did — and a
    // negative that cannot fail is not evidence.
    let (launch, http) = pinned(tree.launch());
    let after_credentials = converse(&tree, &engine, &launch, http, &credentials).await;
    let seen = after_credentials.diagnostics();
    for marker in [AUTH_PROVIDER, KEYED_PROVIDER, HOME_PROVIDER] {
        assert!(
            !after_credentials.saw(marker),
            "{marker} came from a variable the developer's own environment named, and it reached \
             this profile's model list: this profile is offering what an installation that is not \
             its own provides. Seen: {seen}"
        );
    }
    assert_eq!(
        after_credentials.grants,
        Ok(GrantsReadout::Listed { grants: Vec::new() }),
        "an inherited OPENCODE_SERVER_PASSWORD left the engine's own surface asking for it, so the \
         app's grants page reports an engine it cannot read. Seen: {seen}"
    );

    // The positive without which every negative above would also hold for a launch that had simply
    // stopped reading configuration: the profile's *own* document is still discovered.
    assert!(
        after_credentials.saw(PROFILE_PROVIDER),
        "the profile's own configuration document must still be discovered — otherwise the \
         variables above were not neutralised but the whole configuration surface was closed with \
         them. Seen: {seen}"
    );

    let catalogue = tree.both_catalogue_routes();
    let (launch, http) = pinned(tree.launch());
    let after_catalogue = converse(&tree, &engine, &launch, http, &catalogue).await;
    let seen = after_catalogue.diagnostics();
    for marker in [FILE_PROVIDER, URL_PROVIDER] {
        assert!(
            !after_catalogue.saw(marker),
            "{marker} came from a catalogue the developer's own environment named — a file for one \
             route, a server for the other — and this profile resolved its model list from it. \
             Seen: {seen}"
        );
    }
    assert!(
        after_catalogue.saw(SHIPPED_CATALOGUE),
        "the model list has to come from the catalogue this app ships — or from the real \
         models.dev — and not from a file or a server the developer's own environment named. \
         {SHIPPED_CATALOGUE} is the engine's own provider, which neither decoy catalogue carries. \
         Seen: {seen}"
    );
    assert!(
        after_catalogue.saw(PROFILE_PROVIDER),
        "the profile's own configuration document must still be discovered. Seen: {seen}"
    );
}
