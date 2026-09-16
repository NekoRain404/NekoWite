//! What the engine actually discovers from the environment `isolated_profile_env` builds.
//!
//! §8.1 casts doubt on the whole idea of a closed profile — 「OpenCode 配置是多层合并，
//! `OPENCODE_CONFIG_DIR` 不是完全隔离开关；必须实测全局配置、父目录、项目 `.opencode`、兼容技能目录和
//! Linux 管理配置的影响」 — and P0's §4 recorded that the claim had never been checked. This
//! file is that check, and it is written to fail if the answer changes in either direction:
//! a surface this host closes reopening, or one it leaves open quietly closing.
//!
//! ## The read-out, and why it is not a guess
//!
//! One decoy per surface: a provider whose id is unique to that surface and nowhere else in
//! the world, carrying exactly one model. `session/new` answers with `configOptions`, whose
//! model selector enumerates every provider the engine resolved from its merged
//! configuration, and it does so before any credential is used — a provider with a
//! placeholder key is still *discovered*, because discovery and authorization are different
//! questions. The same session's `available_commands_update` lists what the skill loader
//! found, which is the read-out for the skill surfaces. Nothing is ever prompted, so this
//! file spends nothing and needs no key.
//!
//! ## What was measured (OpenCode 1.18.29, the pinned artifact)
//!
//! The five roots move the engine's own home and configuration into the profile:
//! `$HOME/.config/opencode`, `$HOME/.opencode`, `$HOME/.claude/skills` and
//! `$HOME/.agents/skills` are all read from inside the profile root, and the decoys planted
//! there are the evidence — they are found precisely because `HOME` points at them. That is
//! the positive control for the redirect: the same decoy at the same relative path disappears
//! when `HOME` is left alone.
//!
//! **The roots did not close the compatible-skill directories on their own, and that was a
//! real leak of the user's own profile.** Beside reading `.claude` and `.agents` under
//! `$HOME`, the engine walks *up* from the working directory — to the worktree, and past it
//! where there is none — reading `skills/**` from every such directory it passes. The walk
//! follows the path, not the environment, so `HOME` cannot reach it. Measured on this machine:
//! the same launch reported 9 commands from a working directory inside a checkout and 43 from
//! one under the home directory, the difference being 38 skills out of the developer's real
//! `~/.claude/skills` — which is also why a live run of this app once reported 41 where
//! another reported 3. A vault anywhere under the user's home directory is enough, and that is
//! the ordinary case for a notes app. `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` is therefore part
//! of [`isolated_profile_env`], and the assertions below fail if it is removed.
//!
//! **The project walk-up is still open, and asserted rather than implied.** The same walk
//! reads a project's `opencode.json` and `.opencode/` directories, so a vault contributes its
//! providers and its permission rules to this profile. `OPENCODE_DISABLE_PROJECT_CONFIG=1`
//! closes that; it is not set, because which project configuration an engine merges is a fact
//! about that engine, and §3.4 keeps those in `adapters/opencode.rs`'s `env_extra` rather than
//! in the engine-agnostic function that builds these roots. The assertions below are what will
//! notice the day that decision is made.
//!
//! `/etc/opencode` is the one surface no supported switch closes: the engine resolves it as
//! Linux's managed configuration root and merges `opencode.json`/`opencode.jsonc` from it at
//! global precedence. It does not exist on this machine, so what the control launch proves is
//! only that the code path is live and reachable — `OPENCODE_TEST_MANAGED_CONFIG_DIR` moves
//! the root and the decoy appears. The engine offers no way to turn it off, and turning it
//! off through that test hook would be this app overriding an administrator's policy.
//!
//! Re-run the probes under `.tmp-isolation/` after an engine upgrade: the assertions here are
//! deliberately exact, so a version that changes its discovery rules fails loudly rather than
//! silently widening what this profile reads.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nekowite_lib::agent_runtime::{env_pairs, isolated_profile_env, EngineLaunch};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// The artifact the app ships. Gitignored and produced by the packaging pipeline, so a
/// checkout without it skips rather than fails — the same rule the runtime's real-engine test
/// follows.
const ENGINE: &str = "binaries/opencode-x86_64-unknown-linux-gnu";

/// Long enough for a cold `session/new`, which resolves the model catalog; short enough that
/// a genuine hang is a failure rather than a suite timeout.
const PATIENCE: Duration = Duration::from_secs(120);

