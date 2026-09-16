//! Whether this process's single-instance guard actually armed.
//!
//! `tauri_plugin_single_instance` is what keeps a second launch from becoming a second instance,
//! and on Linux it does that with a **D-Bus well-known name** on the session bus: the app's
//! identifier plus `.SingleInstance`. A second launch finds the name taken, calls the first
//! instance's callback and exits — and every other outcome is swallowed. The plugin's own match
//! (`tauri-plugin-single-instance 2.4.4`, `platform_impl/linux.rs:56-89`) manages a **private**
//! state type on success and exits on `NameTaken`; a third arm, `_ => {}`, covers everything
//! else, so a launch that reaches no bus at all is a launch with no guard and nothing said about
//! it. Nothing in this app could tell that apart from a guard that worked, which is the hole
//! this module closes: it asks the bus the same question the plugin's claim answered.
//!
//! **It reports. It does not decide.** Refusing to start, warning in a window, or carrying on
//! unchanged are policies with an owner above this file — `.superpowers/sdd/roadmap/reports/`
//! `two-instances-shared-state.md` §4 proposes a profile-scoped lock and leaves that decision to
//! the maintainer — so what leaves this module is one log line, and only when the guard is
//! absent.
//!
//! **What the answer is worth, in both directions.**
//!
//! * *Owned* means this process's guard armed, on the bus it reached — and nothing about the
//!   machine. The name lives on one session bus, so two instances on two buses (a nested
//!   session, a container with its own bus, a launcher that wraps the app) each hold their own
//!   name while the other runs. That case is demonstrated in the report's §1 and this probe
//!   cannot see across buses at all; the guard it reports on is a guard for *this* bus.
//! * *Not owned* means the guard did not arm. That is the condition that used to leave no trace
//!   anywhere, and it is the one worth a line: two instances then share one profile — engine
//!   sessions, settings and the credential store — with no arbiter between them (§2-§3).
//!
//! The probe reads a claim that has already been made, and the ordering is not incidental: the
//! plugin claims the name while the app is being built (`initialize_plugins`), and this runs
//! from `App::setup`, which Tauri invokes later on `RunEvent::Ready`. Called any earlier it
//! would report an absent guard on every launch of a healthy app.

/// The suffix the plugin appends to the app's identifier.
///
/// Read out of `tauri-plugin-single-instance` 2.4.4's `platform_impl/linux.rs:38`
/// (`dbus_name.push_str(".SingleInstance")`), which the crate does not export — so this is the
/// one thing here that could drift from the plugin. If it ever does, the probe reports an
/// absent guard on every launch: a false alarm in the log rather than a missed one, and the
/// message names the exact name it looked for, so the drift is legible from one line of output.
const PLUGIN_NAME_SUFFIX: &str = ".SingleInstance";

/// The well-known name the plugin claims for `identifier`.
///
/// Derived rather than written down: the plugin builds it from `app.config().identifier`, which
/// is the same string this app's own config carries, so a renamed identifier moves both.
pub fn bus_name(identifier: &str) -> String {
    format!("{identifier}{PLUGIN_NAME_SUFFIX}")
}

/// What the bus said about this process's guard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardReport {
    /// The name is owned, so the plugin's claim succeeded: a second launch on this bus meets it
    /// and exits. It says nothing about another bus.
    Held,
    /// The name is not owned while this process is starting, so the plugin's claim failed and
    /// its `_ => {}` arm swallowed the reason. The string is that reason, in the shape of a
    /// clause that can follow "the guard did not arm: …" — see [`report`] for the whole line.
    Absent(String),
}

/// Ask the session bus whether the guard's name is owned.
///
/// The connect is the plugin's own, against the same environment, so an unreachable bus fails
/// here for the reason it failed there — and as fast, which matters because this runs before any
/// window exists. "Unreachable" is both shapes the report measured: an address naming no socket,
/// and no address at all, where zbus falls back to `$XDG_RUNTIME_DIR/bus`
/// (`zbus-5.19.0/src/address/mod.rs:67-87`) and finds no socket there either.
pub fn probe(identifier: &str) -> GuardReport {
    let name = bus_name(identifier);
    let connection = match zbus::blocking::Connection::session() {
        Ok(connection) => connection,
        Err(error) => {
            return GuardReport::Absent(format!("the session bus is unreachable ({error})"));
        }
    };
    // The name is answered by the bus daemon itself, which is the only peer on the bus that may
    // be assumed to exist — a proxy on any other destination would be a second failure mode
    // dressed up as an answer about our own name.
    let bus = match zbus::blocking::fdo::DBusProxy::new(&connection) {
        Ok(bus) => bus,
        Err(error) => {
            return GuardReport::Absent(format!(
                "the session bus did not answer on org.freedesktop.DBus ({error})"
            ));
        }
    };
    let Ok(owned_name) = zbus::names::BusName::try_from(name.as_str()) else {
        // The plugin unwraps this same conversion (`linux.rs:59`), so reaching here means it
        // panicked before this code ran. Named rather than unwrapped anyway: a guard that could
        // not arm must never be reported as one that did.
        return GuardReport::Absent(format!("{name} is not a valid D-Bus name"));
    };
    match bus.name_has_owner(owned_name) {
        Ok(true) => GuardReport::Held,
        Ok(false) => GuardReport::Absent(format!("nothing on the session bus owns {name}")),
        Err(error) => GuardReport::Absent(format!(
            "the session bus did not answer the ownership question for {name} ({error})"
        )),
    }
}

/// Report an absent guard to the log, and say nothing when it held.
///
/// Silence on the ordinary desktop is the point: this file exists to make a failure legible, not
/// to add a line to every healthy launch — a message that always appears is one nobody reads.
/// The sentence names the consequence because the reader is usually whoever is holding the
/// process's stderr afterwards, not the person at the window, and "two instances are sharing
/// this profile" is what they need to know they are looking at.
pub fn report(app: &tauri::AppHandle) {
    let identifier = app.config().identifier.clone();
    if let GuardReport::Absent(reason) = probe(&identifier) {
        eprintln!(
            "nekowite: the single-instance guard did not arm: {reason}. A second launch would \
             run alongside this one, sharing this profile's agent sessions, its settings and its \
             credential store."
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_is_the_identifier_plus_the_plugins_suffix() {
        // The app's real identifier, as `tauri.conf.json` carries it. This is the name the
        // harness's `dbus-send NameHasOwner` probes and the one the plugin claims; the assertion
        // is here so a change to the derivation has to be a deliberate edit.
        assert_eq!(
            bus_name("dev.nekowite.app"),
            "dev.nekowite.app.SingleInstance"
        );
        assert_eq!(PLUGIN_NAME_SUFFIX, ".SingleInstance");
    }

    // Everything else this module does needs a bus to answer on, so it is asserted in
    // `tests/instance_guard_test.rs`, against a bus the test starts itself.
}
