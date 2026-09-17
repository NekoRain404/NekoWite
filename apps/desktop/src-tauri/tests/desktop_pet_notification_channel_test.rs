//! The system channel, measured against a session bus this test starts itself.
//!
//! `notification_delivery.rs`'s port had one implementation for the whole of D5 and D15 — a channel
//! that always fails — so every rule the ledger holds about a *delivery* was exercised against a
//! double and none of it against a bus. This target is where the real one is measured, and it
//! measures the two arms the port ledger held the dependency back for
//! (`docs/architecture/desktop-pet-port-ledger.md` §3: 「在 AppImage/deb/rpm 与无 portal 环境下是否可用
//! 必须实测」).
//!
//! **A bus of this test's own, and not the one the maintainer is sitting at.** `dbus-daemon` is
//! started per test with `--address=unix:tmpdir=/tmp`, so nothing here touches the real session's
//! notifications: a test that raised toasts on the developer's desktop would be a test nobody could
//! run twice. The address is handed to the channel directly rather than through
//! `DBUS_SESSION_BUS_ADDRESS`, because the environment is process-wide and two cases in one file
//! would race each other through it — the constraint `instance_guard_test.rs` records, removed here
//! because it does not have to exist.
//!
//! **Both directions, because one of them alone is a lie either way.** A channel that answers `Ok`
//! whatever happens is the failure this module's header argues against; a channel that answers
//! `NoChannel` on a working desktop is the same failure from the other side. So:
//!
//! 1. **Nothing owns the name → `no-channel`.** This is the bare session the port ledger names —
//!    no daemon, no portal, nothing to raise a toast with — and the row stays unread for §7.2's
//!    `unread-list` fallback. On a desktop this case is *harder* to arrive at than the name
//!    suggests: see [`BUS_CONFIG`].
//! 2. **A daemon that answers → `Ok`, and what it was handed.** The test serves
//!    `org.freedesktop.Notifications` at its own object path and records the call, so "the notice
//!    went out" is answered about a daemon that really received it rather than about a call that
//!    returned without error.
//! 3. **A name that is owned and answers nothing at that path → `channel`.** Neither of the other
//!    two: the bus exists, the daemon is not there.
//!
//! What this target deliberately cannot measure is the last inch — that the desktop *drew* the
//! toast. Nothing in a headless test can, and the honest record of that measurement is in the
//! report that accompanied this change, not in a green line here.

#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use nekowite_lib::desktop_pet::notification_delivery::{
    DeliveryFailure, NotificationDelivery, PetNotice, SystemNotifications,
};
use nekowite_lib::desktop_pet::task_projection::PetTaskState;

/// The destination and path under test: the desktop notification specification's own, spelled here
/// as literals so that a change to the channel's constants fails this target rather than moving
/// with it. The interface's own spelling is pinned as well, by the `#[zbus::interface]` attribute
/// below: a channel that called a different interface at this path would reach no method here and
/// fail every case that expects a delivery.
const SERVICE: &str = "org.freedesktop.Notifications";
const OBJECT: &str = "/org/freedesktop/Notifications";

/// The bus configuration these tests run on: the system's session policy, with **service
/// activation removed**.
///
/// That one line is the difference between measuring something and measuring nothing. A stock
/// session bus activates `org.freedesktop.Notifications` from
/// `/usr/share/dbus-1/services/org.kde.plasma.Notifications.service` (or mako's, or dunst's) the
/// moment anything addresses it — measured here, on this machine, before this file was written: a
/// plain `dbus-daemon --session` answered `GetCapabilities` with a daemon's own capability list,
/// having started one on demand. A bus that can conjure a daemon is a bus on which "no daemon" is
/// unmeasurable, and it is also a fact worth knowing in the other direction: on a real desktop this
/// name is almost always resolvable, which is why the arm below is the *harder* one to produce and
/// not the common one.
///
/// Everything else is the system's own policy verbatim, so this is not a bus with rules invented to
/// make a test pass.
const BUS_CONFIG: &str = r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"#;

/// Which bus this is, for the config file's name. See [`PrivateBus::start`].
static NEXT_BUS: AtomicUsize = AtomicUsize::new(0);

/// A session bus of this test's own.
///
/// `unix:tmpdir=/tmp` rather than the default, so the daemon never tries to listen on
/// `$XDG_RUNTIME_DIR/bus` — where this user's real session bus already is. The child and the config
/// file are removed on drop, because Rust does neither for a `Child`, so a failed assertion cannot
/// leave a daemon behind.
struct PrivateBus {
    child: Child,
    config: PathBuf,
    address: String,
}

