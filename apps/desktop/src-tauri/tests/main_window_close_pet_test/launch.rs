//! The launch: which packaged build may be driven, the environment it runs in, the scratch tree it
//! writes, and the process it becomes.
//!
//! `app_under_test` drives a *packaged* build and nothing else — a `cargo test` build serves
//! `devUrl`, so its window has no close control to click — and a packaged build older than its
//! sources is a skip that names the command rather than a failure. `Launch` is `pub` because the
//! case reads its windows and its process; the fields stay private to this file.

use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::SystemTime;

use crate::support::tool;
use crate::windows::{main_window_on_screen, pet_windows_on_screen, windows_of, Win};

// ---------------------------------------------------------------------------
// The launch
// ---------------------------------------------------------------------------

/// The app under test, launched exactly as a user's launcher would: the same binary, the same
/// environment, and nothing of the developer's own profile in it.
pub struct Launch {
    child: Child,
    display: String,
    xdotool: PathBuf,
    size: (i64, i64),
    log: PathBuf,
}

impl Launch {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn main_window(&self) -> Option<Win> {
        main_window_on_screen(&self.xdotool, &self.display, self.pid(), self.size)
    }

    pub fn pet_windows(&self) -> Vec<Win> {
        pet_windows_on_screen(&self.xdotool, &self.display, self.pid(), self.size)
    }

    pub fn windows(&self) -> Vec<Win> {
        windows_of(&self.xdotool, &self.display, self.pid(), false)
    }

    pub fn try_wait(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// The ids of this process's windows that are on screen — **one** `xdotool` invocation.
    ///
    /// Ids and nothing else, because this is the probe the close below is sampled with and a turn
    /// that also read every window's geometry would be three or four processes instead of one. The
    /// main window's own id is known from the launch, so "is a pet window still up" is a comparison
    /// against a number this case already holds — and a sharper question than the size test
    /// [`pet_windows_on_screen`] asks, since it does not depend on two windows not sharing a size.
    pub fn visible_ids(&self) -> Vec<u64> {
        let listed = match Command::new(&self.xdotool)
            .env("DISPLAY", &self.display)
            .args(["search", "--onlyvisible", "--pid", &self.pid().to_string()])
            .output()
        {
            Ok(output) => output,
            Err(_) => return Vec::new(),
        };
        String::from_utf8_lossy(&listed.stdout)
            .split_whitespace()
            .filter_map(|id| id.parse().ok())
            .collect()
    }

    /// Move the pointer, with the window focused first.
    ///
    /// Focus first because there is no window manager here to give this window the focus a click
    /// would carry on a real desktop; a webview that is not focused is not a webview this test
    /// wants to be asking about clicks. Best effort — `windowfocus` is one more tool than the click
    /// itself needs, and a refusal from it is not a reason to skip the click.
    fn click(&self, window: &Win, dx: i64, dy: i64) -> bool {
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

    /// Click the app's own close button, at the point `ui/TitleBar.vue` draws it.
    ///
    /// The window is undecorated and no window manager is running, so the title bar is the app's
    /// own: a 44 px bar whose last control is a 34x30 button 10 px from the right edge. The centre
    /// is therefore (width - 27, 22) in window coordinates — 7 px of slack on each side of the
    /// button's own box, which is what keeps this from being a pixel-hunt.
    pub fn click_close_button(&self, window: &Win) -> bool {
        self.click(window, window.width - 27, 22)
    }

    pub fn stderr_tail(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Launch {
    fn drop(&mut self) {
        // The red half of this case is a process that never leaves, so this is not a tidiness
        // detail: without it a red run would leave an app holding a private display that is about to
        // be killed anyway, and — worse — the next run's own launch would have to be reasoned about
        // beside a survivor.
        let _ = self.child.kill();
        let _ = self.child.wait();
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

/// Launch the app with nothing to open and no profile of its own: the state a fresh install is in,
/// which is the state the maintainer reported from.
pub fn launch_app(app: &Path, env: &[(String, String)], tree: &Path, log: &Path) -> Launch {
    let file = File::create(log).expect("a log file for a launch");
    let child = Command::new(app)
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
        xdotool: tool("xdotool").expect("checked before the launch"),
        size: declared_size(),
        log: log.to_path_buf(),
    }
}

// ---------------------------------------------------------------------------
// The app's own declarations
// ---------------------------------------------------------------------------

/// The size the config declares for the main window, as integers.
///
/// Read out of the same config the app under test was built with (`generate_context!`), so the
/// identity this file uses for "the main window" is the app's own declaration rather than a number
/// copied into a test.
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

/// `tauri.conf.json`'s default window label — Tauri's own when an entry carries none.
const MAIN_WINDOW: &str = "main";

// ---------------------------------------------------------------------------
// Running where a packaged build stands
// ---------------------------------------------------------------------------

/// The app this case drives — a **packaged** build of this tree, and nothing else.
///
/// A `cargo test` build cannot be driven here, and the reason is not a preference: `tauri`'s
/// `is_dev()` is `!cfg!(feature = "custom-protocol")` (`tauri-2.11.5/src/lib.rs:308`), only
/// `tauri build` turns that feature on, and a development build therefore serves `devUrl`
/// (`http://localhost:1420`) instead of the embedded frontend — its window shows "Could not
/// connect to localhost" and has no close control to click.
///
/// The path is `NEKOWITE_EXIT_APP` when it is set — which is how the *red* half of this case is
/// driven: a build of the same tree with the close arm taken out of `lib.rs`'s `run` callback, which
/// is the build the maintainer's report came from. Else it is the artifact the build step writes
/// (`target/release/nekowite`, after `pnpm --filter @nekowite/desktop exec tauri build`). `None` is
/// a skip that names that command.
///
/// **A packaged build older than the source it would be driving is a skip, not a failure** — the
/// same rule, for the same reason, the two files beside this one state at length: the two are built
/// by different commands at different moments, and a case that drove a stale artifact would report a
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
fn newest_input() -> Option<SystemTime> {
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

/// A scratch tree for one run, inside the build directory.
///
/// The app under test writes a WebKit profile here — a cache, an IndexedDB, the pet's own folder —
/// so this is the one scratch space that is not a few kilobytes, and it belongs under `target/`
/// rather than in `/tmp` for the reason the rest of the build does: this project keeps its bytes in
/// the project folder.
pub fn scratch_tree() -> PathBuf {
    let root = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent()?.parent().map(Path::to_path_buf))
        .unwrap_or_else(std::env::temp_dir);
    let tree = root.join(format!("tmp/main-window-close-pet-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tree);
    for sub in ["home", "config", "data", "cache", "state", "runtime", "tmp"] {
        std::fs::create_dir_all(tree.join(sub)).expect("a scratch tree");
    }
    // WebKit refuses a runtime directory others can read, and the app keeps its sockets under it.
    let _ = fs::set_permissions(tree.join("runtime"), fs::Permissions::from_mode(0o700));
    tree
}