/// Provider ids, one per surface. These are the vocabulary the assertions and the module
/// comment share, and nothing else on this machine defines them.
const GLOBAL_CONFIG: &str = "nwk-decoy-global-config";
const HOME_DOT_OPENCODE: &str = "nwk-decoy-home-dot-opencode";
const CONFIG_DIR: &str = "nwk-decoy-config-dir";
const MANAGED: &str = "nwk-decoy-managed";
const PROJECT_FILE: &str = "nwk-decoy-project-file";
const PROJECT_DOT_OPENCODE: &str = "nwk-decoy-project-dot-opencode";
const PARENT_FILE: &str = "nwk-decoy-parent-file";
const PARENT_DOT_OPENCODE: &str = "nwk-decoy-parent-dot-opencode";
const GRANDPARENT_FILE: &str = "nwk-decoy-grandparent-file";
const GRANDPARENT_DOT_OPENCODE: &str = "nwk-decoy-grandparent-dot-opencode";

/// Skill names, the read-out for the skill loader. Two of them sit under the redirected
/// home, where the compatibility scans look; the rest sit along the project walk-up.
const HOME_CLAUDE_SKILL: &str = "nwk-decoy-home-claude";
const HOME_AGENTS_SKILL: &str = "nwk-decoy-home-agents";
const PROJECT_SKILL: &str = "nwk-decoy-project-skill";
const PROJECT_CLAUDE_SKILL: &str = "nwk-decoy-project-claude";
const PROJECT_AGENTS_SKILL: &str = "nwk-decoy-project-agents";
const PARENT_CLAUDE_SKILL: &str = "nwk-decoy-parent-claude";

/// A decoy tree, rooted inside the repository.
///
/// Inside the repository and not in `/tmp` for one reason: the engine's project walk stops at
/// the worktree, so a tree outside the checkout would not be walked at all and the decoys
/// beside the working directory would prove nothing.
struct DecoyTree {
    root: PathBuf,
}

impl DecoyTree {
    /// Removes any earlier run's tree and plants a fresh one. A decoy left over from a
    /// previous run is indistinguishable from one this run planted, which is the one way this
    /// file could agree with itself and still be wrong.
    fn plant(label: &str) -> Self {
        let repo = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .expect("the repository root");
        let root = repo.join(".tmp-isolation-run").join(label);
        let _ = fs::remove_dir_all(&root);
        let tree = Self { root };
        tree.write_all();
        tree
    }

    /// `$HOME`, exactly as [`isolated_profile_env`] spells it: the variable's own name as the
    /// directory's, one level under the profile root. Reading the layout off the function rather
    /// than repeating it here is the point — a test that invented `.config/opencode` would be
    /// measuring a home the app never sets, which is a mistake this file made once already.
    fn home(&self) -> PathBuf {
        self.root.join("HOME")
    }

    /// `$XDG_CONFIG_HOME`, where the engine's global configuration root lives.
    fn config_home(&self) -> PathBuf {
        self.root.join("XDG_CONFIG_HOME")
    }

    /// `cwd/../..` is `root/case`, `cwd/..` is `root/case/parent`, and `cwd` is the workspace:
    /// all three levels the walk-up reaches before it leaves the checkout.
    fn cwd(&self) -> PathBuf {
        self.root.join("case/parent/workspace")
    }

    fn case(&self) -> PathBuf {
        self.root.join("case")
    }

    fn parent(&self) -> PathBuf {
        self.root.join("case/parent")
    }

    fn write_all(&self) {
        let json = |id: &str| decoy_config(id);
        let skill = |name: &str| decoy_skill(name);
        let at = |path: PathBuf, body: String| {
            fs::create_dir_all(path.parent().expect("a parent")).expect("decoy directory");
            fs::write(path, body).expect("decoy file");
        };

        let home = self.home();
        at(
            self.config_home().join("opencode/opencode.json"),
            json(GLOBAL_CONFIG),
        );
        at(home.join(".opencode/opencode.json"), json(HOME_DOT_OPENCODE));
        at(
            home.join(format!(".claude/skills/{HOME_CLAUDE_SKILL}/SKILL.md")),
            skill(HOME_CLAUDE_SKILL),
        );
        at(
            home.join(format!(".agents/skills/{HOME_AGENTS_SKILL}/SKILL.md")),
            skill(HOME_AGENTS_SKILL),
        );

        // The injected root and the managed root are planted but never injected by this host;
        // the control launch is what reaches them.
        at(self.root.join("config-dir/opencode.json"), json(CONFIG_DIR));
        at(self.root.join("managed/opencode.json"), json(MANAGED));

        let cwd = self.cwd();
        at(cwd.join("opencode.json"), json(PROJECT_FILE));
        at(cwd.join(".opencode/opencode.json"), json(PROJECT_DOT_OPENCODE));
        at(
            cwd.join(format!(".opencode/skill/{PROJECT_SKILL}/SKILL.md")),
            skill(PROJECT_SKILL),
        );
        at(
            cwd.join(format!(".claude/skills/{PROJECT_CLAUDE_SKILL}/SKILL.md")),
            skill(PROJECT_CLAUDE_SKILL),
        );
        at(
            cwd.join(format!(".agents/skills/{PROJECT_AGENTS_SKILL}/SKILL.md")),
            skill(PROJECT_AGENTS_SKILL),
        );

        let parent = self.parent();
        at(parent.join("opencode.json"), json(PARENT_FILE));
        at(parent.join(".opencode/opencode.json"), json(PARENT_DOT_OPENCODE));
        at(
            parent.join(format!(".claude/skills/{PARENT_CLAUDE_SKILL}/SKILL.md")),
            skill(PARENT_CLAUDE_SKILL),
        );

        let case = self.case();
        at(case.join("opencode.json"), json(GRANDPARENT_FILE));
        at(case.join(".opencode/opencode.json"), json(GRANDPARENT_DOT_OPENCODE));
    }

