/**
 * What this machine can do, and what the app does instead (§7.2) — as it actually is.
 *
 * §7.2 is a table of capabilities with a fallback for each, and its governing rule is that an
 * unavailable capability is *stated*, never faked: 「不宣称像素命中检测等于系统穿透」, and window
 * climbing has no Linux implementation upstream — 「不复制 Win32；作为单独平台适配任务，不伪装已
 * 支持」. This module is where that rule becomes data the settings page and the task list can show.
 *
 * The honest position today is that almost nothing has been measured. §12 puts the GNOME/KDE ×
 * Wayland/X11 matrix in D13 and requires an environment that could not be obtained to be marked
 * unverified rather than described as working, so:
 *
 * - A capability becomes `available` only through an {@link Observations} entry — something the
 *   app was seen to do on this machine, not something a builder flag asked for. Recording one is
 *   D13's job; the mechanism is here so that the entry has somewhere to land.
 * - Everything compositor-dependent is `unverified` while no observation exists. That is not a
 *   synonym for `unavailable`: calling an untried thing unsupported is as wrong as calling it
 *   supported, which is why D1's vocabulary has a status for it at all.
 * - `window-climb` is the one `unavailable`, and it is a statement about *us*: upstream enumerates
 *   windows through Win32 only (`sys_windows.rs:128-129` returns an empty list elsewhere) and the
 *   plan forbids porting that, so nothing here implements the mode to observe. An observation
 *   cannot promote it — a Linux implementation changes that arm, rather than recording a result.
 *
 * Two vocabularies are reused rather than re-declared: §7.2's rows are D1's `PET_CAPABILITIES`
 * and its third column is D1's `PetFallback` (`apps/desktop/src/platform/gateways/pet-contracts/
 * platform.ts:14-59`). A second spelling of either would be a second answer to the same question,
 * so the lists below are pinned to the TypeScript by `tests/desktop_pet_ipc_test.rs`, which reads
 * that file rather than a copy of it.
 */
use std::collections::BTreeMap;

use serde::Serialize;

/// §7.2's rows, in D1's order.
pub const CAPABILITIES: [&str; 11] = [
    "window-transparency",
    "window-borderless",
    "always-on-top",
    "no-focus-steal",
    "drag",
    "position-restore",
    "pointer-passthrough",
    "pointer-follow",
    "window-climb",
    "system-notification",
    "notification-actions",
];

/// §7.2's third column, in D1's order.
pub const FALLBACKS: [&str; 8] = [
    "none",
    "docked-window",
    "closable-window",
    "clamped-position",
    "compact-window",
    "stay-only",
    "unread-list",
    "not-offered",
];

/// The one capability that is a determination rather than a measurement. See this file's header.
pub const WINDOW_CLIMB: &str = "window-climb";

pub fn is_capability(name: &str) -> bool {
    CAPABILITIES.contains(&name)
}

pub fn is_fallback(name: &str) -> bool {
    FALLBACKS.contains(&name)
}

/// Which desktop is running.
///
/// Named because §12 asks for the matrix per desktop, and because a finding that does not say
/// which environment it was made in cannot be acted on: "not measured" is useful, "not measured
/// on the machine you are using" is what a user can report.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Desktop {
    Gnome,
    Kde,
    Other(String),
    Unknown,
}

impl Desktop {
    /// From `XDG_CURRENT_DESKTOP`.
    ///
    /// Read as a colon-separated list and matched token-wise rather than by equality: Ubuntu sets
    /// `XDG_CURRENT_DESKTOP=ubuntu:GNOME`, so a check for `"GNOME"` on the whole string would
    /// report the most common GNOME session there is as unrecognised.
    fn from_env(current: Option<&str>) -> Self {
        let Some(value) = current else {
            return Self::Unknown;
        };
        let tokens: Vec<&str> = value
            .split(':')
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .collect();
        if tokens
            .iter()
            .any(|token| token.eq_ignore_ascii_case("gnome"))
        {
            Self::Gnome
        } else if tokens.iter().any(|token| token.eq_ignore_ascii_case("kde")) {
            Self::Kde
        } else {
            match tokens.first() {
                Some(token) => Self::Other((*token).to_string()),
                None => Self::Unknown,
            }
        }
    }
}

/// Which display protocol the session speaks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DisplaySession {
    Wayland,
    X11,
    Unknown,
}

