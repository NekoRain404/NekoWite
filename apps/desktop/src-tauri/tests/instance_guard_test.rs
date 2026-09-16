//! The guard's absence, made observable — asserted against buses this test starts.
//!
//! `instance_guard::probe` answers one question: is the single-instance plugin's D-Bus name
//! owned? Everything about the answer that can be checked without a bus is a unit test in that
//! module; what is checked here is the answer itself, on a bus no other process is using, so the
//! test neither depends on the machine having a session bus nor touches the one the maintainer's
//! own instance is on.
//!
//! Three facts, in the order the app meets them:
//!
//! 1. **An unclaimed name reads as an absent guard, and the sentence names the name.** This is
//!    the launch the plugin's `_ => {}` arm makes silent (`.superpowers/sdd/roadmap/reports/`
//!    `two-instances-shared-state.md` §1's no-bus rows).
//! 2. **A claimed name reads as a held guard**, with the claim made the way the plugin makes it
//!    — the same builder, the same name — so "held" is answered about a name that really is
//!    owned rather than about a name the probe assumed.
//! 3. **A second bus answers `Absent` while the first bus's claim is still held.** That is the
//!    two-bus hole the report demonstrates with the shipped binary, and it is asserted here so
//!    the limit is a property this code has measured rather than a caveat in a comment. No
//!    probe can close it: the name is per bus.
//!
//! **One test, deliberately.** `DBUS_SESSION_BUS_ADDRESS` is process-wide and `zbus` reads it at
//! connect time, so two test functions in this file would race each other through the
//! environment. The scenarios are numbered above and run in order inside the single test.

#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use nekowite_lib::instance_guard::{bus_name, probe, GuardReport};

/// The app's own identifier, as `tauri.conf.json` carries it: the name the plugin claims in a
/// real launch, and the one this test asks about.
const IDENTIFIER: &str = "dev.nekowite.app";

/// A session bus of this test's own.
///
/// `--address=unix:tmpdir=/tmp` rather than the default: the daemon must not try to listen on
/// `$XDG_RUNTIME_DIR/bus`, which is where this user's real session bus already is. `tmpdir`
/// gives each daemon a socket of its own name under a directory it removes when it exits.
///
/// The child is killed on drop — Rust does not do that for a `Child` — so a failed assertion
/// cannot leave a daemon behind.
struct PrivateBus {
    child: Child,
    address: String,
}

impl PrivateBus {
    /// Starts a daemon, or `None` when there is none to start: `dbus-daemon` is a separate
    /// package, and a checkout without it skips the same way the engine tests skip without
    /// `binaries/opencode-*`.
    fn start() -> Option<Self> {
        let mut child = Command::new("dbus-daemon")
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
        // EOF here is a daemon that refused to start (a missing config, a socket it could not
        // bind), which is `0` bytes read rather than a hang: the address is printed once and the
        // process then waits for connections.
        if BufReader::new(stdout).read_line(&mut address).ok()? == 0 {
            let _ = child.kill();
            return None;
        }
        Some(Self {
            child,
            address: address.trim().to_string(),
        })
    }

    /// Points the process's environment at this bus, which is how `probe` finds a bus at all —
    /// it connects the way the plugin does, from `DBUS_SESSION_BUS_ADDRESS`.
    fn use_it(&self) {
        std::env::set_var("DBUS_SESSION_BUS_ADDRESS", &self.address);
    }
}

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Claims `name` the way the plugin claims it: a session connection, the well-known name, and a
/// connection that is kept alive by holding it. The object the plugin goes on to serve at that
/// name is not part of this question — ownership is what `probe` reads.
fn claim(name: &str) -> zbus::blocking::Connection {
    zbus::blocking::connection::Builder::session()
        .expect("a session bus this test started")
        .name(name.to_string())
        .expect("the derived name is a well-known D-Bus name")
        .build()
        .expect("the name is free on a bus this test just started")
}

#[test]
fn an_unclaimed_name_reads_as_an_absent_guard_and_a_claimed_one_as_held() {
    let Some(bus) = PrivateBus::start() else {
        eprintln!("skipping: dbus-daemon is not installed, so no private session bus to ask");
        return;
    };
    bus.use_it();

    let name = bus_name(IDENTIFIER);

    // 1. Nothing has claimed the name, so this is the launch that used to be silent. The
    //    sentence must name the name: it is the only thing that makes the line diagnosable, and
    //    it is what tells a reader that this build looked at the right bus.
    match probe(IDENTIFIER) {
        GuardReport::Absent(reason) => assert!(
            reason.contains(&name),
            "an absent guard has to say which name it looked for: {reason}"
        ),
        GuardReport::Held => {
            panic!("nothing has claimed {name} on a bus this test started itself")
        }
    }

    // 2. The same name, owned — the plugin's own claim, reduced to what the probe reads.
    let _held = claim(&name);
    assert_eq!(
        probe(IDENTIFIER),
        GuardReport::Held,
        "a name that is owned is a guard that armed"
    );

    // 3. A second bus is a second name space, and this is the hole the report measured on the
    //    shipped binary: the claim above is not visible from here, so the guard reads as absent
    //    while the instance holding it is still running. Skipped rather than failed if a second
    //    daemon cannot be started, because the fact under test is the first bus's invisibility
    //    and not this machine's ability to run two daemons.
    let Some(other) = PrivateBus::start() else {
        eprintln!("skipping the two-bus fact: a second dbus-daemon could not be started");
        return;
    };
    other.use_it();
    match probe(IDENTIFIER) {
        GuardReport::Absent(reason) => assert!(
            reason.contains(&name),
            "the absent guard still has to name the name: {reason}"
        ),
        GuardReport::Held => panic!(
            "{name} is claimed on the first bus, and this probe is looking at a second one — \
             a name per bus is the whole reason the report's two-bus phase has no guard"
        ),
    }
}
