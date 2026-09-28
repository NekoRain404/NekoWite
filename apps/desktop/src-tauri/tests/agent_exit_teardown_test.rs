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
//! build`'s artifact, not a `cargo build` one — see [`launch::app_under_test`]); an Xvfb of its own; a
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
//! left is the gesture the user makes, which is also the one `main_window_close_pet_test.rs` drives
//! — the file `e326a8b` put in place of `main_window_relaunch_test.rs` when it deleted that one and
//! the state it drove — with the same geometry assertion and the same retry, and for the same
//! reason: a click that arrives before the page has mounted its close handler is a click nothing
//! hears.
//!
//! **Why the pet is off for this run.** The pet's windows keep the wry runtime's window map
//! non-empty, so with them up the main window's close is not the whole quit: `lib.rs`'s `Destroyed`
//! arm closes the pet on the way out first. That the close still ends the process is
//! `main_window_close_pet_test.rs`'s subject now; the state where it left the process running is the
//! one `main_window_relaunch_test.rs` was deleted with, in `e326a8b`. Turning the pet off is not a
//! test-only state: it is a stored record the app itself writes and reads
//! (`desktop_pet/settings/store.rs`, one JSON file per domain), and both of its switches are fields
//! of the settings page. With no pet window, the main window is the last one, and its close is the
//! whole quit — one window, one close, one exit, with the engine's own teardown as the only thing on
//! the path this case is measuring.
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
//! this tree is standing (see [`launch::app_under_test`]), and a build older than its sources is a skip that
//! names the command rather than a failure.

#![cfg(target_os = "linux")]

// The target's own long argument is the doc comment above. What stays in this file is that argument,
// the module tree it is about, and the one case — `a_graceful_quit_takes_the_engine_with_it`, in the
// crate root, so the name the test runner reports is the name it has always reported.

// `#[path]` rather than a bare `mod`, because a test target's root file resolves a plain `mod x;`
// against `tests/` — the compiler says `E0583: create file "tests/x.rs"` — not against this
// directory, the rule `desktop_pet_ipc_test.rs` and `agent_settings_ipc_test.rs` state. Every path
// below points inside `tests/agent_exit_teardown_test/`; there is no `main.rs` in it, so the
// directory holds modules and never becomes a target of its own.
//
// The division is by subject, not by arithmetic:
//
//   - `support` — what every file here shares and every one of them is bounded by: the `skip!`
//     guard, `tool`, `wait_for`, and the constants the case, the launch and the process table read.
//   - `process` — the process table: a pid, its starttime, and which pids are engines under the app.
//   - `session` — the private X server and session bus those pids are seen through.
//   - `windows` — the X windows on that display, and which one is the app's main window.
//   - `launch` — the packaged binary under test, the environment it runs in, and the scratch tree.
//
// The case's own module is the crate root itself: a `#[test]` moved into a submodule is reported
// under that module's path, and this target's case has to keep the name it has always had.
#[path = "agent_exit_teardown_test/launch.rs"]
mod launch;
#[path = "agent_exit_teardown_test/process.rs"]
mod process;
#[path = "agent_exit_teardown_test/session.rs"]
mod session;
#[path = "agent_exit_teardown_test/support.rs"]
mod support;
#[path = "agent_exit_teardown_test/windows.rs"]
mod windows;

use std::fs;
use std::time::{Duration, Instant};

// `#[macro_export]` puts `skip!` in the crate root's macro namespace, so the case below calls it
// with no import of its own; the rest of the harness comes from the modules that own it.
use crate::launch::{
    app_under_test, declared_identifier, declared_size, launch_app, launch_environment,
    pet_off_record, scratch_tree,
};
use crate::process::{alive, command_line, engines_under, Proc};
use crate::session::{PrivateBus, PrivateDisplay};
use crate::support::{
    tool, wait_for, CLICK_ATTEMPTS, CLICK_SETTLE, CLOSE_DEADLINE, CLOSE_SETTLE, ENGINE_DEADLINE,
    LAUNCH_DEADLINE, STILL_GONE_SETTLE, STOPPED_SETTLE, VAULT_DEADLINE,
};

#[test]
fn a_graceful_quit_takes_the_engine_with_it() {
    let Some(xvfb) = tool("Xvfb") else {
        skip!("Xvfb is not installed, so there is no display to run a launch on");
    };
    let Some(xdotool) = tool("xdotool") else {
        skip!("xdotool is not installed, so this test cannot see or click a window");
    };
    let Some(dbus_daemon) = tool("dbus-daemon") else {
        skip!("dbus-daemon is not installed, so the app cannot claim its name");
    };
    let Some(app) = app_under_test() else {
        skip!(
            "there is no packaged build of this tree to drive. Run \
             `pnpm --filter @nekowite/desktop exec tauri build` (or set NEKOWITE_EXIT_APP to a \
             packaged executable — that is how a build from another commit, or one with the exit \
             arm taken out, is driven) and this case drives a real quit against it."
        );
    };
    let Some(display) = PrivateDisplay::start(&xvfb, &xdotool) else {
        skip!("an X server of this test's own could not be started");
    };
    let Some(bus) = PrivateBus::start(&dbus_daemon) else {
        skip!("a session bus could not be started");
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

    // The startup mask can still cover a registered vault. Its 2.5s maximum and 360ms exit
    // transition must finish before a coordinate-based click can reach the rail toggle.
    let mask_deadline = Duration::from_millis(3000);
    if let Some(remaining) = mask_deadline.checked_sub(started.elapsed()) {
        std::thread::sleep(remaining);
    }

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
