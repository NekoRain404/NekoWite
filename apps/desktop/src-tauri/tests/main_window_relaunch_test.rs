//! A second launch brings the main window back — driven through two real processes.
//!
//! **The failure this is about.** The main window is *destroyed* when the user closes it, and the
//! pet's windows keep the process alive afterwards (the wry runtime exits only when its window map
//! empties: `tauri-runtime-wry-2.11.4/src/lib.rs:4310-4322`). The process therefore still owns the
//! single-instance D-Bus name while there is no window left to show — and the handoff callback
//! used to be `if let Some(window) = app.get_webview_window("main") { … }`, which is a silent no-op
//! in exactly that state. The user's next launch exited 0 with nothing on screen. That is what
//! this case reproduces, with the real binary, on a private X server and a private session bus.
//!
//! **Why the window is closed by clicking rather than by a message.** The app's own close button
//! is the path a user takes, and on this app the window is destroyed by *JavaScript*, not by the
//! native close: `@tauri-apps/api@2.11.1`'s `onCloseRequested` awaits the app's handler and then
//! calls `destroy()` when it was not prevented (`window.js:1632-1641`), while Tauri's own manager
//! has already prevented the native close because a JS listener exists
//! (`tauri-2.11.5/src/manager/window.rs:170-175`). So every close path — this button, Alt+F4 under
//! a window manager, a WM's own close — ends in `destroy()`, and no Rust-side `CloseRequested`
//! hook can keep the window. A synthetic `WM_DELETE_WINDOW` would exercise the same destroy by a
//! longer route; the click is the shorter and the more real of the two. It is aimed at the
//! geometry the app's own stylesheet declares (`ui/TitleBar.vue:245-290`, 34x30 buttons at the
//! right end of a 44 px bar, `styles/tokens.css:175`), and the window's size is asserted against
//! the config before the click so a wrong click point fails loudly instead of quietly.
//!
//! **What this covers and what it does not.** Every hop here is real: the binary built from this
//! tree, the X server, the session bus the plugin claims its name on, the plugin's own handoff, and
//! the window the second launch is supposed to raise. What it does not cover is the *compositor*:
//! Xvfb has no window manager, so "on screen" means "mapped, of the size the config declares"
//! rather than "mapped and raised by a compositor", and a programmatic click is not a human's.
//! `tests/main_window_test.rs` is the other half — the same rule on a mock runtime, where it runs
//! everywhere; this file is the one that can fail for a reason a mock cannot see.
//!
//! Skips, loudly, when the tools it drives are absent — the convention `instance_guard_test.rs`
//! set for `dbus-daemon`. On a machine that has them the case is green, and it is red against the
//! code this file was written for.

#![cfg(target_os = "linux")]

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long one launch may take to put its window up, before the case is red.
///
/// Generous on purpose: a debug build of the WebKit-backed app on a cold page cache is several
/// seconds, and a deadline that is tight enough to be flaky is worth less than a slow green.
const LAUNCH_DEADLINE: Duration = Duration::from_secs(45);

/// How long one click may take to be followed by the window's disappearance.
const CLOSE_DEADLINE: Duration = Duration::from_secs(4);

/// How many times the close is clicked before the case gives up, and the pause before the first.
///
/// Not a hunt for a pixel: the point is fixed and checked against the window's geometry. What the
/// retry is for is the page the button is drawn by — a click that arrives before that page has
/// mounted its listener is a click nothing hears, and the second one is the same click a moment
/// later.
const CLICK_ATTEMPTS: usize = 5;
const CLICK_SETTLE: Duration = Duration::from_millis(1500);

/// The label `tauri.conf.json` declares the main window under — Tauri's own default when a window
/// entry carries no `label` (`tauri-utils-2.9.3/src/config.rs:1919-1920`), which is what this
/// app's entry does.
///
/// Written here rather than read from `nekowite_lib::main_window::LABEL` on purpose: this file
/// drives the *binary*, and a test that took the name from the code under test would pass for a
/// build that renamed the window and updated its own constant to match. `tests/main_window_test.rs`
/// is where the two spellings are held together.
const MAIN_WINDOW: &str = "main";

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

