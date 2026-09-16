//! What this machine can do, and what the app says instead (§7.2).
//!
//! The interesting property is not that the table has eleven rows; it is which rows can be moved
//! and by what. A compositor-dependent capability becomes `available` only through an
//! `Observations` entry — something the app was seen to do — so nothing here can be reported as
//! working on the strength of a builder flag. `window-climb` is the other direction: it is
//! unavailable by our own admission rather than the machine's, and no observation can promote it.
//!
//! The last test reads `pet-contracts/platform.ts` rather than a copy of it. D1 froze both
//! vocabularies, and the second spelling of a vocabulary is the one that drifts.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::desktop_pet::linux_capabilities::{
    self, Desktop, DisplaySession, Finding, LinuxEnvironment, Observations, Observed,
};

fn environment(pairs: &[(&str, &str)]) -> LinuxEnvironment {
    let map: BTreeMap<String, String> = pairs
        .iter()
        .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
        .collect();
    LinuxEnvironment::from_env(|name| map.get(name).cloned())
}

#[test]
fn every_capability_is_reported_exactly_once_in_the_contract_order() {
    let reports = linux_capabilities::report(&environment(&[]), &Observations::new());

    let names: Vec<&str> = reports.iter().map(|report| report.capability).collect();
    assert_eq!(names, linux_capabilities::CAPABILITIES);
    assert_eq!(names.len(), 11);
}

#[test]
fn nothing_compositor_shaped_is_available_before_it_has_been_observed() {
    let reports = linux_capabilities::report(
        &environment(&[
            ("XDG_CURRENT_DESKTOP", "KDE"),
            ("XDG_SESSION_TYPE", "wayland"),
        ]),
        &Observations::new(),
    );

    // §12 puts the matrix in D13, and §7.2 forbids describing an untried capability as working.
    // The one exception is a statement about our own code rather than about a compositor.
    for report in &reports {
        if report.capability == linux_capabilities::WINDOW_CLIMB {
            assert!(
                matches!(report.finding, Finding::Unavailable { .. }),
                "climb is not implemented, so it is not merely unverified"
            );
        } else {
            assert!(
                matches!(report.finding, Finding::Unverified { .. }),
                "{} claimed {:?} with no observation",
                report.capability,
                report.finding
            );
        }
    }
}

#[test]
fn an_observation_is_what_makes_a_capability_available() {
    let mut observed = Observations::new();
    observed
        .record("window-transparency", Observed::Worked)
        .expect("a capability");
    observed
        .record(
            "drag",
            Observed::Degraded("only the compositor's own gesture".into()),
        )
        .expect("a capability");
    observed
        .record(
            "pointer-follow",
            Observed::Refused("no global pointer".into()),
        )
        .expect("a capability");
    assert_eq!(observed.len(), 3);

    let reports = linux_capabilities::report(&environment(&[]), &observed);
    let finding = |name: &str| {
        reports
            .iter()
            .find(|report| report.capability == name)
            .expect("a known capability")
            .finding
            .clone()
    };

    assert_eq!(finding("window-transparency"), Finding::Available);
    assert!(matches!(
        finding("drag"),
        Finding::Degraded {
            fallback: "clamped-position",
            ..
        }
    ));
    assert!(matches!(
        finding("pointer-follow"),
        Finding::Unavailable {
            fallback: "stay-only",
            ..
        }
    ));
    // Untouched capabilities are untouched: an observation is per capability, not a mode.
    assert!(matches!(
        finding("always-on-top"),
        Finding::Unverified { .. }
    ));
}

#[test]
fn window_climb_is_unavailable_even_when_an_observation_says_it_worked() {
    let mut observed = Observations::new();
    observed
        .record(linux_capabilities::WINDOW_CLIMB, Observed::Worked)
        .expect("the name is in the vocabulary, so recording it is not an error");

    let reports = linux_capabilities::report(&environment(&[]), &observed);
    let climb = reports
        .iter()
        .find(|report| report.capability == linux_capabilities::WINDOW_CLIMB)
        .expect("climb is always reported");

    // §7.2: 「不复制 Win32；作为单独平台适配任务，不伪装已支持」. This is the arm an observation may not
    // move — a result recorded here would be evidence about something other than the mode, and a
    // Linux implementation replaces this arm rather than filling it in.
    assert!(matches!(
        climb.finding,
        Finding::Unavailable {
            fallback: "not-offered",
            ..
        }
    ));
}

#[test]
fn every_non_available_finding_carries_a_fallback_from_the_contract() {
    let mut observed = Observations::new();
    observed
        .record(
            "always-on-top",
            Observed::Refused("the compositor ignored it".into()),
        )
        .expect("a capability");

    for report in linux_capabilities::report(&environment(&[]), &observed) {
        match report.finding {
            Finding::Available => {}
            Finding::Degraded {
                fallback,
                ref detail,
            }
            | Finding::Unavailable {
                fallback,
                ref detail,
            }
            | Finding::Unverified {
                fallback,
                ref detail,
            } => {
                assert!(
                    linux_capabilities::is_fallback(fallback),
                    "{} reports the fallback {fallback}, which the contract does not have",
                    report.capability
                );
                assert!(
                    !detail.trim().is_empty(),
                    "{} explains nothing",
                    report.capability
                );
            }
        }
    }
}

