//! Closing the main window takes the pet — and the process — with it.
//!
//! **The report this answers.** The maintainer's words: 「我发现软件退出的时候桌宠没有退出，要一起退出的」.
//! `main_window.rs`'s header already names the state and names it as the reason that module exists:
//! the main window is *destroyed* when the user closes it, and **the process does not end with it
//! whenever the pet is on** — the wry runtime exits only when its window map empties
//! (`tauri-runtime-wry-2.11.4/src/lib.rs:4310-4322`), and the pet's windows are in that map. So a
//! closed main window was a process that still held the single-instance D-Bus name, still ran the
//! engine and the watchers, and had nothing to show.
//!
//! **What this case measures.** Three things, at three moments, read off the X server and the process
//! table rather than inferred from one another: the main window gone, **the pet's windows gone**, and
//! **the process gone**. The third is the one that matters. A pet window that disappears while the
//! process runs on is the reported bug in a new coat, and this case would not be able to tell that
//! from the fix if it only ever asked whether the screen was empty.
//!
//! **How the reading is made to be able to fail.** With the main window's close and no arm in
//! `lib.rs`'s `run` callback, the pet survives and the process runs on forever — there is nothing
//! else in this app that would ever close those windows, and no timer behind them. So the red half of
//! this case is not a mutant built to fail: it is the behaviour the maintainer reported, and the
//! `NEKOWITE_EXIT_APP` arm below is how a build of the same tree without the arm is driven — the same
//! variable, for the same purpose, that `agent_exit_teardown_test.rs` uses.
//!
//! **What the two builds did, measured.** Seven runs against a packaged build of this tree carrying
//! the arm, and three against the same tree with the arm taken out — both built by the same command
//! (`tauri build --no-bundle`) from a `lib.rs` that differs by that block and nothing else. With the
//! arm every run ended the same way: the pet's two windows (`pet-ball` and the character window —
//! 200x200 and 260x320 as the X server had them, against a main window of the declared 1280x820) and
//! the process were all gone **0.11-1.04s** after the close was clicked, with `ExitStatus(0)`.
//! Without it every run ended the other way: the main window went, and ten seconds later **the pet's
//! two windows were still on the screen and the process was still running**, three times out of
//! three. That is the maintainer's report reproduced on demand, and it is what makes the green half
//! a reading rather than a ritual.
//!
//! **What the timings do not separate, stated rather than glossed.** Each turn of the loop below asks
//! the process whether it is alive, asks the X server whether a pet window is up, and asks the
//! process again — one `xdotool` invocation, ten milliseconds or so. In every run the pet's windows
//! were already gone on the first turn where the process was also gone, so this case cannot say
//! whether the arm destroyed them or whether the process left and X destroyed them with it (X takes a
//! client's windows when its connection closes). It does not need to: the arm's only act is
//! `PetWindowHost::disable`, the wry runtime leaves only when its window map is empty, and the red
//! half shows the process never leaves when that act is absent — the wall is closed from both sides
//! even though the millisecond in the middle is not resolved here. The reading this case is *for* is
//! the last one, and it is unambiguous: nothing survives the close but nothing at all.
//!
//! **Why the pet is on here and off there.** `agent_exit_teardown_test.rs` measures the *engine* on a
//! quit, and turns the pet off through `desktop-pet/settings/general.json` so that the main window is
//! the last one and its close is the whole quit. That is exactly the state this case must not be in:
//! what it measures is what the pet's own windows do to the quit. So this launch writes **no pet
//! record at all**, which is the pet *on* — `pet-contracts/config.ts`'s `PET_SETTINGS_DEFAULTS` is
//! `{ enabled: true, ball: true, characterWindow: true }`, and a record this build cannot read is
//! read as those defaults.
//!
//! **Why a file of its own rather than a second case in that one.** The two cases would run
//! concurrently — `cargo test` runs the tests of one binary on threads of one process — and
//! `PrivateDisplay` picks its display number from `std::process::id()`. Two cases in one binary
//! therefore ask for the *same* display, and the second finds the first's server already answering
//! with the right geometry, so the two apps would share one server and one pointer and each would
//! click into the other's window. A separate test target is a separate process and a separate number,
//! which is the same guarantee `main_window_relaunch_test.rs` already relies on. What is duplicated
//! with those two files is the launch scaffolding, and that duplication is this suite's existing
//! convention rather than a new one.
//!
//! **One consequence of the arm, measured here and left for the arm's author.** With the arm in the
//! tree, `main_window_relaunch_test.rs` does not fail — it **hangs**, which matters because it is one
//! of the 76 targets `cargo test` runs. That case asserts the *first* process outlives its main window
//! (`first.is_running()`, its `:552`), and then waits on the second launch with `Command::status()`.
//! With the arm the first process leaves with its window, so the second launch claims the
//! single-instance name and keeps running as an ordinary app, and that `status()` never returns.
//! Measured: with the arm the case was still blocked after ten minutes with the second instance alive
//! under the test binary; against a build of the same tree with the arm taken out, the same case is
//! green in 7.63s. The state that file was written for — a process with no window to bring back — no
//! longer occurs once the close ends the process, so it is that file's premise that has moved, not its
//! assertions. Retiring or rewriting it is a decision about that file; nothing here touches it.
//!
//! **What it does not cover.** No window manager, so "gone" is the X server's own reading of a
//! destroyed window rather than a compositor's; and the close is a programmatic click at the point
//! the app's stylesheet draws its close button, not a human's. What it does cover is every hop that
//! matters: the packaged binary of this tree, a private X server and session bus, the pet's own
//! windows opened by the app from its own defaults, the app's own close control, and the process
//! table afterwards.
//!
//! **Runs where a packaged build is standing.** A build older than its sources is a skip that names
//! the command, for the reason `agent_exit_teardown_test.rs` states at length.

