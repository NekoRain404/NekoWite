//! The launch: the app under test, the environment it runs in, and the scratch tree it writes.
//! `app_under_test` drives a *packaged* build and nothing else — a `cargo test` build serves
//! `devUrl`, so its window has no rail to open — and a packaged build older than its sources is a skip
//! that names the command rather than a failure. `Launch` carries the engine pids it saw so a failing
//! case does not leave them on the machine; its `Drop` kills only those, by pid, because matching on
//! the program's name would reach the developer's own running app.

use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::SystemTime;

use crate::process::{alive, Proc};
use crate::support::MAIN_WINDOW;
use crate::windows::{main_window_on_screen, windows_of, Win};

// ---------------------------------------------------------------------------
// The app's own declarations
// ---------------------------------------------------------------------------

/// The size the config declares for the main window, as integers.
pub fn declared_size() -> (i64, i64) {
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!())
        .expect("the app's own tauri.conf.json builds a context");
    let window = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .expect("the config declares the main window");
    (window.width as i64, window.height as i64)
}

/// The bundle identifier the app keeps its own files under.
///
/// `app_config_dir` and `app_data_dir` are both `dirs::config_dir()`/`dirs::data_dir()` joined with
/// this (`tauri-2.11.5/src/path/desktop.rs:238-248`), so it is what turns the scratch `XDG_*`
/// directories into the two folders this case has to write into.
pub fn declared_identifier() -> String {
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!())
        .expect("the app's own tauri.conf.json builds a context");
    app.config().identifier.clone()
}

// ---------------------------------------------------------------------------
// The launch
// ---------------------------------------------------------------------------

/// The app under test, launched exactly as a user's launcher would: the same binary, the same
/// environment, and nothing of the developer's own profile in it.
pub struct Launch {
    child: Child,
    display: String,
    xdotool: PathBuf,
    pub size: (i64, i64),
    log: PathBuf,
    /// The engine processes seen while this app ran, so a failure below — which is exactly the red
    /// half of this case — does not leave them running on the machine.
    pub engines: Vec<Proc>,
}

impl Launch {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn main_window(&self) -> Option<Win> {
        main_window_on_screen(&self.xdotool, &self.display, self.pid(), self.size)
    }

    pub fn windows(&self) -> Vec<Win> {
        windows_of(&self.xdotool, &self.display, self.pid(), false)
    }

    /// The app's windows that are on screen. GTK keeps a 10x10 helper window of its own that the
    /// unfiltered search finds and this one does not; the pet's two are on screen when they exist,
    /// which is what makes this the reading the precondition below needs.
    pub fn visible_windows(&self) -> Vec<Win> {
        windows_of(&self.xdotool, &self.display, self.pid(), true)
    }