    /// The launch the app performs today, as `EnvPolicy::ProfileIsolated` builds it: the roots
    /// and nothing else.
    fn launch(&self) -> EngineLaunch {
        EngineLaunch {
            program: PathBuf::new(),
            args: vec!["acp".to_string()],
            // The *root*, not the home: the function forms each variable's value by joining the
            // variable's own name onto what it is given, so passing `home()` here would ask the
            // engine for `$HOME/HOME`.
            env: env_pairs(isolated_profile_env(&self.root)),
            ca_bundle: None,
        }
    }

    /// The launch that makes every negative in the production launch a statement about
    /// discovery rather than about where a decoy happens to sit.
    ///
    /// Two of the negatives are "this host never points the engine here", and the engine's own
    /// variables are what point it: `OPENCODE_CONFIG_DIR` for the injected root and
    /// `OPENCODE_TEST_MANAGED_CONFIG_DIR` for the managed one, the latter being the only way to
    /// reach `/etc/opencode` on a machine that does not have one.
    ///
    /// The third is "this host switched the scan off", and undoing the switch is what proves it:
    /// with `OPENCODE_DISABLE_EXTERNAL_SKILLS=0` the `.claude` and `.agents` decoys have to come
    /// back. If they do not, the production launch's silence about them was never evidence that
    /// the switch works — it would mean the engine stopped looking there for some other reason.
    fn control_launch(&self) -> EngineLaunch {
        let mut launch = self.launch();
        launch.env.extend(env_pairs([
            (
                "OPENCODE_CONFIG_DIR".to_string(),
                self.root.join("config-dir").to_string_lossy().into_owned(),
            ),
            (
                "OPENCODE_TEST_MANAGED_CONFIG_DIR".to_string(),
                self.root.join("managed").to_string_lossy().into_owned(),
            ),
            ("OPENCODE_DISABLE_EXTERNAL_SKILLS".to_string(), "0".to_string()),
        ]));
        launch
    }
}

fn decoy_config(provider_id: &str) -> String {
    serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            provider_id: {
                "npm": "@ai-sdk/openai-compatible",
                "name": provider_id,
                "options": { "baseURL": "http://127.0.0.1:9/v1", "apiKey": "placeholder" },
                "models": { format!("{provider_id}-model"): { "name": format!("{provider_id}-model") } },
            }
        }
    })
    .to_string()
}

fn decoy_skill(name: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: Decoy planted by the §8.1 isolation measurement.\n---\n\n# {name}\n"
    )
}

/// Everything the engine said, as one searchable block.
///
/// The stderr is kept for one reason: this file's assertions are mostly about things that were
/// **not** discovered, and an engine that failed to start, lost its transport or rejected
/// `session/new` produces exactly the same silence as an engine that looked and found nothing.
/// Without the diagnostics below, a transport failure would be reported as an isolation
/// regression — the one misattribution this file must not make, since the whole point is that
/// "not discovered" and "never looked for" are different facts.
struct Readout {
    frames: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<String>>,
}

impl Readout {
    fn text(&self) -> String {
        self.frames.lock().unwrap().join("\n")
    }

    /// Whether a marker reached the wire. Searching the whole transcript rather than one
    /// predicted field is deliberate: a surface the engine admits to through some other
    /// notification is still a surface it read, and a test that only looked at the model list
    /// would call that closed.
    fn saw(&self, marker: &str) -> bool {
        self.text().contains(marker)
    }