#![cfg(target_os = "linux")]

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime};

/// How long one launch may take to put its main window up.
const LAUNCH_DEADLINE: Duration = Duration::from_secs(45);

/// How long the pet's own windows may take to appear beside it.
///
/// Not incidental to the case: the pet is what keeps the process alive after the main window is
/// destroyed, so a launch whose pet never came up would be measuring a different app. One RPC that
/// ends by opening two webview windows, so this is generous for the same reason `LAUNCH_DEADLINE` is.
const PET_DEADLINE: Duration = Duration::from_secs(45);

/// How long one click may take to be followed by the main window's disappearance.
const CLOSE_SETTLE: Duration = Duration::from_secs(4);

/// How many times the close is clicked before the case gives up, and the pause before the first.
///
/// Not a hunt for a pixel: the point is fixed and checked against the window's geometry. What the
/// retry is for is the page the button is drawn by — a click that arrives before that page has
/// mounted its close listener is a click nothing hears, and the second one is the same click a
/// moment later.
const CLICK_ATTEMPTS: usize = 5;
const CLICK_SETTLE: Duration = Duration::from_millis(1500);

/// How long the pet's windows and the process are given after the main window has gone.
///
/// This is the window the whole case turns on, so it is set from what the two builds actually do
/// rather than from what they ought to. With a close that reaches every pet window, the last window
/// leaves with the event loop and the process exits in well under a second — the readings are in the
/// header of `agent_exit_teardown_test.rs`'s sibling case. Without it, nothing ever closes them: the
/// process is still there when this case gives up, and still there however long it is given. Ten
/// seconds is therefore far past anything the fix needs and far short of anything a reader could
/// call patience.
const PET_CLOSE_SETTLE: Duration = Duration::from_secs(10);

