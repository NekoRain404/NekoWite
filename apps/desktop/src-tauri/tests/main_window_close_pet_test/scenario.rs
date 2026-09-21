//! The case: closing the main window takes the pet — and the process — with it.
//!
//! `closing_the_main_window_takes_the_pet_and_the_process_with_it` below is the original case, moved
//! whole: same name, same body, same assertions, same timing thresholds and comments. It is this
//! target's only case, and the reason every other file in this directory exists.
//!
//! The long argument about *why* each hop of the run is real — the packaged binary, the private X
//! server and session bus, the pet's own windows opened from the app's defaults, the app's own close
//! button — is the doc comment of the target root, `tests/main_window_close_pet_test.rs`, because it
//! argues about the case as a whole rather than about these lines.

use std::process::ExitStatus;
use std::time::{Duration, Instant};

use crate::launch::{app_under_test, declared_size, launch_app, launch_environment, scratch_tree};
use crate::session::{PrivateBus, PrivateDisplay};
use crate::support::{
    skip, tool, wait_for, CLICK_ATTEMPTS, CLICK_SETTLE, CLOSE_SETTLE, LAUNCH_DEADLINE,
    PET_CLOSE_SETTLE, PET_DEADLINE,
};

// ---------------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------------

#[test]
fn closing_the_main_window_takes_the_pet_and_the_process_with_it() {
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
             packaged executable — that is how a build without the close arm is driven) and this \
             case drives a real quit against it."
        );
    };
    let Some(display) = PrivateDisplay::start(&xvfb, &xdotool) else {
        skip!("an X server of this test's own could not be started");
    };
    let Some(bus) = PrivateBus::start(&dbus_daemon) else {
        skip!("a session bus could not be started");
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
