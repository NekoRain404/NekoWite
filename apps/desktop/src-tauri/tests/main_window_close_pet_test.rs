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
//! the guarantee `main_window_relaunch_test.rs` relied on before `e326a8b` deleted it, and the one
//! this file and `agent_exit_teardown_test.rs` — the two left that drive a real launch — keep by
//! being separate targets. What is duplicated between them is the launch scaffolding, and that
//! duplication is this suite's existing convention rather than a new one.
//!
//! **What the arm did to the case it replaced, measured here.** With the arm in the tree,
//! `main_window_relaunch_test.rs` did not fail — it **hangs**, the worse of the two readings for a
//! suite this size: a hung target costs a timeout and reads as neither red nor green. Its case
//! asserted the *first* process outlives its main window (`first.is_running()`, its `:552`) and then
//! waited on the second launch with `Command::status()`. With the arm the first process leaves with
//! its window, so the second claims the single-instance name and keeps running as an ordinary app,
//! and that `status()` never returns. Measured: with the arm the case was still blocked after ten
//! minutes with the second instance alive under the test binary; against a build of the same tree
//! with the arm taken out, the same case was green in 7.63s. The state it was written for — a
//! process with no window to bring back — no longer occurs once the close ends the process, so
//! `e326a8b` deleted it rather than repairing it; and this file reads the app's fate the other way,
//! by polling `try_wait` inside a deadline (`PET_CLOSE_SETTLE`) instead of blocking on a process
//! whose lifetime is the measurement.
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

// The target's own long argument is the doc comment above; what is left in this file is the module
// tree, because the case itself moved to `scenario.rs` whole — name, body, assertions and thresholds
// unchanged.

// `#[path]` rather than a bare `mod`, because a test target's root resolves a plain `mod x;` against
// `tests/` — the compiler says `E0583: create file "tests/x.rs"` — not against this directory, which
// is the rule `desktop_pet_ipc_test.rs` and `agent_settings_ipc_test.rs` state. Every path below
// points inside `tests/main_window_close_pet_test/`; there is no `main.rs` in it, so the directory
// holds modules and never becomes a target of its own.
//
// The division is by subject. `support` is what every file shares and is bounded by: the `skip!`
// guard, `tool`, `wait_for` and the deadlines the case spends. `session` is the private X server and
// the session bus they are seen on, `windows` the X windows, `launch` the packaged artifact and the
// process it becomes, and `scenario` the one case this target exists for.
#[path = "main_window_close_pet_test/launch.rs"]
mod launch;
#[path = "main_window_close_pet_test/scenario.rs"]
mod scenario;
#[path = "main_window_close_pet_test/session.rs"]
mod session;
#[path = "main_window_close_pet_test/support.rs"]
mod support;
#[path = "main_window_close_pet_test/windows.rs"]
mod windows;