/// `PATH`, or `None` — a missing tool is a skip and says which one.
fn tool(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Poll `probe` until it answers, or the deadline passes.
fn wait_for<T>(what: &str, deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    let until = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return Some(value);
        }
        if Instant::now() >= until {
            eprintln!("timed out waiting for {what}");
            return None;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// ---------------------------------------------------------------------------
// A private X server and a private session bus
// ---------------------------------------------------------------------------

/// The screen this case runs on, and the geometry it checks the display against.
///
/// Wider and taller than the declared window with room to spare: the window is centred by the app
/// itself, and the click point is derived from where it actually landed, so a screen the window did
/// not fit on would put it off the bottom of it.
const SCREEN: &str = "1600x1000x24";

/// A private X server, so nothing here touches the display the developer is using.
struct PrivateDisplay {
    child: Child,
    name: String,
}

impl PrivateDisplay {
    /// `None` when an X server of this test's own could not be started.
    ///
    /// The screen size is asked for rather than assumed, and that check is not decoration: the
    /// display number is chosen by pid, and a server some *other* run left on that number takes the
    /// bind — its socket then satisfies "the display is up" while its screen is a different size. So
    /// a number whose server does not answer with this case's own geometry is skipped.
    fn start(xvfb: &Path, xdotool: &Path) -> Option<Self> {
        for offset in 0..20 {
            let number = 90 + (std::process::id() % 20 + offset) % 20;
            let name = format!(":{number}");
            let mut child = Command::new(xvfb)
                .args([&name, "-screen", "0", SCREEN, "-nolisten", "tcp"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()?;
            let ours = || {
                let output = Command::new(xdotool)
                    .env("DISPLAY", &name)
                    .arg("getdisplaygeometry")
                    .output()
                    .ok()?;
                let text = String::from_utf8_lossy(&output.stdout);
                let fields: Vec<&str> = text.split_whitespace().collect();
                let want: Vec<&str> = SCREEN.split('x').take(2).collect();
                (fields == want).then_some(())
            };
            if wait_for("this case's own display", Duration::from_secs(5), ours).is_some() {
                return Some(Self { child, name });
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        None
    }
}

impl Drop for PrivateDisplay {
    fn drop(&mut self) {
        // Rust does not kill a `Child` for you, and an X server left behind would hold the display
        // number the next run wants.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A session bus of this test's own, so the app under test cannot meet the developer's instance.
struct PrivateBus {
    child: Child,
    address: String,
}

impl PrivateBus {
    fn start(dbus_daemon: &Path) -> Option<Self> {
        let mut child = Command::new(dbus_daemon)
            .args([
                "--session",
                "--address=unix:tmpdir=/tmp",
                "--print-address=1",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdout = child.stdout.take().expect("the pipe just asked for");
        let mut address = String::new();
        if BufReader::new(stdout).read_line(&mut address).ok()? == 0 {
            let _ = child.kill();
            return None;
        }
        Some(Self {
            child,
            address: address.trim().to_string(),
        })
    }
}

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// Windows, through `xdotool`
// ---------------------------------------------------------------------------

/// One window an app process owns, as the X server has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Win {
    id: u64,
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

/// Every window `xdotool` says this process owns, with its geometry.
///
/// `only_visible` is `map_state == IsViewable` — the honest reading of "on screen" on a server with
/// no window manager, and the one the pet's own windows are read with: a window that has been
/// created but not mapped is not a window the reader would have seen, and the question here is what
/// the reader sees.
fn windows_of(xdotool: &Path, display: &str, pid: u32, only_visible: bool) -> Vec<Win> {
    let mut search = vec!["search".to_string()];
    if only_visible {
        // `--onlyvisible` is a `search` option, not a global one: written before the subcommand,
        // xdotool refuses it and an error read as "no windows" would be this test lying to itself.
        search.push("--onlyvisible".to_string());
    }
    search.push("--pid".to_string());
    search.push(pid.to_string());
    let listed = match Command::new(xdotool)
        .env("DISPLAY", display)
        .args(&search)
        .output()
    {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };
    let ids = String::from_utf8_lossy(&listed.stdout);
    ids.split_whitespace()
        .filter_map(|id| {
            let geometry = Command::new(xdotool)
                .env("DISPLAY", display)
                .args(["getwindowgeometry", "--shell", id])
                .output()
                .ok()?;
            let text = String::from_utf8_lossy(&geometry.stdout).to_string();
            let field = |name: &str| {
                text.lines()
                    .find_map(|line| line.strip_prefix(name)?.parse::<i64>().ok())
            };
            Some(Win {
                id: id.parse().ok()?,
                x: field("X=")?,
                y: field("Y=")?,
                width: field("WIDTH=")?,
                height: field("HEIGHT=")?,
            })
        })
        .collect()
}

/// The app's windows that are on screen. GTK keeps a 10x10 helper window of its own that the
/// unfiltered search finds and this one does not.
fn on_screen(xdotool: &Path, display: &str, pid: u32) -> Vec<Win> {
    windows_of(xdotool, display, pid, true)
}

/// The app's main window, if it is on screen: the declared size is the whole of its identity here.
///
/// Not the title — the pet windows are titled `NekoWite` too (`desktop_pet/window_host.rs:948`),
/// and not the label, which no X property carries. The size is the one thing the config gives this
/// window and no pet window: the character window is built at `character.size` (260x320 at the
/// default 160) and the ball at `ballSize` plus its margins (80x80 at the default 56), and the
/// caller asserts the measured size against the config before it aims a click at it.
fn main_window_on_screen(xdotool: &Path, display: &str, pid: u32, size: (i64, i64)) -> Option<Win> {
    on_screen(xdotool, display, pid)
        .into_iter()
        .find(|win| (win.width, win.height) == size)
}

/// The app's windows that are on screen and are **not** the main window — the pet's own.
///
/// Read by size, for the reason [`main_window_on_screen`] gives, and this is the whole measurement
/// this case is about: these are the windows in the wry runtime's map that a closed main window
/// would otherwise leave the process living for.
fn pet_windows_on_screen(xdotool: &Path, display: &str, pid: u32, size: (i64, i64)) -> Vec<Win> {
    on_screen(xdotool, display, pid)
        .into_iter()
        .filter(|win| (win.width, win.height) != size)
        .collect()
}

// ---------------------------------------------------------------------------
// The launch
// ---------------------------------------------------------------------------

/// The app under test, launched exactly as a user's launcher would: the same binary, the same
/// environment, and nothing of the developer's own profile in it.
struct Launch {
    child: Child,
    display: String,
    xdotool: PathBuf,
    size: (i64, i64),
    log: PathBuf,
}

impl Launch {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn main_window(&self) -> Option<Win> {
        main_window_on_screen(&self.xdotool, &self.display, self.pid(), self.size)
    }

    fn pet_windows(&self) -> Vec<Win> {
        pet_windows_on_screen(&self.xdotool, &self.display, self.pid(), self.size)
    }

    fn windows(&self) -> Vec<Win> {
        windows_of(&self.xdotool, &self.display, self.pid(), false)
    }

    fn try_wait(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// The ids of this process's windows that are on screen — **one** `xdotool` invocation.
    ///
    /// Ids and nothing else, because this is the probe the close below is sampled with and a turn
    /// that also read every window's geometry would be three or four processes instead of one. The
    /// main window's own id is known from the launch, so "is a pet window still up" is a comparison
    /// against a number this case already holds — and a sharper question than the size test
    /// [`pet_windows_on_screen`] asks, since it does not depend on two windows not sharing a size.
    fn visible_ids(&self) -> Vec<u64> {
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
    fn click_close_button(&self, window: &Win) -> bool {
        self.click(window, window.width - 27, 22)
    }

    fn stderr_tail(&self) -> String {
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
fn launch_environment(tree: &Path, display: &str, bus: &str) -> Vec<(String, String)> {
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
fn launch_app(app: &Path, env: &[(String, String)], tree: &Path, log: &Path) -> Launch {
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
fn declared_size() -> (i64, i64) {
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
fn app_under_test() -> Option<PathBuf> {
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
fn scratch_tree() -> PathBuf {
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

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

#[test]
fn closing_the_main_window_takes_the_pet_and_the_process_with_it() {
    let Some(xvfb) = tool("Xvfb") else {
        eprintln!("skipping: Xvfb is not installed, so there is no display to run a launch on");
        return;
    };
    let Some(xdotool) = tool("xdotool") else {
        eprintln!("skipping: xdotool is not installed, so this test cannot see or click a window");
        return;
    };
    let Some(dbus_daemon) = tool("dbus-daemon") else {
        eprintln!("skipping: dbus-daemon is not installed, so the app cannot claim its name");
        return;
    };
    let Some(app) = app_under_test() else {
        eprintln!(
            "skipping: there is no packaged build of this tree to drive. Run \
             `pnpm --filter @nekowite/desktop exec tauri build` (or set NEKOWITE_EXIT_APP to a \
             packaged executable — that is how a build without the close arm is driven) and this \
             case drives a real quit against it."
        );
        return;
    };
    let Some(display) = PrivateDisplay::start(&xvfb, &xdotool) else {
        eprintln!("skipping: an X server of this test's own could not be started");
        return;
    };
    let Some(bus) = PrivateBus::start(&dbus_daemon) else {
        eprintln!("skipping: a session bus could not be started");
        return;
    };

    let tree = scratch_tree();
    let env = launch_environment(&tree, &display.name, &bus.address);
    let log = tree.join("app.log");
    let started = Instant::now();
    let mut run = launch_app(&app, &env, &tree, &log);

    // 1. The window. Its declared size is asserted before anything is aimed at it, because the click
    //    below is arithmetic on its geometry.
    let window = wait_for("the main window", LAUNCH_DEADLINE, || run.main_window()).unwrap_or_else(
        || {
            panic!(
                "the launch put no window of the declared size on the screen; windows seen: {:?}\n{}",
                run.windows(),
                run.stderr_tail()
            )
        },
    );
    assert_eq!(
        (window.width, window.height),
        declared_size(),
        "the main window is the size the config declares, which is what the click point is derived from"
    );
    let up_at = started.elapsed();
    eprintln!(
        "t+{:.2}s: the main window is up ({}x{} at {},{}); {} window(s) in all",
        up_at.as_secs_f32(),
        window.width,
        window.height,
        window.x,
        window.y,
        run.windows().len(),
    );

    // 2. The pet, which is the whole reason this case exists. **Waited for rather than assumed**:
    //    without its windows there is nothing to outlive the main window, and the close below would
    //    be measuring a quit that has no pet in it at all. A launch that never drew one is a
    //    failure here and not a pass by default.
    let pet = wait_for("the pet's own windows", PET_DEADLINE, || {
        let found = run.pet_windows();
        (!found.is_empty()).then_some(found)
    })
    .unwrap_or_else(|| {
        panic!(
            "no pet window appeared beside the main window on a launch that wrote no pet record, so \
             the pet is on and this launch did not draw it; this case has nothing to watch. Windows \
             on screen: {:?}\n{}",
            run.windows(),
            run.stderr_tail()
        )
    });
    let pet_at = started.elapsed();
    eprintln!(
        "t+{:.2}s: the pet is up beside it ({:.2}s after the main window): {:?}",
        pet_at.as_secs_f32(),
        (pet_at - up_at).as_secs_f32(),
        pet.iter()
            .map(|win| (win.id, win.width, win.height))
            .collect::<Vec<_>>(),
    );

    // 3. The quit: the app's own close button, clicked until the main window goes. This is the path
    //    a user takes, and — `main_window.rs`'s header traces it — the one that ends in a JS
    //    `destroy()` that runs a `Destroyed` event and cannot be prevented.
    std::thread::sleep(CLICK_SETTLE);
    let mut clicked = None;
    for attempt in 1..=CLICK_ATTEMPTS {
        assert!(
            run.click_close_button(&window),
            "the click itself has to land for the rest of this case to mean anything"
        );
        let at = Instant::now();
        let gone = wait_for("the main window to go away", CLOSE_SETTLE, || {
            run.main_window().is_none().then_some(())
        });
        if gone.is_some() {
            clicked = Some(at);
            break;
        }
        eprintln!(
            "the close button was clicked ({attempt} of {CLICK_ATTEMPTS}) and the main window is \
             still up; windows on screen: {:?}",
            run.windows()
        );
    }
    let Some(clicked) = clicked else {
        panic!(
            "the app's own close button left the main window on screen after {CLICK_ATTEMPTS} \
             click(s), so the path this case is about was never reached; windows on screen: {:?}\n{}",
            run.windows(),
            run.stderr_tail()
        )
    };
    let main_gone = clicked.elapsed();
    eprintln!(
        "t+{:.2}s: the main window is gone ({:.2}s after the close was clicked)",
        started.elapsed().as_secs_f32(),
        main_gone.as_secs_f32(),
    );

    // 4. What the close took with it. One polling loop, three readings, each recorded at the first
    //    moment it held — because the order they go in, and whether the last two happen at all, is
    //    the measurement. The process is asked every time round rather than once at the end: a
    //    process that has already left cannot be asked anything, and reaping it is how "gone" is
    //    read.
    //
    //    The pet's windows are read with the process's liveness bracketing the read, and that
    //    bracket is not decoration: a process that has left takes its windows with it, because X
    //    destroys a client's windows when its connection closes. So "the pet's windows are gone"
    //    would be true for a build that closed nothing and simply exited — which is not a build this
    //    app can produce, but a reading that cannot tell the two apart is not worth taking. What
    //    makes it a reading is whether the process was *still running* at the instant its windows
    //    were gone: that is the arm's own `disable()` doing the closing, and it is the half of this
    //    that the report is about.
    let deadline = Instant::now() + PET_CLOSE_SETTLE;
    let mut pet_gone: Option<(Duration, bool)> = None;
    let mut process_gone: Option<(Duration, ExitStatus)> = None;
    loop {
        let alive_before = run.try_wait().is_none();
        let pet_up = run.visible_ids().iter().any(|id| *id != window.id);
        let alive_after = run.try_wait().is_none();
        if process_gone.is_none() {
            if let Some(exit) = run.try_wait() {
                process_gone = Some((clicked.elapsed(), exit));
            }
        }
        if pet_gone.is_none() && !pet_up {
            pet_gone = Some((clicked.elapsed(), alive_before && alive_after));
        }
        if pet_gone.is_some() && process_gone.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        // A turn is already one `xdotool` process, so this costs no resolution; it is here so that
        // the red half — where this loop runs its whole deadline out — is not a spin.
        std::thread::sleep(Duration::from_millis(1));
    }
    let waited = clicked.elapsed();
    match process_gone {
        Some((at, exit)) => eprintln!(
            "t+{:.2}s: the process is gone ({:.2}s after the close was clicked), with {exit:?}",
            started.elapsed().as_secs_f32(),
            at.as_secs_f32(),
        ),
        None => eprintln!(
            "t+{:.2}s: the process is STILL RUNNING {:.2}s after the close was clicked (pid {})",
            started.elapsed().as_secs_f32(),
            waited.as_secs_f32(),
            run.pid(),
        ),
    }
    match pet_gone {
        Some((at, alive_at_close)) => eprintln!(
            "t+{:.2}s: the pet's windows are gone ({:.2}s after the close was clicked); the process \
             was still running at that instant: {alive_at_close}",
            started.elapsed().as_secs_f32(),
            at.as_secs_f32(),
        ),
        None => eprintln!(
            "t+{:.2}s: the pet's windows are STILL UP {:.2}s after the close was clicked: {:?}",
            started.elapsed().as_secs_f32(),
            waited.as_secs_f32(),
            run.pet_windows(),
        ),
    }

    // 5. **The process, which is the reading that matters**, and it is asserted first so that it is
    //    the sentence a failure leads with. The reported failure is a live process behind a screen
    //    with nothing on it: still holding the single-instance D-Bus name, still running the engine
    //    and the watchers, with nothing to show — and the next launch a handoff into it rather than a
    //    window. Both readings are written into the message, so the failure is the state and not a
    //    guess about which half of it went wrong.
    let Some((at, status)) = process_gone else {
        panic!(
            "the process was still running {:.2}s after the main window was closed by the app's own \
             close control (pid {}), so the close was not a quit. This is the reported failure \
             [软件退出的时候桌宠没有退出] with the screen as it happens to be: pet windows up at the \
             end: {:?}; windows on screen: {:?}\n{}",
            waited.as_secs_f32(),
            run.pid(),
            run.pet_windows(),
            run.windows(),
            run.stderr_tail(),
        )
    };
    assert!(
        status.success(),
        "the app left with {status:?} {:.2}s after the close was clicked: a quit that ends on a \
         signal is not the exit path this case is about, and neither is one that ended through GDK's \
         X error handler",
        at.as_secs_f32(),
    );

    // 6. The pet's windows, which the report is worded in terms of — 「桌宠没有退出」 — and which are
    //    asserted second only because a screen that empties while a process runs on is the same
    //    failure wearing the other coat. A pet window that outlives the main window is the bug; a pet
    //    window that goes while the process stays would be the bug moved rather than fixed, and §5
    //    above has already ruled that out.
    assert!(
        pet_gone.is_some(),
        "the pet's windows were still on the screen {:.2}s after the main window was closed by the \
         app's own close control: {:?}. Nothing else in this app closes them — there is no timer \
         behind them and the feature switch was never touched — so a build where they are still here \
         is a build where the main window's close does not reach the pet, which is exactly what the \
         maintainer reported. Windows on screen: {:?}\n{}",
        waited.as_secs_f32(),
        run.pet_windows(),
        run.windows(),
        run.stderr_tail(),
    );
    let (_, pet_closed_by_the_arm) = pet_gone.expect("asserted above");
    eprintln!(
        "t+{:.2}s: the close took the main window, the pet ({} window(s)) and the process — {:.2}s \
         end to end; the pet's windows were closed with the process still running: \
         {pet_closed_by_the_arm}",
        started.elapsed().as_secs_f32(),
        pet.len(),
        clicked.elapsed().as_secs_f32(),
    );
}
