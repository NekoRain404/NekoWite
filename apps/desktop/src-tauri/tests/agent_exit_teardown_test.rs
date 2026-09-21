//! A graceful quit stops the engine — driven through the real binary, on a private X server.
//!
//! **The failure this is about.** `App::run` finishes by calling `std::process::exit` (Tauri's own
//! doc says so, `tauri-2.11.5/src/app.rs:1346`, and the call is at `:578`), and `process::exit`
//! runs no destructors — so the managed `AgentRuntimeState` was never dropped, `AgentInstance`'s
//! `Drop` never ran, and nothing on the quit path ever asked the engine to leave. The teardown
//! (`agent_stop`'s three steps, now `commands::agent::stop_running_engine`) was correct the whole
//! time; nothing *reached* it on that path. It is this repository's recurring shape — built,
//! correct, unreachable — with the cost landing on the machine rather than on the reader: an engine
//! left behind by a quit. `lib.rs`'s `RunEvent::Exit` arm is the reach. Whether it is reached is
//! measured below; what it is worth on this engine, and why the case below is a guard rather than a
//! demonstration, is measured there too.
//!
//! **What this case drives, and why each hop is real.** The packaged binary of this tree (`tauri
//! build`'s artifact, not a `cargo build` one — see [`app_under_test`]); an Xvfb of its own; a
//! session bus of its own; a scratch `XDG_*` tree; a vault the backend is made to remember by
//! writing the record it reads (`state/remembered.rs`'s `last-vault`); a note opened the way a file
//! manager opens one (a path on the command line, `open_file`'s own channel); the agent rail opened
//! by clicking the app's own toggle, which is the gesture that starts an engine on demand
//! (`app/agent-rail-attachment.ts`: no rail, no engine); and the app's own close button, which is
//! the quit a user performs. Only the last hop reaches `RunEvent::Exit`: `SIGTERM`/`SIGKILL` end
//! the process without the event loop running down, and the loop is what calls the arm.
//!
//! **Why the close is the app's button and not `xdotool windowclose`.** Measured on this tree, with
//! the engine up: `windowclose` is `X_DestroyWindow` (xdotool's own man page: "This action will
//! destroy the window"), and destroying a GTK window out from under the app ends it through GDK's X
//! error handler — `BadDrawable`, exit 1 — rather than through the event loop. `windowquit` is the
//! graceful spelling, but it sends `_NET_CLOSE_WINDOW` to the *root* window, which is a message for
//! a window manager to act on, and an Xvfb has none: on this tree it does nothing at all. What is
//! left is the gesture the user makes, which is also the one `main_window_relaunch_test.rs` drives
//! (with the same geometry assertion and the same retry, and for the same reason: a click that
//! arrives before the page has mounted its close handler is a click nothing hears).
//!
//! **Why the pet is off for this run.** The pet's windows keep the wry runtime's window map
//! non-empty, so with them up, closing the main window leaves the process running and reaches no
//! exit at all — that is `main_window_relaunch_test.rs`'s subject, one file over, and its own case
//! depends on it. Turning the pet off is not a test-only state: it is a stored record the app
//! itself writes and reads (`desktop_pet/settings/store.rs`, one JSON file per domain), and both of
//! its switches are fields of the settings page. With no pet window, the main window is the last
//! one, and its close is the whole quit.
//!
//! **What it does not cover.** No window manager, so "closed" is the app's own close rather than a
//! compositor's; no model and no credentials, so the engine is started and its session opened but
//! nothing is ever asked of it — a run in flight, and the tool subprocesses §6.2's group kill exists
//! for, are states this case never puts the engine in. What it measures is the engine process, and
//! whether it is still there once the app is gone.
//!
//! **What this case proves, and what it does not.** It proves the property the change is about —
//! a graceful quit leaves no engine behind — through the whole path: the real binary, a real vault,
//! a real engine started by the app's own gesture, a quit through the app's own close button, and
//! the engine's pid gone afterwards.
//!
//! What it does **not** prove is that the `RunEvent::Exit` arm is what removes it, and that half was
//! measured rather than assumed — twice, and both times against the same tree. The arm is reached:
//! a build carrying one line of output inside it (`target/exit-probe`) writes that line to the app's
//! log on this very quit, before the process leaves. But the engine does not need reaching. It exits
//! by itself when its stdin closes, and that event happens either way — the teardown closes the
//! connection, or the process's exit closes every descriptor — so the two builds cannot be told
//! apart by watching it: with the arm the engine was gone 0.00-3.21s after the app over eighteen
//! runs, and without it (`NEKOWITE_EXIT_APP` naming a build of the same tree minus the arm) 0.80s,
//! 1.00s, 1.00s and 3.5s over four. Two overlapping distributions about one engine's own shutdown
//! timing is not a reading this case can assert on, so it does not: it asserts that no engine is
//! left behind, which is the property the arm exists for.
//!
//! So this is a guard, not a demonstration, and the shape where the arm's absence would be plain is
//! the one the SDK's own spawn comment names: an engine behind a wrapper launcher (`npx …`), whose
//! real agent re-parents to pid 1 and 「does not reliably exit on stdin EOF」. What is left of the
//! arm's own effect here is smaller than `lib.rs`'s comment claims: nothing waits `SHUTDOWN_GRACE`
//! or signals the group, because `stop_running_engine` returns as soon as the senders are dropped
//! and the process leaves a tenth of a second later. What the arm reliably does is close the
//! connection — the engine's stdin — while the app is still alive, and retire the pet's tasks.
//!
//! **Runs where nothing is left behind.** `cargo test` runs this case only when a packaged build of
//! this tree is standing (see [`app_under_test`]), and a build older than its sources is a skip that
//! names the command rather than a failure.

