//! The machinery every file here shares: the guard that makes a skip a *failure* when the run
//! says these cases are required, the `PATH` lookup a tool is resolved through, the bounded wait
//! every deadline is spent on, and the constants that wait is bounded by.
//!
//! `skip!` uses a bare `return`, so it can only be invoked from the function it means to leave, and
//! that function is the case in the target root. `#[macro_export]` below puts the macro in the crate
//! root's macro namespace, which is what lets the root call it without an import of its own. Its doc
//! comment, its body and the `NEKOWITE_REQUIRE_PROCESS_TESTS` panic inside it moved here byte for byte.
//!
//! Everything is `pub` because more than one file reads something from here: the launch takes
//! `MAIN_WINDOW`, the process table takes `ENGINE_NAME`, the session takes `SCREEN`, and the case takes
//! the deadlines.

use std::path::PathBuf;
use std::time::{Duration, Instant};

pub fn tool(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}
/// Give up on this case — and make that a *failure* when the run says these cases are required.
///
/// **Rust has no skip: a case that returns early is reported as `ok`.** A run whose display cannot
/// start, or whose tree has no packaged build, therefore prints `passed` for a test that never
/// executed, and `cargo test` exits 0 having measured nothing. That is how this repository's two
/// process-level cases sat green while doing nothing — a broken instrument reading as a clean gate.
///
/// The default stays a skip, and the reason is `app_under_test`'s: CI has no packaged build of this
/// tree, so failing there would be a red gate about the machine rather than about the code.
/// `NEKOWITE_REQUIRE_PROCESS_TESTS=1` is the other half — a run that *means* to exercise these cases
/// makes every reason to give up a failure, so its reading is either a measurement or a red gate and
/// never a quiet pass.
#[macro_export]
macro_rules! skip {
    ($($arg:tt)*) => {{
        let sentence = format!($($arg)*);
        if std::env::var_os("NEKOWITE_REQUIRE_PROCESS_TESTS").is_some() {
            panic!(
                "this run requires the process-level cases, and this one cannot run: {sentence}"
            );
        }
        eprintln!("skipping: {sentence}");
        return;
    }};
}
/// Poll `probe` until it answers, or the deadline passes.
pub fn wait_for<T>(
    what: &str,
    deadline: Duration,
    mut probe: impl FnMut() -> Option<T>,
) -> Option<T> {
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

/// How long one launch may take to put its main window up.
pub const LAUNCH_DEADLINE: Duration = Duration::from_secs(45);

/// How long the window may take to open the vault — read as the backend rewriting the record it
/// vouches a root with, which is the same `register_vault` call that makes the vault servable.
/// It is also the point past which the page is mounted, which is what the two clicks need.
pub const VAULT_DEADLINE: Duration = Duration::from_secs(45);

/// How long the engine may take to appear after the rail is opened. Generous: a start is a spawn,
/// an ACP handshake and a `session/new` on an engine that is a 184 MB binary.
pub const ENGINE_DEADLINE: Duration = Duration::from_secs(60);

/// How long the app may take to leave after its close button is clicked.
pub const CLOSE_DEADLINE: Duration = Duration::from_secs(30);

/// How many times the close is clicked before the case gives up, and the pause before the first.
///
/// Not a hunt for a pixel: the point is fixed and checked against the window's geometry. What the
/// retry is for is the page the button is drawn by — a click that arrives before that page has
/// mounted its close listener is a click nothing hears, and the second one is the same click a
/// moment later.
pub const CLICK_ATTEMPTS: usize = 5;
pub const CLICK_SETTLE: Duration = Duration::from_millis(1500);

/// How long one click is given to be followed by the window's disappearance and the process's exit.
pub const CLOSE_SETTLE: Duration = Duration::from_secs(4);

/// How long the engine may take to be gone after the app has left.
///
/// Generous on purpose, and not a threshold this case pretends is sharp: the engine it watches
/// leaves by itself when its stdin closes — 0.00-3.21s after the app across eighteen runs with the
/// teardown, and 0.80-3.5s across four without it — so a tight window here would be a coin toss
/// about that engine's timing and not a reading about the quit. What the wait is for is the failure
/// this case exists for: a pid still running long after the app is gone.
pub const STOPPED_SETTLE: Duration = Duration::from_secs(20);

/// How long after the first reading the engine is looked for once more.
///
/// One sample is one sample: a pid that had gone at the instant the app left and came back a moment
/// later would be a different failure than the one this case is written for, and a second reading
/// is what tells the two apart.
pub const STILL_GONE_SETTLE: Duration = Duration::from_secs(2);

/// The name the bundled engine carries (`agent_runtime::binary_registry::PROGRAM_NAME`).
///
/// Written here rather than imported for the reason `MAIN_WINDOW` below is written out too: this
/// file drives the *binary*, and a case that took the name from the code under test would follow
/// that code anywhere it went — the reason `main_window_relaunch_test.rs` gave for writing its own
/// window label out before `e326a8b` deleted it.
pub const ENGINE_NAME: &str = "opencode";

/// `tauri.conf.json`'s default window label — Tauri's own when an entry carries none.
pub const MAIN_WINDOW: &str = "main";

/// The screen this case runs on, and the geometry it checks the display against.
///
/// Wider and taller than the declared window with room to spare: the window is centred by the app
/// itself, and the click points are derived from where it actually landed, so a screen the window
/// did not fit on would put them off the bottom of it.
pub const SCREEN: &str = "1600x1000x24";