impl PrivateBus {
    /// Starts a daemon and fails loudly when there is none to start.
    ///
    /// Not a skip: `dbus-daemon` is the package the whole feature runs on, this project is
    /// Linux-only, and its own app already needs a session bus for the single-instance guard — so a
    /// machine that cannot start one is a machine on which nothing here can be claimed, and a
    /// message saying which package is missing is more use than a green run.
    fn start() -> Self {
        // One config file per bus rather than one per process: the cases in this file run in
        // parallel threads, and a shared path is a file one test's cleanup deletes while another
        // test's daemon is still reading it — which is a bus that never prints its address, and a
        // failure that has nothing to do with what is being measured.
        let config = std::env::temp_dir().join(format!(
            "nekowite-no-activation-{}-{}.conf",
            std::process::id(),
            NEXT_BUS.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&config, BUS_CONFIG).expect("a config file this test can write");
        let mut child = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--print-address=1", "--nofork"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("dbus-daemon is installed (the `dbus` package) — this feature is D-Bus all the way down");
        let stdout = child.stdout.take().expect("the pipe just asked for");
        let mut address = String::new();
        // EOF here is a daemon that refused to start (a missing config, a socket it could not
        // bind), which is `0` bytes read rather than a hang: the address is printed once and the
        // process then waits for connections.
        let read = BufReader::new(stdout).read_line(&mut address).unwrap_or(0);
        assert!(
            read > 0,
            "dbus-daemon started but printed no address, so no bus was measured"
        );
        Self {
            child,
            config,
            address: address.trim().to_string(),
        }
    }

    /// This bus's address, which the channel under test is pointed at.
    fn address(&self) -> &str {
        &self.address
    }
}

impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.config);
    }
}

/// One call the fake daemon was handed, kept whole so the assertions can be about what a desktop
/// would have drawn rather than about a call having happened.
#[derive(Clone, Debug, Default)]
struct Received {
    summary: String,
    body: String,
    hints: HashMap<String, bool>,
    expire_timeout: i32,
}

/// A notification daemon that answers.
struct FakeDaemon {
    received: Arc<Mutex<Vec<Received>>>,
    /// Held for the daemon's lifetime: the name is owned for exactly as long as this connection is
    /// alive, which is what makes the ownership real rather than assumed.
    _connection: zbus::blocking::Connection,
}

impl FakeDaemon {
    /// Claims `org.freedesktop.Notifications` on `address` and serves the one method the channel
    /// calls.
    fn serve(address: &str) -> Self {
        let received = Arc::new(Mutex::new(Vec::new()));
        let connection = zbus::blocking::connection::Builder::address(address)
            .expect("the address a bus just printed")
            .name(SERVICE.to_string())
            .expect("the specification's own name")
            .serve_at(
                OBJECT,
                Daemon {
                    received: received.clone(),
                },
            )
            .expect("the object path a daemon serves")
            .build()
            .expect("the name is free on a bus this test just started");
        Self {
            received,
            _connection: connection,
        }
    }

    fn received(&self) -> Vec<Received> {
        self.received
            .lock()
            .expect("the recorder's lock is never held across a panic")
            .clone()
    }
}

/// The object served at `/org/freedesktop/Notifications`.
struct Daemon {
    received: Arc<Mutex<Vec<Received>>>,
}

#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Daemon {
    /// The specification's `Notify`, with every argument named, so a channel that passed its body
    /// where its summary belongs is caught rather than silently accepted.
    #[allow(clippy::too_many_arguments)]
    fn notify(
        &self,
        _app_name: String,
        _replaces_id: u32,
        _app_icon: String,
        summary: String,
        body: String,
        _actions: Vec<String>,
        hints: HashMap<String, zbus::zvariant::OwnedValue>,
        expire_timeout: i32,
    ) -> u32 {
        let hints = hints
            .into_iter()
            .filter_map(|(key, value)| Some((key, bool::try_from(value).ok()?)))
            .collect();
        self.received
            .lock()
            .expect("the recorder's lock is never held across a panic")
            .push(Received {
                summary,
                body,
                hints,
                expire_timeout,
            });
        // The daemon's own id for the notification, which the specification says is never zero.
        1
    }
}

/// One notice, built the way the ledger builds one.
fn notice(state: PetTaskState, sound: bool) -> PetNotice {
    PetNotice {
        state,
        count: 1,
        // No target: §7.2's rule for a notice that stands for no single task, and the shape a
        // merged completion burst reaches the channel in.
        target: None,
        permission_request_id: None,
        label: None,
        sound,
    }
}

