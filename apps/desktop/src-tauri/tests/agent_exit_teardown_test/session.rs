//! A private X server and a private session bus, so a launch touches neither the developer's
//! display nor their bus.
//!
//! The screen size is asked for rather than assumed: the display number is chosen by pid, and a server
//! some other run left on that number would otherwise satisfy "the display is up" while its screen has
//! another size — measured, and it is how a run of this case once placed the window at a negative
//! offset. `-extension GLX` is part of the same measurement; the comment where it is passed says why.
//!
//! `PrivateDisplay` and `PrivateBus` are `pub` because the case owns them for the length of a run.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use crate::support::{wait_for, SCREEN};

// ---------------------------------------------------------------------------
// A private X server and a private session bus
// ---------------------------------------------------------------------------

/// A private X server, so nothing here touches the display the developer is using.
pub struct PrivateDisplay {
    child: Child,
    pub name: String,
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
    pub fn start(xvfb: &Path, xdotool: &Path) -> Option<Self> {
        for offset in 0..20 {
            let number = 90 + (std::process::id() % 20 + offset) % 20;
            let name = format!(":{number}");
            let mut child = Command::new(xvfb)
                // **`-extension GLX`, because nothing here needs GLX and a broken one costs the run.**
                // Measured on this workstation: plain `Xvfb :N -screen 0 <SCREEN> -nolisten tcp`
                // segfaults while initialising GLX (`libEGL_nvidia` reached through `swrast_dri`),
                // so the display never comes up, the case skips, and the suite reports it as passed.
                // The same command with GLX disabled answers `xdotool getdisplaygeometry`. The app
                // under test renders through WebKitGTK over X11, and every assertion below is about a
                // window, a pid or a geometry — none of which is GLX.
                .args([
                    &name,
                    "-screen",
                    "0",
                    SCREEN,
                    "-nolisten",
                    "tcp",
                    "-extension",
                    "GLX",
                ])
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
pub struct PrivateBus {
    child: Child,
    pub address: String,
}

impl PrivateBus {
    pub fn start(dbus_daemon: &Path) -> Option<Self> {
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