impl DisplaySession {
    fn from_env(session: Option<&str>, wayland_socket: bool) -> Self {
        match session.map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("wayland") => Self::Wayland,
            Some(value) if value.eq_ignore_ascii_case("x11") => Self::X11,
            // `XDG_SESSION_TYPE` is unset when a session is started directly (`dbus-run-session`,
            // some display managers). A Wayland socket is the same fact observed a second way, so
            // it is read rather than falling straight through to `Unknown`.
            _ if wayland_socket => Self::Wayland,
            _ => Self::Unknown,
        }
    }
}

/// The display environment, as read from the session.
///
/// Read rather than assumed, and used only in the wording of a finding: a variable that says KDE
/// is not a compositor that honoured anything, which is why nothing here decides a status.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LinuxEnvironment {
    pub desktop: Desktop,
    pub session: DisplaySession,
}

impl LinuxEnvironment {
    /// Built from a name lookup so a test can be any machine (§10.2).
    pub fn from_env(read: impl Fn(&str) -> Option<String>) -> Self {
        let wayland_socket = read("WAYLAND_DISPLAY")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        Self {
            desktop: Desktop::from_env(read("XDG_CURRENT_DESKTOP").as_deref()),
            session: DisplaySession::from_env(read("XDG_SESSION_TYPE").as_deref(), wayland_socket),
        }
    }

    pub fn observe() -> Self {
        Self::from_env(|name| std::env::var(name).ok())
    }

    /// The environment in words, for a finding's detail: "KDE on Wayland", or an explicit
    /// admission that the desktop was not one this build knows.
    pub fn describe(&self) -> String {
        let desktop = match &self.desktop {
            Desktop::Gnome => "GNOME".to_string(),
            Desktop::Kde => "KDE".to_string(),
            Desktop::Other(name) => format!("an unrecognised desktop ({name})"),
            Desktop::Unknown => "an unrecognised desktop".to_string(),
        };
        let session = match self.session {
            DisplaySession::Wayland => "Wayland",
            DisplaySession::X11 => "X11",
            DisplaySession::Unknown => "an unrecognised display session",
        };
        format!("{desktop} on {session}")
    }
}

/// What the app was seen to do on this machine, as opposed to what it asked for.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Observed {
    /// It worked, here, on this desktop.
    Worked,
    /// It worked in part. The string says which part did not, because "degraded" alone is a
    /// status a user cannot act on.
    Degraded(String),
    /// It did not work. The string is the reason the compositor or the platform gave.
    Refused(String),
}

/// An observation against a name that is not a capability.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct UnknownCapability {
    pub name: &'static str,
}