#[test]
fn a_session_with_no_daemon_reports_no_channel() {
    let bus = PrivateBus::start();
    let mut channel = SystemNotifications::at(bus.address());

    let failure = channel
        .deliver(&notice(PetTaskState::Failed, true))
        .expect_err("nothing on a bus this test started owns org.freedesktop.Notifications");

    assert_eq!(
        failure.kind(),
        "no-channel",
        "a session with nothing to raise a toast with is D3's system-notification finding"
    );
    assert!(
        failure.detail().contains(SERVICE),
        "the reason names what was looked for, so the line is diagnosable: {failure:?}"
    );
}

#[test]
fn a_session_bus_that_is_not_there_at_all_reports_no_channel() {
    // The other shape of the same finding, and the one a nested session or a container produces:
    // the address is real syntax and there is no socket behind it. It has to be the same arm as a
    // bus with no daemon on it — from the user's side there is nothing to show a notification
    // either way — and not a `channel` failure, which would say a daemon exists and misbehaved.
    let mut channel = SystemNotifications::at("unix:path=/nonexistent/nekowite-test-bus");

    let failure = channel
        .deliver(&notice(PetTaskState::Failed, true))
        .expect_err("there is no bus at that address");

    assert_eq!(failure.kind(), "no-channel");
}

#[test]
fn a_daemon_that_answers_is_a_delivery_and_is_handed_what_the_notice_says() {
    let bus = PrivateBus::start();
    let daemon = FakeDaemon::serve(bus.address());
    let mut channel = SystemNotifications::at(bus.address());

    let waiting = notice(PetTaskState::WaitingInput, true);
    channel
        .deliver(&waiting)
        .expect("a daemon answered, so this is a delivery");

    let received = daemon.received();
    assert_eq!(received.len(), 1, "one notice, one call");
    assert_eq!(received[0].summary, waiting.title());
    assert_eq!(received[0].body, waiting.body());
    // §6.3: the title names the app and not the note, because the notice carries no label unless
    // the user asked for task names — and nothing else about the task reaches the desktop.
    assert_eq!(received[0].summary, "NekoWite");
    assert!(
        !received[0].hints.contains_key("suppress-sound"),
        "a notice the user asked to hear is not silenced by this side"
    );
    // §6.2: a permission request is a question the user has to answer, and the one notice that must
    // not slide off the screen while they are looking elsewhere.
    assert_eq!(
        received[0].expire_timeout, 0,
        "a waiting-input notice stays until it is answered"
    );
}

#[test]
fn a_notice_the_user_asked_to_hear_silently_is_sent_with_the_suppression_hint() {
    let bus = PrivateBus::start();
    let daemon = FakeDaemon::serve(bus.address());
    let mut channel = SystemNotifications::at(bus.address());

    channel
        .deliver(&notice(PetTaskState::TurnFinished, false))
        .expect("a daemon answered");

    let received = daemon.received();
    assert_eq!(received.len(), 1);
    assert_eq!(
        received[0].hints.get("suppress-sound"),
        Some(&true),
        "the sound switch reaches the desktop as the specification's own hint, and not as a \
         promise this side cannot keep"
    );
    assert_eq!(
        received[0].expire_timeout, -1,
        "a settled ending takes the daemon's own timeout"
    );
}

#[test]
fn a_daemon_that_takes_the_name_and_answers_nothing_is_a_channel_failure() {
    let bus = PrivateBus::start();
    // A claim, and no object behind it: the shape of a daemon that crashed between owning the name
    // and serving the path, and the one arm of `DeliveryFailure` that is neither of the other two.
    let _holder = zbus::blocking::connection::Builder::address(bus.address())
        .expect("the address a bus just printed")
        .name(SERVICE.to_string())
        .expect("the specification's own name")
        .build()
        .expect("the name is free on a bus this test just started");
    let mut channel = SystemNotifications::at(bus.address());

    let failure = channel
        .deliver(&notice(PetTaskState::Failed, true))
        .expect_err("nothing is served at the object path");

    assert_eq!(
        failure.kind(),
        "channel",
        "a channel exists and could not carry this notice — not the same finding as no channel \
         (it was {failure:?})"
    );
    assert!(
        matches!(failure, DeliveryFailure::Channel { .. }),
        "the arm is the daemon's trouble, which may be transient: {failure:?}"
    );
}