#![cfg(target_os = "linux")]

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime};

/// How long one launch may take to put its main window up.
const LAUNCH_DEADLINE: Duration = Duration::from_secs(45);

/// How long the window may take to open the vault — read as the backend rewriting the record it
/// vouches a root with, which is the same `register_vault` call that makes the vault servable.
/// It is also the point past which the page is mounted, which is what the two clicks need.
const VAULT_DEADLINE: Duration = Duration::from_secs(45);

/// How long the engine may take to appear after the rail is opened. Generous: a start is a spawn,
/// an ACP handshake and a `session/new` on an engine that is a 184 MB binary.
const ENGINE_DEADLINE: Duration = Duration::from_secs(60);

/// How long the app may take to leave after its close button is clicked.
const CLOSE_DEADLINE: Duration = Duration::from_secs(30);

/// How many times the close is clicked before the case gives up, and the pause before the first.
///
/// Not a hunt for a pixel: the point is fixed and checked against the window's geometry. What the
/// retry is for is the page the button is drawn by — a click that arrives before that page has
/// mounted its close listener is a click nothing hears, and the second one is the same click a
/// moment later.
const CLICK_ATTEMPTS: usize = 5;
const CLICK_SETTLE: Duration = Duration::from_millis(1500);

/// How long one click is given to be followed by the window's disappearance and the process's exit.
const CLOSE_SETTLE: Duration = Duration::from_secs(4);

/// How long the engine may take to be gone after the app has left.
///
/// Generous on purpose, and not a threshold this case pretends is sharp: the engine it watches
/// leaves by itself when its stdin closes — 0.00-3.21s after the app across eighteen runs with the
/// teardown, and 0.80-3.5s across four without it — so a tight window here would be a coin toss
/// about that engine's timing and not a reading about the quit. What the wait is for is the failure
/// this case exists for: a pid still running long after the app is gone.
const STOPPED_SETTLE: Duration = Duration::from_secs(20);

/// How long after the first reading the engine is looked for once more.
///
/// One sample is one sample: a pid that had gone at the instant the app left and came back a moment
/// later would be a different failure than the one this case is written for, and a second reading
/// is what tells the two apart.
const STILL_GONE_SETTLE: Duration = Duration::from_secs(2);

/// The name the bundled engine carries (`agent_runtime::binary_registry::PROGRAM_NAME`).
///
/// Written here rather than imported for the reason `main_window_relaunch_test.rs` writes the
/// window label out: this file drives the *binary*, and a case that took the name from the code
/// under test would follow that code anywhere it went.
const ENGINE_NAME: &str = "opencode";

/// `tauri.conf.json`'s default window label — Tauri's own when an entry carries none.
const MAIN_WINDOW: &str = "main";