    /// Whether `session/new` came back with a session rather than an error.
    fn session_opened(&self) -> bool {
        self.text().contains("sessionId")
    }

    /// The last few lines the engine wrote about itself. Bounded, because a failure message
    /// that is longer than the failure is not a message.
    fn stderr_tail(&self) -> String {
        let text = self.stderr.lock().unwrap();
        let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
        let start = lines.len().saturating_sub(6);
        lines[start..].join("\n    ")
    }

    /// Everything a reader needs when an assertion about *absence* fires: what was seen, what
    /// the engine said, and whether the session it is being judged on ever existed.
    fn diagnostics(&self) -> String {
        let stderr = self.stderr_tail();
        format!(
            "session opened: {}, commands frame: {}, markers seen: {}, engine stderr:\n    {}",
            self.session_opened(),
            self.text().contains("available_commands_update"),
            self.summarise(),
            if stderr.is_empty() { "(none)" } else { &stderr },
        )
    }

    /// The message a failed assertion should carry: which markers were seen, so a failure
    /// reads as a list rather than as one missing string.
    fn summarise(&self) -> String {
        let text = self.text();
        let mut seen: Vec<&str> = [
            GLOBAL_CONFIG, HOME_DOT_OPENCODE, CONFIG_DIR, MANAGED, PROJECT_FILE,
            PROJECT_DOT_OPENCODE, PARENT_FILE, PARENT_DOT_OPENCODE, GRANDPARENT_FILE,
            GRANDPARENT_DOT_OPENCODE, HOME_CLAUDE_SKILL, HOME_AGENTS_SKILL, PROJECT_SKILL,
            PROJECT_CLAUDE_SKILL, PROJECT_AGENTS_SKILL, PARENT_CLAUDE_SKILL,
        ]
        .into_iter()
        .filter(|marker| text.contains(marker))
        .collect();
        seen.sort_unstable();
        format!("{seen:?}")
    }
}

/// Runs one engine to a session and returns everything it said.
///
/// The environment is not assembled here: it is read back out of
/// [`EngineLaunch::agent_config`], which is the description the runtime hands `execve`. A test
/// that spelled the variables out again would be measuring its own copy of them.
async fn converse(tree: &DecoyTree, engine: &Path, launch: &EngineLaunch) -> Readout {
    let described = serde_json::to_value(launch.agent_config()).expect("the launch serializes");
    let env = described["env"].as_object().expect("the launch's env").clone();

    let mut command = tokio::process::Command::new(engine);
    command
        .arg("acp")
        .current_dir(tree.cwd())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Drained on its own task rather than dropped: the engine narrates its own failures
        // here, the diagnostics above are built from it, and a pipe nobody reads would block
        // the engine on its own logging — which would be a hang invented by the test.
        .stderr(Stdio::piped());
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

    // Kept whole rather than bounded here: a real engine's chatter is what a failure needs,
    // and `stderr_tail` is what keeps it from overflowing the message.
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
    let send = |message: serde_json::Value| {
        format!("{message}\n").into_bytes()
    };
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
    // Both read-outs, and both are needed: the model selector is the configuration answer,
    // the command list is the skill answer, and they arrive as separate frames. Each is waited
    // on as a condition — there is no fixed sleep anywhere in this file, because a duration
    // that is long enough on an idle machine is a different duration on a loaded one, and this
    // file's answers must not depend on which.
    let readout = Readout {
        frames: Arc::clone(&frames),
        stderr: Arc::clone(&stderr),
    };
    // Two preconditions asserted before any question about discovery is asked. Without them a
    // broken transport reads as a closed surface: the "must be discovered" assertions would
    // fail and the "must not be discovered" ones would pass, which is a green-looking test
    // reporting an isolation result that was never measured.
    assert!(
        wait_for(&frames, "sessionId", PATIENCE).await,
        "the engine never opened a session, so nothing below measured discovery at all. \
         {}\n    engine stderr:\n    {}",
        readout.summarise(),
        readout.stderr_tail()
    );
    assert!(
        wait_for(&frames, "available_commands_update", PATIENCE).await,
        "the engine opened a session but never sent its command list, so every claim below \
         about which skills were discovered would be a claim about a frame that never arrived. \
         {}",
        readout.diagnostics()
    );

    let _ = child.kill().await;
    readout
}