#[test]
fn an_observation_against_an_unknown_capability_is_rejected() {
    let mut observed = Observations::new();

    assert_eq!(
        observed.record("teleport", Observed::Worked),
        Err(linux_capabilities::UnknownCapability { name: "teleport" })
    );
    assert!(observed.is_empty());
}

#[test]
fn the_environment_is_read_from_the_session_rather_than_assumed() {
    let kde = environment(&[
        ("XDG_CURRENT_DESKTOP", "KDE"),
        ("XDG_SESSION_TYPE", "wayland"),
        ("WAYLAND_DISPLAY", "wayland-0"),
    ]);
    assert_eq!(kde.desktop, Desktop::Kde);
    assert_eq!(kde.session, DisplaySession::Wayland);

    // Ubuntu sets `ubuntu:GNOME`, so a check for `"GNOME"` on the whole string would report the
    // most common GNOME session there is as unrecognised.
    let ubuntu = environment(&[
        ("XDG_CURRENT_DESKTOP", "ubuntu:GNOME"),
        ("XDG_SESSION_TYPE", "x11"),
    ]);
    assert_eq!(ubuntu.desktop, Desktop::Gnome);
    assert_eq!(ubuntu.session, DisplaySession::X11);

    let niri = environment(&[("XDG_CURRENT_DESKTOP", "niri")]);
    assert_eq!(niri.desktop, Desktop::Other("niri".to_string()));

    // `XDG_SESSION_TYPE` is unset when a session is started directly; the socket is the same fact
    // observed another way, and falling straight through to `Unknown` would lose it.
    let socket_only = environment(&[("WAYLAND_DISPLAY", "wayland-0")]);
    assert_eq!(socket_only.session, DisplaySession::Wayland);

    let nothing = environment(&[]);
    assert_eq!(nothing.desktop, Desktop::Unknown);
    assert_eq!(nothing.session, DisplaySession::Unknown);
    assert_eq!(
        nothing.describe(),
        "an unrecognised desktop on an unrecognised display session"
    );

    // The real reader, not only the injected one: `observe()` is what the command layer calls, and
    // a machine it can say *something* about is the difference between a finding that names an
    // environment and one that only says "no".
    assert!(!LinuxEnvironment::observe().describe().is_empty());
}

#[test]
fn the_unverified_detail_names_the_environment_it_was_not_measured_on() {
    let kde = environment(&[
        ("XDG_CURRENT_DESKTOP", "KDE"),
        ("XDG_SESSION_TYPE", "wayland"),
    ]);
    let reports = linux_capabilities::report(&kde, &Observations::new());
    let transparency = &reports[0];

    assert_eq!(transparency.capability, "window-transparency");
    let Finding::Unverified { fallback, detail } = &transparency.finding else {
        panic!(
            "nothing has been measured on this machine: {:?}",
            transparency.finding
        );
    };
    assert_eq!(*fallback, "closable-window");
    // "not measured" is only useful when it says where, which is what §12's matrix is for.
    assert!(detail.contains(&kde.describe()), "{detail}");
    assert!(
        detail.contains("closable-window") || detail.contains("title bar"),
        "{detail}"
    );
}

#[test]
fn the_rust_vocabulary_is_the_typescript_one() {
    // The second spelling of a vocabulary is the one that drifts. D1 froze these two lists in
    // `pet-contracts/platform.ts`, so this reads that file rather than a copy, and a capability
    // added on either side alone fails here.
    let platform = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/platform/gateways/pet-contracts/platform.ts");
    let text =
        fs::read_to_string(&platform).unwrap_or_else(|error| panic!("{platform:?}: {error}"));

    let capabilities = quoted(&slice_between(&text, "PET_CAPABILITIES = [", "] as const"));
    assert_eq!(capabilities, linux_capabilities::CAPABILITIES.to_vec());

    let fallbacks = quoted(&slice_between(
        &text,
        "export type PetFallback =",
        "\n\n/**",
    ));
    assert_eq!(fallbacks, linux_capabilities::FALLBACKS.to_vec());
}

/// The text between two markers, or a panic naming the marker that moved.
fn slice_between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text
        .find(start)
        .unwrap_or_else(|| panic!("{start} is not in the contract"));
    let rest = &text[from + start.len()..];
    let to = rest
        .find(end)
        .unwrap_or_else(|| panic!("{end} does not follow {start} in the contract"));
    &rest[..to]
}

/// Every single-quoted string in a slice, in order.
fn quoted(slice: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = slice;
    while let Some(open) = rest.find('\'') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('\'') else { break };
        names.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    names
}