/// The screen this case runs on, and the geometry it checks the display against.
///
/// Wider and taller than the declared window with room to spare: the window is centred by the app
/// itself, and the click points are derived from where it actually landed, so a screen the window
/// did not fit on would put them off the bottom of it.
const SCREEN: &str = "1600x1000x24";

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
// The process table
// ---------------------------------------------------------------------------

/// One process, as much of it as this case reads: who it is, who started it, and when it started.
///
/// `start` is `/proc/<pid>/stat`'s `starttime`, and it is carried for one reason: a pid is a number
/// the kernel reuses, and "the engine is gone" must not be answerable by a *different* process that
/// happens to have taken the engine's number. Two readings that agree on pid and starttime are the
/// same process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Proc {
    pid: u32,
    ppid: u32,
    start: u64,
}

/// `/proc/<pid>/stat`'s comm, ppid and starttime.
///
/// Parsed by hand rather than split on whitespace, because the second field is the program name in
/// parentheses and a name may contain both spaces and parentheses (`(sd-pam)`). The last `)` in the
/// line is the field's end — no later field can contain one.
fn stat_of(pid: u32) -> Option<(String, u32, u64)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat[open + 1..close].to_string();
    let rest: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // After the name: state, ppid, … — ppid is first after the state, and `starttime` is the
    // twenty-second field of the line, nineteenth of the remainder (`proc(5)`).
    Some((
        comm,
        rest.get(1)?.parse().ok()?,
        rest.get(19)?.parse().ok()?,
    ))
}

fn processes() -> Vec<Proc> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if let Some((_comm, ppid, start)) = stat_of(pid) {
            out.push(Proc { pid, ppid, start });
        }
    }
    out
}

/// Whether this process is the bundled engine — by the name it carries, or by the executable it
/// runs. Both are read: a program can set either, and the second is the one that cannot be talked
/// into a lie without replacing the file.
fn is_engine(pid: u32) -> bool {
    if stat_of(pid).is_some_and(|(comm, _, _)| comm == ENGINE_NAME) {
        return true;
    }
    fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|exe| {
            exe.file_name()
                .map(|name| name.to_string_lossy() == ENGINE_NAME)
        })
        .unwrap_or(false)
}

/// The engine processes `root` started: any engine whose parent chain reaches it.
///
/// A chain rather than `ppid == root`, because a start is allowed a wrapper between the app and the
/// engine — the app's own spawn is direct today, and a case that assumed it would report "no
/// engine" the day that changed.
fn engines_under(root: u32) -> Vec<Proc> {
    let all = processes();
    let parent = |pid: u32| all.iter().find(|p| p.pid == pid).map(|p| p.ppid);
    all.iter()
        .filter(|p| is_engine(p.pid))
        .filter(|p| {
            let mut current = p.ppid;
            // Bounded rather than a `while`: a cycle in the table (a pid reused while this list
            // was being read) must not be an infinite loop in a test.
            for _ in 0..12 {
                if current == root {
                    return true;
                }
                match parent(current) {
                    Some(next) if current > 1 => current = next,
                    _ => return false,
                }
            }
            false
        })
        .copied()
        .collect()
}

/// Whether a process this case recorded earlier is still the process running now.
fn alive(proc: Proc) -> bool {
    stat_of(proc.pid).is_some_and(|(_, _, start)| start == proc.start)
}