async fn wait_for(frames: &Arc<Mutex<Vec<String>>>, needle: &str, patience: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + patience;
    loop {
        if frames.lock().unwrap().iter().any(|line| line.contains(needle)) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The measurement, in one test: the two launches have to agree about what the roots close,
/// and the control has to disagree about what they do not reach.
///
/// One test rather than several because the engine is the expensive part and two of these
/// assertions are only meaningful next to each other — a negative in the first launch is
/// evidence only because the second launch finds the same decoy.
#[tokio::test]
async fn the_roots_close_the_engine_home_and_the_walk_up_stays_open() {
    let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join(ENGINE);
    if !engine.is_file() {
        eprintln!("SKIP: {} is absent; run scripts/fetch-opencode-linux.sh", engine.display());
        return;
    }

    let tree = DecoyTree::plant(&format!("profile-isolation-{}", std::process::id()));

    // ---- What the app launches today -------------------------------------------------
    let readout = converse(&tree, &engine, &tree.launch()).await;
    // Every failure below carries what was seen, what the engine said about itself, and
    // whether there was a session at all — so a failure that came from the transport cannot
    // be mistaken for one that came from the isolation.
    let seen = readout.diagnostics();

    // Closed: the engine's own home and configuration are read from inside the profile root.
    // These decoys are found *because* `HOME` and `XDG_CONFIG_HOME` point at them, which is
    // also the positive control for the redirect — the same files under the developer's real
    // home are not reachable from this launch.
    for marker in [GLOBAL_CONFIG, HOME_DOT_OPENCODE] {
        assert!(
            readout.saw(marker),
            "{marker} is inside the profile root that HOME/XDG point at and must be discovered; \
             the redirect is broken. Seen: {seen}"
        );
    }

    // Open, and asserted rather than implied: the project configuration walk-up is the part
    // §8.1 warned about. See the module comment for the variable that closes it and the file
    // it belongs in.
    for marker in [
        PROJECT_FILE, PROJECT_DOT_OPENCODE, PARENT_FILE, PARENT_DOT_OPENCODE,
        GRANDPARENT_FILE, GRANDPARENT_DOT_OPENCODE, PROJECT_SKILL,
    ] {
        assert!(
            readout.saw(marker),
            "the project configuration walk-up is measured open; if it has been closed on \
             purpose, the module comment and this assertion move together. Missing: {marker}. \
             Seen: {seen}"
        );
    }

    // Closed, and this is the leak the measurement found: not a vault's configuration but the
    // user's *own* `.claude` and `.agents` directories, reached by a walk that follows the
    // path rather than the environment. Every one of these was discovered before
    // `OPENCODE_DISABLE_EXTERNAL_SKILLS` joined the launch.
    for marker in [
        HOME_CLAUDE_SKILL, HOME_AGENTS_SKILL, PROJECT_CLAUDE_SKILL, PROJECT_AGENTS_SKILL,
        PARENT_CLAUDE_SKILL,
    ] {
        assert!(
            !readout.saw(marker),
            "{marker} sits under a `.claude` or `.agents` directory the engine scans while \
             walking up from the working directory, and that walk reaches the user's real home \
             directory whenever a vault lives under it. It must not be discovered. Seen: {seen}"
        );
    }

    // Not reached by this launch at all. The control below is what makes that a statement
    // about discovery rather than about the decoy's location.
    for marker in [CONFIG_DIR, MANAGED] {
        assert!(
            !readout.saw(marker),
            "{marker} came from a directory this host never injects, so the profile read \
             something it was not given. Seen: {seen}"
        );
    }

    // ---- The control: every negative above, made falsifiable --------------------------
    //
    // One launch, three negatives undone: the two directories this host never points the
    // engine at, and the scan this host switches off. Without it, "not discovered" and "never
    // looked for" would be the same observation, which is the distinction §8.1 is about.
    let control = converse(&tree, &engine, &tree.control_launch()).await;
    let control_seen = control.diagnostics();
    for marker in [CONFIG_DIR, MANAGED] {
        assert!(
            control.saw(marker),
            "the control launch pointed the engine at {marker} and it was still not found, so \
             the first launch's negative proved nothing about that surface — either the decoy \
             is not where that engine version looks, or the switch has stopped being honoured. \
             Seen: {control_seen}"
        );
    }
    for marker in [HOME_CLAUDE_SKILL, PROJECT_CLAUDE_SKILL, PARENT_CLAUDE_SKILL] {
        assert!(
            control.saw(marker),
            "with the external-skill scan turned back on, {marker} has to be discovered — \
             otherwise the first launch's silence about it was not the switch working, and the \
             leak it closes was never actually closed by it. Seen: {control_seen}"
        );
    }
}