/// Everything the running app has established, keyed by capability.
///
/// The only route to `available`. Empty in this build, and that is the truthful state: D13's
/// matrix is what fills it, and a build that claimed otherwise before then would be the "不伪装已
/// 支持" the plan forbids.
#[derive(Default, Clone, Debug)]
pub struct Observations(BTreeMap<&'static str, Observed>);

impl Observations {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record what happened.
    ///
    /// A name outside {@link CAPABILITIES} is rejected rather than stored: an observation filed
    /// against a capability that does not exist would sit there reading as evidence for nothing.
    pub fn record(
        &mut self,
        capability: &'static str,
        observed: Observed,
    ) -> Result<(), UnknownCapability> {
        if !is_capability(capability) {
            return Err(UnknownCapability { name: capability });
        }
        self.0.insert(capability, observed);
        Ok(())
    }

    pub fn get(&self, capability: &str) -> Option<&Observed> {
        self.0.get(capability)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// A capability's status and, unless it is available, what happens instead.
///
/// The same shape as D1's `PetCapabilityFinding` (`platform.ts:72-79`), including the reason the
/// three unavailable arms each *require* a fallback and a detail: a host cannot report a
/// capability as missing and leave the user to guess, and cannot report one as present while
/// quietly substituting something.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Finding {
    Available,
    Degraded {
        fallback: &'static str,
        detail: String,
    },
    Unavailable {
        fallback: &'static str,
        detail: String,
    },
    Unverified {
        fallback: &'static str,
        detail: String,
    },
}

/// One finding, named. Nested rather than merged into the report, so a caller narrows a plain
/// union — the same reason D1's `PetCapabilityReport` is shaped this way.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct CapabilityReport {
    pub capability: &'static str,
    pub finding: Finding,
}

/// What one §7.2 row needs, and what the app does without it.
///
/// `fallback` is the vocabulary token D1 froze and the front end renders from; `instead` is the
/// same thing in a sentence, because a settings page that only had `clamped-position` would be
/// showing a user an internal name.
struct Requirement {
    fallback: &'static str,
    needs: &'static str,
    instead: &'static str,
}

/// §7.2, row by row, in {@link CAPABILITIES}' order.
const REQUIREMENTS: [Requirement; 11] = [
    Requirement {
        fallback: "closable-window",
        needs: "a compositor that gives an undecorated window a transparent backing",
        instead: "the pet runs in a small window with a title bar, and the limit is stated",
    },
    Requirement {
        fallback: "closable-window",
        needs: "a compositor that honours a toplevel with no decorations",
        instead: "the window keeps its title bar and can still be moved and closed",
    },
    Requirement {
        fallback: "closable-window",
        needs: "a compositor that keeps a toplevel above ordinary windows",
        instead: "the pet sits in the normal stack and can be covered",
    },
    Requirement {
        fallback: "closable-window",
        needs: "a compositor that maps a window without focusing it",
        instead: "the pet takes focus when it appears, and gives it back when closed",
    },
    // Both of the pet's surfaces drag with it, and both ask the same way: the orb
    // (`PetFloatingBall.vue`) and the character (`DesktopPetRoot.vue`) each call
    // `PetBallPlatform.startDrag` once per gesture, over the one `core:window:allow-start-dragging`
    // grant `capabilities/desktop-pet.json` hands the `pet-*` windows. What the fallback column
    // describes is the other machine: a compositor that will not take the gesture leaves the window
    // where the host placed it, and the pet states that rather than looking movable — the orb in
    // its hint, the character in its own.
    Requirement {
        fallback: "clamped-position",
        needs: "the compositor's own move gesture for a client window",
        instead: "dragging asks the compositor to move the window, and one it will not move keeps the place the host put it in",
    },
    Requirement {
        fallback: "clamped-position",
        needs: "a compositor that lets a client place its own toplevel",
        instead: "the last position is reused, clamped back into a visible area, with a reset",
    },
    Requirement {
        fallback: "compact-window",
        needs: "input regions the client can shape",
        instead: "the pet window takes the clicks it covers",
    },
    Requirement {
        fallback: "stay-only",
        needs: "a global pointer a client may read",
        instead: "the pet stays where it is, and the mode is shown as unavailable",
    },
    Requirement {
        fallback: "not-offered",
        needs: "an implementation, which upstream has for Windows only",
        instead: "nothing: the mode is absent rather than imitated",
    },
    Requirement {
        fallback: "unread-list",
        needs: "a notification daemon or a portal to reach it through",
        instead: "the unread-task list, which is always there",
    },
    Requirement {
        fallback: "unread-list",
        needs: "a notification daemon that carries action buttons",
        instead: "no action buttons are shown; the task is opened from the list",
    },
];

fn requirement_for(capability: &str) -> &'static Requirement {
    let index = CAPABILITIES
        .iter()
        .position(|known| *known == capability)
        .unwrap_or(0);
    &REQUIREMENTS[index]
}

/// Every capability's finding, in {@link CAPABILITIES}' order.
pub fn report(environment: &LinuxEnvironment, observed: &Observations) -> Vec<CapabilityReport> {
    CAPABILITIES
        .iter()
        .map(|capability| CapabilityReport {
            capability,
            finding: finding_for(capability, environment, observed.get(capability)),
        })
        .collect()
}

fn finding_for(
    capability: &'static str,
    environment: &LinuxEnvironment,
    observed: Option<&Observed>,
) -> Finding {
    let requirement = requirement_for(capability);

    // Checked before the observation, not after: climb is absent from this build, so a `Worked`
    // recorded against it would be evidence about something other than the mode — and §7.2 makes
    // 「不伪装已支持」 the one thing this table may not do.
    if capability == WINDOW_CLIMB {
        return Finding::Unavailable {
            fallback: requirement.fallback,
            detail: format!(
                "no Linux window enumerator is implemented, and §7.2 forbids porting the Win32 one: {}",
                requirement.instead
            ),
        };
    }

    match observed {
        Some(Observed::Worked) => Finding::Available,
        Some(Observed::Degraded(part)) => Finding::Degraded {
            fallback: requirement.fallback,
            detail: format!("{part}; {}", requirement.instead),
        },
        Some(Observed::Refused(reason)) => Finding::Unavailable {
            fallback: requirement.fallback,
            detail: format!("{reason}; {}", requirement.instead),
        },
        None => Finding::Unverified {
            fallback: requirement.fallback,
            detail: format!(
                "not measured on {}: it needs {}, so until §12's matrix runs the app {}",
                environment.describe(),
                requirement.needs,
                requirement.instead
            ),
        },
    }
}