/// What a process is running, for a failure message that says which engine was left behind.
fn command_line(pid: u32) -> String {
    fs::read(format!("/proc/{pid}/cmdline"))
        .ok()
        .map(|bytes| {
            String::from_utf8_lossy(&bytes)
                .replace('\0', " ")
                .trim()
                .to_string()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The app's own declarations
// ---------------------------------------------------------------------------

/// The size the config declares for the main window, as integers.
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

/// The bundle identifier the app keeps its own files under.
///
/// `app_config_dir` and `app_data_dir` are both `dirs::config_dir()`/`dirs::data_dir()` joined with
/// this (`tauri-2.11.5/src/path/desktop.rs:238-248`), so it is what turns the scratch `XDG_*`
/// directories into the two folders this case has to write into.
fn declared_identifier() -> String {
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!())
        .expect("the app's own tauri.conf.json builds a context");
    app.config().identifier.clone()
}

// ---------------------------------------------------------------------------
// A private X server and a private session bus
// ---------------------------------------------------------------------------

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
    /// bind — its socket then satisfies "the display is up" while its screen is a different size.
    /// Measured, and it is how a run of this file came to place the window at a negative offset,
    /// click below its own screen and report "no engine appeared" for a reason that was not the
    /// app's. So a number whose server does not answer with this case's own geometry is skipped.
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
#[derive(Clone, Copy, Debug)]
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
/// no window manager, and the right one for the identity below: a window that has been created but
/// not mapped yet is not one a click can land on.
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

/// The app's main window, if it is on screen: the declared size is the whole of its identity here.
///
/// Not the title — the pet windows are titled `NekoWite` too (`desktop_pet/window_host.rs:948`),
/// and not the label, which no X property carries. The size is the one thing the config gives this
/// window and no other, and the caller asserts the measured size against the config before it aims
/// a click at it.
fn main_window_on_screen(xdotool: &Path, display: &str, pid: u32, size: (i64, i64)) -> Option<Win> {
    windows_of(xdotool, display, pid, true)
        .into_iter()
        .find(|win| (win.width, win.height) == size)
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
    /// The engine processes seen while this app ran, so a failure below — which is exactly the red
    /// half of this case — does not leave them running on the machine.
    engines: Vec<Proc>,
}

impl Launch {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn main_window(&self) -> Option<Win> {
        main_window_on_screen(&self.xdotool, &self.display, self.pid(), self.size)
    }

    fn windows(&self) -> Vec<Win> {
        windows_of(&self.xdotool, &self.display, self.pid(), false)
    }

    /// The app's windows that are on screen. GTK keeps a 10x10 helper window of its own that the
    /// unfiltered search finds and this one does not; the pet's two are on screen when they exist,
    /// which is what makes this the reading the precondition below needs.
    fn visible_windows(&self) -> Vec<Win> {
        windows_of(&self.xdotool, &self.display, self.pid(), true)
    }

    fn try_wait(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
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
    fn open_agent_rail(&self, window: &Win) -> bool {
        self.click(window, window.width - 58, window.height - 17)
    }

    /// Click the app's own close button, at the point `ui/TitleBar.vue` draws it.
    ///
    /// The window is undecorated and no window manager is running, so the title bar is the app's
    /// own: a 44 px bar whose last control is a 34x30 button 10 px from the right edge. The centre
    /// is therefore (width - 27, 22) in window coordinates — 7 px of slack on each side of the
    /// button's own box, which is what keeps this from being a pixel-hunt. Closing the last window
    /// is what runs the event loop down to `RunEvent::Exit`.
    fn click_close_button(&self, window: &Win) -> bool {
        self.click(window, window.width - 27, 22)
    }

    fn stderr_tail(&self) -> String {
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

/// Launch the app on a note, the way a file manager opens one: a path among its arguments.
///
/// The argument matters twice over — it is the file the window opens, and (through the
/// remembered-vault record written before this call) the vault the app is in when the rail opens.
fn launch_app(
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
/// same rule, for the same reason, that `main_window_relaunch_test.rs` states at length: the two
/// are built by different commands at different moments, and a case that drove a stale artifact
/// would report a red gate about a binary nobody asked it to test. An explicit `NEKOWITE_EXIT_APP`
/// is taken as it is — naming a path is asking for that binary.
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
fn pet_off_record() -> String {
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
fn scratch_tree() -> PathBuf {
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

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

#[test]
fn a_graceful_quit_takes_the_engine_with_it() {
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
             packaged executable — that is how a build from another commit, or one with the exit \
             arm taken out, is driven) and this case drives a real quit against it."
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
    let identifier = declared_identifier();
    // The vault, and a note in it: a real folder with a real document, which is what the app is
    // about to be pointed at.
    let vault = tree.join("vault");
    fs::create_dir_all(&vault).expect("a vault to open");
    let note = vault.join("note.md");
    fs::write(
        &note,
        "# a note\n\nA document in the folder the engine is started for.\n",
    )
    .expect("a note in the vault");
    // The record the backend vouches a root with (`state/remembered.rs`): one absolute path, and
    // the vault above is what it names. Read by `register_vault` (`commands/fs.rs:175`), so this is
    // what makes the folder a vault the window may open rather than one it picked at random.
    let record = tree.join("config").join(&identifier).join("last-vault");
    fs::create_dir_all(record.parent().expect("a config directory")).expect("the config directory");
    fs::write(
        &record,
        format!(
            "{}\n",
            fs::canonicalize(&vault)
                .expect("the vault's own path")
                .display()
        ),
    )
    .expect("the remembered-vault record");
    let written = fs::metadata(&record)
        .and_then(|meta| meta.modified())
        .expect("the record's own timestamp");
    // …and the pet's own record, with its two windows off — see the header for why this case runs
    // that way.
    let pet_settings = tree
        .join("data")
        .join(&identifier)
        .join("desktop-pet/settings");
    fs::create_dir_all(&pet_settings).expect("the pet's settings directory");
    fs::write(pet_settings.join("general.json"), pet_off_record()).expect("the pet's record");

    let env = launch_environment(&tree, &display.name, &bus.address);
    let log = tree.join("app.log");
    let started = Instant::now();
    let mut run = launch_app(&app, &xdotool, &note, &env, &tree, &log);

    // 1. The window. Its declared size is asserted before anything is aimed at it, because both
    //    clicks below are arithmetic on its geometry.
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
        "the main window is the size the config declares, which is what the click points are derived from"
    );
    eprintln!(
        "t+{:.1}s: the main window is up ({}x{} at {},{}); {} window(s) in all",
        started.elapsed().as_secs_f32(),
        window.width,
        window.height,
        window.x,
        window.y,
        run.windows().len(),
    );

    // 2. The vault is open, and this is read rather than slept on: `register_vault` is the one call
    //    that makes a root servable, and it *writes this record*. A timestamp that moved is the
    //    backend's own receipt that the window applied the vault — which is a precondition for the
    //    rail (and therefore the engine) and also the point past which the page is mounted, which
    //    is what both clicks need. A fixed pause could establish neither.
    let opened = wait_for("the vault to be registered", VAULT_DEADLINE, || {
        fs::metadata(&record)
            .and_then(|meta| meta.modified())
            .ok()
            .filter(|moved| *moved != written)
    });
    assert!(
        opened.is_some(),
        "the window never registered a vault, so there is nothing to start an engine for; \
         windows seen: {:?}\n{}",
        run.windows(),
        run.stderr_tail()
    );
    assert_eq!(
        run.visible_windows().len(),
        1,
        "this case needs the main window to be the LAST window — the pet's own are what keep the \
         process alive after it closes, and the record written before the launch is what keeps \
         them from being built. Windows on screen: {:?}",
        run.visible_windows()
    );
    eprintln!(
        "t+{:.1}s: the vault is open and registered; the pet is off, so the main window is the last one",
        started.elapsed().as_secs_f32()
    );

    // 3. The rail, and with it the engine. One click: a second would close the rail it just opened,
    //    and that close queues a teardown behind the start.
    assert!(
        run.open_agent_rail(&window),
        "the click on the rail toggle has to land for the rest of this case to mean anything"
    );
    let engines = wait_for("the engine to start", ENGINE_DEADLINE, || {
        let found = engines_under(run.pid());
        (!found.is_empty()).then_some(found)
    })
    .unwrap_or_else(|| {
        panic!(
            "no engine appeared after the rail was opened, so this case has nothing to watch. \
             Either the click missed the toggle or the start was refused — the app's own log says \
             which:\n{}",
            run.stderr_tail()
        )
    });
    run.engines = engines.clone();
    let pids: Vec<u32> = engines.iter().map(|engine| engine.pid).collect();
    eprintln!(
        "t+{:.1}s: the engine is up: {:?} ({})",
        started.elapsed().as_secs_f32(),
        pids,
        engines
            .iter()
            .map(|engine| command_line(engine.pid))
            .collect::<Vec<_>>()
            .join(", "),
    );

    // 4. The quit: the app's own close button, clicked until the process leaves. This is the path a
    //    user takes, and the only one that reaches `RunEvent::Exit`.
    //
    //    The engine is checked to be *alive* at this moment, and that check is what makes the
    //    reading below about the quit: an engine that had already gone — a start that failed a
    //    moment after it appeared — would otherwise be read as one the quit had stopped.
    assert_eq!(
        engines
            .iter()
            .copied()
            .filter(|engine| alive(*engine))
            .map(|engine| engine.pid)
            .collect::<Vec<u32>>(),
        pids,
        "the engine has to be running when the close is clicked, or there is nothing for the quit \
         to stop"
    );
    std::thread::sleep(CLICK_SETTLE);
    let closing = Instant::now();
    let mut status = None;
    let mut still_up = Vec::new();
    let mut attempts = 0;
    for attempt in 1..=CLICK_ATTEMPTS {
        attempts = attempt;
        if let Some(exit) = run.try_wait() {
            status = Some(exit);
            break;
        }
        assert!(
            run.click_close_button(&window),
            "the click itself has to land for the rest of this case to mean anything"
        );
        // What one click is given to be followed by the window's disappearance and the process's
        // exit. The window goes well under a second after a click that lands.
        let until = Instant::now() + CLOSE_SETTLE;
        while Instant::now() < until {
            if let Some(exit) = run.try_wait() {
                status = Some(exit);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if status.is_some() || closing.elapsed() > CLOSE_DEADLINE {
            break;
        }
        still_up = run.windows();
    }
    let Some(status) = status else {
        panic!(
            "the app did not leave after its close button was clicked {attempts} time(s), so the \
             exit path this case is about was never reached; windows still up ({}): {:?}\n{}",
            still_up.len(),
            still_up,
            run.stderr_tail()
        )
    };
    let left = Instant::now();
    eprintln!(
        "t+{:.1}s: the app left with {status:?} ({:.1}s after the first click, {attempts} click(s))",
        started.elapsed().as_secs_f32(),
        closing.elapsed().as_secs_f32(),
    );
    assert!(
        status.success(),
        "the app left with {status:?}: a quit that ends on a signal is not the exit path this case \
         is about, and neither is one that ended through GDK's X error handler"
    );

    // 5. The engine, and the whole of the claim: the quit stops it — it is not left to notice, on
    //    its own, that the pipe it was talking on has closed.
    //
    //    **This is the assertion the red half answers**, and the reason it is a window rather than
    //    "eventually" is what that half measured: with the `RunEvent::Exit` arm removed, the engine
    //    was still running 3.5s after the app was gone (the build in `target/exit-red`), and it left
    //    when it noticed the closed stdin by itself. With the arm, it is gone before the app is.
    let gone = wait_for(
        "the engine to be stopped by the quit",
        STOPPED_SETTLE,
        || {
            let survivors: Vec<Proc> = engines.iter().copied().filter(|e| alive(*e)).collect();
            survivors.is_empty().then_some(())
        },
    );
    if gone.is_none() {
        let survivors: Vec<(u32, String)> = engines
            .iter()
            .copied()
            .filter(|e| alive(*e))
            .map(|e| (e.pid, command_line(e.pid)))
            .collect();
        panic!(
            "the engine was still running {:.2}s after the app left: {survivors:?}. The teardown \
             exists and is correct (`tests/agent_runtime_test.rs` proves it kills the group when it \
             runs); what this case is about is whether the quit path reaches it. An engine left \
             here is one that was never asked to leave — it will exit on its own when it notices \
             the closed stdin, which is the read the red half of this case produced.\n{}",
            left.elapsed().as_secs_f32(),
            run.stderr_tail()
        );
    }
    eprintln!(
        "t+{:.1}s: the engine is gone ({:.2}s after the app left, and it was alive when the close \
         was clicked)",
        started.elapsed().as_secs_f32(),
        left.elapsed().as_secs_f32(),
    );
    // And one last reading of the same thing, so the report cannot be a single lucky sample: it is
    // still gone a moment later.
    std::thread::sleep(STILL_GONE_SETTLE);
    let survivors: Vec<u32> = engines
        .iter()
        .copied()
        .filter(|e| alive(*e))
        .map(|e| e.pid)
        .collect();
    assert!(
        survivors.is_empty(),
        "the engine came back after the quit: {survivors:?}"
    );
}
