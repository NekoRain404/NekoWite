//! The machinery every file here shares: the guard that makes a skip a *failure* when the run says
//! these cases are required, the `PATH` lookup a tool is resolved through, the bounded wait every
//! deadline is spent on, and the deadlines themselves.
//!
//! `skip!` uses a bare `return`, so it can only be invoked from the function it means to leave —
//! `scenario.rs`'s case — and a `macro_rules!` macro is scoped to the file that defines it, so the
//! re-export below puts it on a path that case can name. The macro, its doc comment and the
//! `NEKOWITE_REQUIRE_PROCESS_TESTS` panic inside it moved here byte for byte.
//!
//! These are `pub` because every other file here reads something from this one: the launch reads
//! `tool`, the private display reads `wait_for`, and the case reads the constants.

use std::path::PathBuf;
use std::time::{Duration, Instant};

/// How long one launch may take to put its main window up.
pub const LAUNCH_DEADLINE: Duration = Duration::from_secs(45);

/// How long the pet's own windows may take to appear beside it.
///
/// Not incidental to the case: the pet is what keeps the process alive after the main window is
/// destroyed, so a launch whose pet never came up would be measuring a different app. One RPC that
/// ends by opening two webview windows, so this is generous for the same reason `LAUNCH_DEADLINE` is.
pub const PET_DEADLINE: Duration = Duration::from_secs(45);

/// How long one click may take to be followed by the main window's disappearance.
pub const CLOSE_SETTLE: Duration = Duration::from_secs(4);

/// How many times the close is clicked before the case gives up, and the pause before the first.
///
/// Not a hunt for a pixel: the point is fixed and checked against the window's geometry. What the
/// retry is for is the page the button is drawn by — a click that arrives before that page has
/// mounted its close listener is a click nothing hears, and the second one is the same click a
/// moment later.
pub const CLICK_ATTEMPTS: usize = 5;
pub const CLICK_SETTLE: Duration = Duration::from_millis(1500);

/// How long the pet's windows and the process are given after the main window has gone.
///
/// This is the window the whole case turns on, so it is set from what the two builds actually do
/// rather than from what they ought to. With a close that reaches every pet window, the last window
/// leaves with the event loop and the process exits in well under a second — the readings are in the
/// header of `agent_exit_teardown_test.rs`'s sibling case. Without it, nothing ever closes them: the
/// process is still there when this case gives up, and still there however long it is given. Ten
/// seconds is therefore far past anything the fix needs and far short of anything a reader could
/// call patience.
pub const PET_CLOSE_SETTLE: Duration = Duration::from_secs(10);

/// `PATH`, or `None` — a missing tool is a skip and says which one.
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

// `macro_rules!` scopes a macro to the file that defines it, so the case in `scenario.rs`
// reaches `skip!` through this path re-export rather than a bare name.
pub(crate) use skip;

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