/// A private X server, so nothing here touches the display the developer is using.
struct PrivateDisplay {
    child: Child,
    name: String,
}

impl PrivateDisplay {
    /// `None` when `Xvfb` is not installed — the same shape as the missing `dbus-daemon`.
    fn start(xvfb: &Path) -> Option<Self> {
        // A display of this test's own: the process id keeps two concurrent runs (and the
        // developer's own `:0`) apart, and the loop below is for the number still being taken by
        // something else in that window.
        for offset in 0..20 {
            let number = 90 + (std::process::id() % 20 + offset) % 20;
            let name = format!(":{number}");
            let mut child = Command::new(xvfb)
                .args([&name, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()?;
            // The socket is the readiness signal, not a sleep: `Xvfb` creates it once it listens.
            let socket = PathBuf::from(format!("/tmp/.X11-unix/X{number}"));
            if wait_for("the display socket", Duration::from_secs(5), || {
                socket.exists().then_some(())
            })
            .is_some()
            {
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
///
/// The same daemon and the same option `instance_guard_test.rs` uses: `tmpdir` keeps the socket
/// out of `$XDG_RUNTIME_DIR`, where the real session bus lives.
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

/// One window an app process owns, as the X server has it.
#[derive(Clone, Copy, Debug)]
struct Win {
    id: u64,
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

/// The app's windows that are *mapped*, read through `xdotool`.
///
/// `--onlyvisible` is `map_state == IsViewable` — the honest reading of "on screen" on a server
/// with no window manager, and the same test the wry runtime's window map is not: a window that
/// was destroyed is gone from here whether or not the process still lives.
fn on_screen(xdotool: &Path, display: &str, pid: u32) -> Vec<Win> {
    let listed = match Command::new(xdotool)
        .env("DISPLAY", display)
        // `--onlyvisible` is a `search` option, not a global one: written before the subcommand,
        // xdotool refuses it and an error read as "no windows" would be this test lying to itself.
        .args(["search", "--onlyvisible", "--pid", &pid.to_string()])
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

/// The app's main window, if it is on screen: the declared size is the whole of its identity here.
///
/// Not the title — the pet windows are titled `NekoWite` too (`desktop_pet/window_host.rs:948`),
/// and not the label, which no X property carries. The size is the one thing the config gives this
/// window and no pet window: the character window is built at `character.size` (160 by default)
/// and the ball at `ballSize` plus its margins, and the caller asserts the measured size against
/// the config before it relies on this.
fn main_window_on_screen(xdotool: &Path, display: &str, pid: u32, size: (i64, i64)) -> Option<Win> {
    on_screen(xdotool, display, pid)
        .into_iter()
        .find(|win| (win.width, win.height) == size)
}

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

    fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Click the window's own close button, at the point `ui/TitleBar.vue` draws it.
    ///
    /// The window is undecorated and no window manager is running, so the title bar is the app's
    /// own: a 44 px bar whose last control is a 34x30 button 10 px from the right edge. The centre
    /// is therefore (width - 27, 22) in window coordinates — 7 px of slack on each side of the
    /// button's own box, which is what keeps this from being a pixel-hunt.
    fn click_close_button(&self, window: &Win) -> bool {
        let x = window.x + window.width - 27;
        let y = window.y + 22;
        let run = |args: &[String]| {
            Command::new(&self.xdotool)
                .env("DISPLAY", &self.display)
                .args(args)
                .status()
                .is_ok_and(|status| status.success())
        };
        // Focused first, because there is no window manager here to give this window the focus a
        // click would carry on a real desktop; a webview that is not focused is not a webview this
        // test wants to be asking about clicks. Best effort — `windowfocus` is one more tool than
        // the click itself needs, and a refusal from it is not a reason to skip the click.
        let _ = run(&["windowfocus".to_string(), window.id.to_string()]);
        run(&[
            "mousemove".to_string(),
            x.to_string(),
            y.to_string(),
            "click".to_string(),
            "1".to_string(),
        ])
    }

    fn stderr_tail(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for Launch {
    fn drop(&mut self) {
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
        ("TMPDIR".into(), dir("tmp")),
        // X11 is what an Xvfb can serve; the renderer's dmabuf path needs a compositor this
        // server does not have, and `NO_AT_BRIDGE` is the accessibility bus the private session
        // has no daemon for.
        ("GDK_BACKEND".into(), "x11".into()),
        ("WEBKIT_DISABLE_DMABUF_RENDERER".into(), "1".into()),
        ("NO_AT_BRIDGE".into(), "1".into()),
    ]
}

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

/// The size `tauri.conf.json` declares for the main window, as integers.
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

/// The app this case drives — a **packaged** build of this tree, and nothing else.
///
/// A `cargo test` build cannot be driven here, and the reason is not a preference: `tauri`'s
/// `is_dev()` is `!cfg!(feature = "custom-protocol")` (`tauri-2.11.5/src/lib.rs:308`), only
/// `tauri build` turns that feature on, and a development build therefore serves `devUrl`
/// (`http://localhost:1420`, `manager/mod.rs:350-356`) instead of the embedded frontend — its
/// window shows "Could not connect to localhost" and has no window controls to click. Measured,
/// not assumed: `target/debug/nekowite` renders exactly that page.
///
/// The path is `NEKOWITE_RELAUNCH_APP` when it is set — which is also how a *previous* build is
/// driven, the way the "before" half of this fix was measured — else the artifact the package
/// step writes (`target/release/nekowite`, after `pnpm --filter @nekowite/desktop exec tauri
/// build`). `None` is a skip that names that command.
///
/// **A packaged build older than the source it would be driving is a skip, not a failure.** The two
/// are built by different commands at different moments, so a checkout that has just run `cargo
/// test` has, by definition, a package built from code that changed since — and a case that drove
/// it anyway would report a red gate about a binary nobody asked it to test. (Not hypothetical: the
/// first run of this file, against the package standing in the tree from before the fix, was red
/// for the reason it exists *and* for that reason.) The comparison is against the crate's own
/// inputs rather than against this test binary, because `cargo test` relinks that binary on almost
/// any change and the rule would then skip forever in a busy tree; an explicit
/// `NEKOWITE_RELAUNCH_APP` is taken as it is — naming a path is asking for that binary.
fn app_under_test() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NEKOWITE_RELAUNCH_APP") {
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
fn newest_input() -> Option<std::time::SystemTime> {
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
/// so this is the one scratch space in the suite that is not a few kilobytes, and it belongs under
/// `target/` rather than in `/tmp` for the reason the rest of the build does: this project keeps
/// its bytes in the project folder. `CARGO_TARGET_TMP_DIR` would name it directly, but cargo sets
/// that in the test's environment only for some invocations, so the path is derived from the test
/// executable's own (`<target>/<profile>/deps/<name>`), with the system temporary directory as the
/// fallback for a test binary that was moved out of the build tree.
fn scratch_tree() -> PathBuf {
    let root = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.parent()?.parent().map(Path::to_path_buf))
        .unwrap_or_else(std::env::temp_dir);
    let tree = root.join(format!("tmp/main-window-relaunch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tree);
    for sub in ["home", "config", "data", "cache", "state", "tmp"] {
        std::fs::create_dir_all(tree.join(sub)).expect("a scratch tree");
    }
    tree
}

#[test]
fn a_second_launch_with_no_main_window_brings_one_back() {
    let Some(xvfb) = tool("Xvfb") else {
        eprintln!("skipping: Xvfb is not installed, so there is no display to run two launches on");
        return;
    };
    let Some(xdotool) = tool("xdotool") else {
        eprintln!("skipping: xdotool is not installed, so this test cannot see or click a window");
        return;
    };
    let Some(dbus_daemon) = tool("dbus-daemon") else {
        eprintln!("skipping: dbus-daemon is not installed, so the handoff cannot be exercised");
        return;
    };
    let Some(app) = app_under_test() else {
        eprintln!(
            "skipping: there is no packaged build of this tree to drive. Run \
             `pnpm --filter @nekowite/desktop exec tauri build` (or set NEKOWITE_RELAUNCH_APP to a \
             packaged executable — that is how a build from another commit is driven) and this \
             case drives two real processes against it."
        );
        return;
    };
    let Some(display) = PrivateDisplay::start(&xvfb) else {
        eprintln!("skipping: an X server could not be started");
        return;
    };
    let Some(bus) = PrivateBus::start(&dbus_daemon) else {
        eprintln!("skipping: a session bus could not be started");
        return;
    };
    let tree = scratch_tree();
    let env = launch_environment(&tree, &display.name, &bus.address);
    let log = tree.join("app.log");

    // 1. A launch, and the main window it puts up. The pet is on by default, which is the whole
    //    reason the process can outlive this window: its two windows (`pet-*`, `ball`) are what
    //    keeps the runtime's window map non-empty after the main window is destroyed.
    let mut first = launch_app(&app, &env, &tree, &log);
    let window = wait_for("the first launch's main window", LAUNCH_DEADLINE, || {
        first.main_window()
    })
    .unwrap_or_else(|| {
        panic!(
            "the first launch put no window of the declared size on the screen; windows seen: {:?}\n{}",
            on_screen(&xdotool, &display.name, first.pid()),
            first.stderr_tail()
        )
    });
    // The click point below is arithmetic on this window's geometry, so the geometry is checked
    // against the declaration before anything is aimed at it.
    assert_eq!(
        (window.width, window.height),
        declared_size(),
        "the main window is the size the config declares, which is what the click point is derived from"
    );
    assert!(
        on_screen(&xdotool, &display.name, first.pid()).len() > 1,
        "the pet's own windows are up beside it — without them there is nothing to outlive the \
         main window and the case below would be about a different failure"
    );

    // 2. The user closes the main window with its own X. The process must survive it, and that is
    //    not incidental: it is the state the reported failure was in.
    //
    //    The first click can land on a page that is still booting — the window is mapped before
    //    the frontend has mounted the listener that acts on a click — so the click is retried, with
    //    a short settle before the first attempt and a short deadline after each one. A click that
    //    *does* land is followed by the window's disappearance in well under a second; the wait is
    //    short because a long one only makes the retry expensive.
    std::thread::sleep(CLICK_SETTLE);
    let mut closed = false;
    for _ in 0..CLICK_ATTEMPTS {
        assert!(
            first.click_close_button(&window),
            "the click itself has to land for the rest of this case to mean anything"
        );
        closed = wait_for("the main window to go away", CLOSE_DEADLINE, || {
            first.main_window().is_none().then_some(())
        })
        .is_some();
        if closed {
            break;
        }
    }
    assert!(
        closed,
        "clicking the window's own close button left it on screen; windows seen: {:?}",
        on_screen(&xdotool, &display.name, first.pid())
    );
    assert!(
        first.is_running(),
        "the process outlives the window while the pet is on — that is what makes the next launch \
         a handoff instead of a start"
    );

    // 3. The user launches again. This process hands off and exits with the plugin's own code,
    //    which is 0 on both arms: `platform_impl/linux.rs:84-90` calls the first instance and
    //    exits before anything here could see the outcome. What the second launch DID is read
    //    from the screen instead.
    let second_log = tree.join("app-second.log");
    let status = Command::new(&app)
        .envs(env.iter().map(|(k, v)| (k.clone(), v.clone())))
        .current_dir(&tree)
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            File::create(&second_log).expect("a log file for the second launch"),
        ))
        .stderr(Stdio::from(
            File::create(&second_log).expect("a log file for the second launch"),
        ))
        .status()
        .expect("a second launch of the same binary");
    assert!(
        status.success(),
        "the second launch is the plugin's handoff and exits 0; it exited {status:?}"
    );

    // 4. …and the window is back on the screen, brought up by the first process.
    let back = wait_for(
        "the main window to come back after the second launch",
        LAUNCH_DEADLINE,
        || first.main_window(),
    );
    assert!(
        back.is_some(),
        "the second launch did nothing: no window of {}x{} is on the screen, so the user's \
         launch exited 0 with no window and nothing said. Windows seen: {:?}\n{}",
        declared_size().0,
        declared_size().1,
        on_screen(&xdotool, &display.name, first.pid()),
        first.stderr_tail()
    );
}