    pub fn try_wait(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Move the pointer, with the window focused first.
    ///
    /// Focus first because there is no window manager here to give this window the focus a click
    /// would carry on a real desktop; a webview that is not focused is not a webview this test
    /// wants to be asking about clicks. Best effort — `windowfocus` is one more tool than the click
    /// itself needs, and a refusal from it is not a reason to skip the click.
    pub fn click(&self, window: &Win, dx: i64, dy: i64) -> bool {
        let _ = Command::new(&self.xdotool)
            .env("DISPLAY", &self.display)
            .args(["windowfocus".to_string(), window.id.to_string()])
            .status();
        Command::new(&self.xdotool)
            .env("DISPLAY", &self.display)
            .args([
                "mousemove".to_string(),
                (window.x + dx).to_string(),
                (window.y + dy).to_string(),
                "click".to_string(),
                "1".to_string(),
            ])
            .status()
            .is_ok_and(|status| status.success())
    }

    /// Open the agent rail, which is the gesture that starts an engine.
    ///
    /// `AppShell.vue` puts the toggle in the status bar's action slot, second from the right end:
    /// the bar is `--app-statusbar-height` (35 px) tall with a 14 px gutter, and the two controls
    /// after the view switch are 24x22 buttons 8 px apart (`styles/components.css`'s `.status-btn`),
    /// so the toggle's centre is 58 px from the right edge and the bar's own centre is 17 px from
    /// the bottom. The window is undecorated, so its geometry is the page's.
    ///
    /// Clicked once, on purpose: the runtime is started on demand when the switch is on, a vault is
    /// open **and the rail is drawn** (`app/agent-rail-attachment.ts`), and a second click would
    /// close the rail it just opened — whose close is queued behind the start.
    pub fn open_agent_rail(&self, window: &Win) -> bool {
        self.click(window, window.width - 58, window.height - 17)
    }

    /// Click the app's own close button, at the point `ui/TitleBar.vue` draws it.
    ///
    /// The window is undecorated and no window manager is running, so the title bar is the app's
    /// own: a 44 px bar whose last control is a 34x30 button 10 px from the right edge. The centre
    /// is therefore (width - 27, 22) in window coordinates — 7 px of slack on each side of the
    /// button's own box, which is what keeps this from being a pixel-hunt. Closing the last window
    /// is what runs the event loop down to `RunEvent::Exit`.
    pub fn click_close_button(&self, window: &Win) -> bool {
        self.click(window, window.width - 27, 22)
    }

    pub fn stderr_tail(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Launch {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // The engine is in a process group of its own (`process_group(0)` in the SDK's spawn), so
        // it is not in this process's group and killing the app does not reach it. Only what this
        // launch was seen to start is killed, by the pid this case recorded: matching on the
        // program's name would kill the engine of the developer's own running app.
        for engine in &self.engines {
            if !alive(*engine) {
                continue;
            }
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", engine.pid)])
                .status();
            let _ = Command::new("kill")
                .args(["-KILL", &engine.pid.to_string()])
                .status();
        }
    }
}
/// The environment a launch runs in: this test's display, this test's bus, and a scratch tree.
pub fn launch_environment(tree: &Path, display: &str, bus: &str) -> Vec<(String, String)> {
    let dir = |name: &str| tree.join(name).to_string_lossy().to_string();
    vec![
        ("DISPLAY".into(), display.into()),
        ("DBUS_SESSION_BUS_ADDRESS".into(), bus.into()),
        ("HOME".into(), dir("home")),
        ("XDG_CONFIG_HOME".into(), dir("config")),
        ("XDG_DATA_HOME".into(), dir("data")),
        ("XDG_CACHE_HOME".into(), dir("cache")),
        ("XDG_STATE_HOME".into(), dir("state")),
        ("XDG_RUNTIME_DIR".into(), dir("runtime")),
        ("TMPDIR".into(), dir("tmp")),
        // X11 is what an Xvfb can serve; the renderer's dmabuf path needs a compositor this server
        // does not have, and `NO_AT_BRIDGE` is the accessibility bus this private session has no
        // daemon for.
        ("GDK_BACKEND".into(), "x11".into()),
        ("WEBKIT_DISABLE_DMABUF_RENDERER".into(), "1".into()),
        ("NO_AT_BRIDGE".into(), "1".into()),
    ]
}
/// Launch the app on a note, the way a file manager opens one: a path among its arguments.
///
/// The argument matters twice over — it is the file the window opens, and (through the
/// remembered-vault record written before this call) the vault the app is in when the rail opens.
pub fn launch_app(
    app: &Path,
    xdotool: &Path,
    note: &Path,
    env: &[(String, String)],
    tree: &Path,
    log: &Path,
) -> Launch {
    let file = File::create(log).expect("a log file for a launch");
    let child = Command::new(app)
        .arg(note)
        .envs(env.iter().map(|(k, v)| (k.clone(), v.clone())))
        .current_dir(tree)
        .stdin(Stdio::null())
        .stdout(Stdio::from(file.try_clone().expect("a second handle")))
        .stderr(Stdio::from(file))
        .spawn()
        .expect("the app binary this test was built beside runs");
    Launch {
        child,
        display: env
            .iter()
            .find(|(k, _)| k == "DISPLAY")
            .map(|(_, v)| v.clone())
            .expect("the environment carries a display"),
        xdotool: xdotool.to_path_buf(),
        size: declared_size(),
        log: log.to_path_buf(),
        engines: Vec::new(),
    }
}
/// The app this case drives — a **packaged** build of this tree, and nothing else.
///
/// A `cargo test` build cannot be driven here, and the reason is not a preference: `tauri`'s
/// `is_dev()` is `!cfg!(feature = "custom-protocol")` (`tauri-2.11.5/src/lib.rs:308`), only
/// `tauri build` turns that feature on, and a development build therefore serves `devUrl`
/// (`http://localhost:1420`) instead of the embedded frontend — its window shows "Could not
/// connect to localhost" and has no rail to open.
///
/// The path is `NEKOWITE_EXIT_APP` when it is set — which is how the *red* half of this case is
/// driven: a build carrying the same tree with the `RunEvent::Exit` arm taken out — else the
/// artifact the build step writes (`target/release/nekowite`, after `pnpm --filter
/// @nekowite/desktop exec tauri build`). `None` is a skip that names that command.
///
/// **A packaged build older than the source it would be driving is a skip, not a failure** — the
/// rule `main_window_close_pet_test.rs` defers to this target for, and which
/// `main_window_relaunch_test.rs` stated too before `e326a8b` deleted it: the two are built by
/// different commands at different moments, and a case that drove a stale artifact would report a
/// red gate about a binary nobody asked it to test. An explicit `NEKOWITE_EXIT_APP` is taken as it
/// is — naming a path is asking for that binary.
pub fn app_under_test() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NEKOWITE_EXIT_APP") {
        return Some(PathBuf::from(path));
    }
    let target = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent()?.parent().map(Path::to_path_buf))?;
    let packaged = target.join("release/nekowite");
    let Ok(package) = std::fs::metadata(&packaged).and_then(|meta| meta.modified()) else {
        return None;
    };
    (package >= newest_input()?).then_some(packaged)
}

/// The newest file the packaged binary is built from, or `None` when the tree cannot be read.
///
/// `target/` and `gen/` are outputs that live in the source tree and would always be newest — the
/// first is the build itself, the second is rewritten by the build script on every run, including
/// the one `cargo test` does — so neither is an input here. `tests/` is not an input of the app
/// binary either: a case that edited itself would otherwise skip its own subject.
pub fn newest_input() -> Option<SystemTime> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut newest = None;
    let mut pending = vec![root];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).ok()? {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_dir() {
                if !matches!(name.as_str(), "target" | "gen" | "tests" | "binaries") {
                    pending.push(path);
                }
                continue;
            }
            let is_input = name.ends_with(".rs") || name.ends_with(".json") || name == "Cargo.toml";
            if is_input {
                newest = std::cmp::max(newest, entry.metadata().ok()?.modified().ok());
            }
        }
    }
    newest
}
/// The pet's `general` record with both window switches off, as the store's own shape.
///
/// Written to `<XDG_DATA_HOME>/<identifier>/desktop-pet/settings/general.json` — the path
/// `desktop_pet/settings/store.rs` builds from the app's data directory and the domain's id, and
/// the shape `PetSettingsRecord` reads: the schema version this build writes, a revision, and the
/// domain's values. The two switches are the whole of it: `enabled` is derived from them
/// (`settings/values.rs`), and every other field takes its own default.
///
/// A record this build cannot read is not a record — the store reads it as `defaults`, which is the
/// pet *on* — so a mistake here shows up as a pet window at the close, not as a silent difference.
pub fn pet_off_record() -> String {
    serde_json::json!({
        "domain": "general",
        "schemaVersion": 4,
        "revision": 0,
        "values": { "enabled": false, "ball": false, "characterWindow": false },
    })
    .to_string()
}
/// A scratch tree for one run, inside the build directory.
///
/// The app under test writes a WebKit profile here, so this belongs under `target/` rather than in
/// `/tmp` for the reason the rest of the build does: this project keeps its bytes in the project
/// folder.
pub fn scratch_tree() -> PathBuf {
    let root = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent()?.parent().map(Path::to_path_buf))
        .unwrap_or_else(std::env::temp_dir);
    let tree = root.join(format!("tmp/agent-exit-teardown-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tree);
    for sub in ["home", "config", "data", "cache", "state", "runtime", "tmp"] {
        std::fs::create_dir_all(tree.join(sub)).expect("a scratch tree");
    }
    // WebKit refuses a runtime directory others can read, and the app keeps its sockets under it.
    let _ = fs::set_permissions(tree.join("runtime"), fs::Permissions::from_mode(0o700));
    tree
}
