//! The channel a notice goes out on, and what it says when it cannot go out at all.
//!
//! §9 asks for 「原生投递，注入接口」 — native delivery behind an injected interface — and the
//! injection is what makes the two rules that matter here testable rather than aspirational:
//!
//! - **A delivery that failed is not a delivery.** Upstream calls `sendNotification` inside
//!   `try { … } catch {}` (`references/desktop-pet/windows/src/main.ts:441`), so a permission the
//!   user revoked after startup, or a desktop with no daemon behind it, loses the notice with
//!   nothing anywhere saying so. Here the port returns a typed failure, the ledger keeps the row
//!   unread and records `failed`, and the caller is told (§6.3, §7.2's 「未读任务入口始终可用」).
//! - **A notice with no target offers no action.** §7.2 forbids showing a button that does nothing,
//!   so {@link PetNotice::target} is an `Option`: it is `None` when the notice stands for several
//!   endings at once and there is no single task it is about, and the surface then has nothing to
//!   route with rather than a key it would have to guess at.
//!
//! What a notice carries is deliberately nothing but identifiers: §6.3 requires the default title to
//! name neither a note nor a path, and the action to be a host-issued target rather than a URL, a
//! command or a file path. There is no field here for any of those three.
//!
//! **The channel the app runs with is {@link SystemNotifications}**, and it is a plain D-Bus call
//! to the session's notification daemon — `org.freedesktop.Notifications`'s own `Notify`, the
//! method every Linux toast is made of. It is constructed where the pet's state is
//! (`PetTaskFeed::new` and `PetTaskFeed::for_app`), reaches no window, and needs no capability: the
//! delivery never crosses the IPC boundary, so the pet — the least trusted window in this app —
//! gains nothing from it.
//!
//! **Why not Tauri's notification plugin**, which the port ledger named
//! (`docs/architecture/desktop-pet-port-ledger.md` §3) as 「唯一可能需要的」. Two reasons, both
//! checkable:
//!
//! - **It cannot fail.** `tauri-plugin-notification` 2.3.3 and 2.4.0 both end their desktop
//!   `show()` in `tauri::async_runtime::spawn(async move { let _ = notification.show(); })`
//!   (`src/desktop.rs:216-218` at 2.4.0) — the daemon's answer is dropped on a task nobody reads,
//!   and the call returns `Ok(())` whatever happened. A port built on it could never produce
//!   [`DeliveryFailure::Channel`], and a machine whose daemon died would be recorded as
//!   `Delivered`, which is the one outcome this file's first rule forbids.
//! - **It cannot be built where the channel is built.** Its Rust API needs an `AppHandle`, and
//!   `PetTaskFeed::new` has none — the feed is assembled before the app's state is.
//!
//! So the delivery is made on `zbus`, which is already a direct dependency of this crate for the
//! single-instance guard (`instance_guard.rs`) and is what the plugin itself uses underneath: no
//! crate is added for this feature, and the identical call returns the daemon's answer as a
//! `Result`. The same choice is what makes the port's failure arms *reachable* — a session with no
//! daemon, a name nobody owns, a bus that cannot be opened and a daemon that answers with an error
//! are four different answers, and
//! `tests/desktop_pet_notification_channel_test.rs` measures them against buses it starts itself.

// Linux-only, like everything below that names the bus: the channel that uses them is compiled
// only there, and an import that survived the `cfg` would be a warning on every other target.
#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::time::Duration;

use serde::Serialize;

use super::task_projection::{PetTaskKey, PetTaskState};

/// The name the desktop shows as the notification's sender, and the title every un-named notice
/// falls back to.
///
/// One constant because the two are one decision — a toast whose body says 「The turn finished.」 and
/// whose header says `nekowite` while its title says `NekoWite` is three spellings of one product,
/// and only one of them was chosen.
pub const APP_NAME: &str = "NekoWite";

/// Everything one system notification says and routes with.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetNotice {
    pub state: PetTaskState,
    /// How many endings this one notice stands for. Never zero (§6.3 merges a burst of completions
    /// into one notice with one sound rather than into several).
    pub count: usize,
    /// The task this notice is about, or `None` when it stands for several.
    pub target: Option<PetTaskKey>,
    /// The permission request a click should open, when the state is `waiting-input`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_request_id: Option<String>,
    /// The task's own label, present only when the user asked for task names to appear (§6.3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Whether this notice should be heard as well as seen. One per notice, never one per member of
    /// a merged batch.
    pub sound: bool,
}

impl PetNotice {
    /// The notification's title: the task's label when the user asked for it, else the app's name.
    ///
    /// §6.3 makes the un-named version the default rather than a preference: 「通知标题默认不含笔记
    /// 内容/路径」, so a user who never opens the settings page never gets their file names on a
    /// desktop where anyone passing by can read them.
    pub fn title(&self) -> String {
        self.label.clone().unwrap_or_else(|| APP_NAME.to_string())
    }

    /// What the notice says, per §6.2's table.
    ///
    /// Each arm states the ending that happened and claims nothing past it. The four that are not
    /// successes say so in their own words — a ceiling is *reached*, a refusal is the engine
    /// *declining*, a lost runtime leaves the outcome *unknown* — because a notice that called any
    /// of them an error, or let a completion stand for more than one turn, would be telling the user
    /// something untrue about their own run.
    pub fn body(&self) -> String {
        match self.state {
            PetTaskState::Working => "An agent is working.".to_string(),
            PetTaskState::WaitingInput => {
                "An agent is waiting for you to allow or refuse something.".to_string()
            }
            PetTaskState::TurnFinished if self.count == 1 => "The turn finished.".to_string(),
            PetTaskState::TurnFinished => format!("{} turns finished.", self.count),
            PetTaskState::Stopped => {
                "The run stopped at a limit. Open the task to see how far it got.".to_string()
            }
            PetTaskState::Refused => {
                "The agent declined to continue this run. Open the task for the details."
                    .to_string()
            }
            PetTaskState::Cancelled => "The run was cancelled.".to_string(),
            PetTaskState::Failed => "The run failed. Open the task for the details.".to_string(),
            PetTaskState::Interrupted => {
                "Contact with the runtime was lost while this run was still going. What it managed \
                 is unknown."
                    .to_string()
            }
            // Two situations reach this state and they are not the same one: a host that cannot
            // reach the runtime knows nothing at all, and a run that ended for a reason this
            // version does not know has *ended* — only its ending is unreadable. The sentence
            // used to name the first alone, which was untrue of the second and therefore of every
            // notice this ledger can actually produce (the projection reaches `Unknown` from an
            // unrecognised stop reason, not from a lost connection, which is `Interrupted`). A
            // state two causes reach cannot pick one of them, so it names both and claims neither.
            PetTaskState::Unknown => {
                "This task's state is unknown. The host cannot reach the runtime, or the run \
                 ended for a reason this version does not recognise."
                    .to_string()
            }
        }
    }
}

/// Why a notice could not be shown.
///
/// Three arms because they call for three different things: a machine with no channel is D3's
/// `system-notification` finding and its `unread-list` fallback, a refusal is the user's permission
/// to fix in their own desktop settings, and a channel error is the daemon's problem, which may be
/// transient. `detail` is for the report and the diagnostics page — it is never what the user is
/// asked to act on.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum DeliveryFailure {
    /// Nothing on this build can show a system notification.
    NoChannel { detail: String },
    /// The desktop declined: permission refused, or do-not-disturb at the session level.
    Refused { detail: String },
    /// A channel exists and could not carry this notice.
    Channel { detail: String },
}

impl DeliveryFailure {
    /// The reason in words a caller can branch on without matching the detail string.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::NoChannel { .. } => "no-channel",
            Self::Refused { .. } => "refused",
            Self::Channel { .. } => "channel",
        }
    }

    /// What actually happened, for the report — never for the user's next step.
    ///
    /// Kept next to [`Self::kind`] so a caller that reports a failed notice (the host's log line,
    /// and the diagnostics surface a later task may add) has one accessor per field rather than a
    /// match that would have to be repeated, and extended, wherever a failure is written down.
    pub fn detail(&self) -> &str {
        match self {
            Self::NoChannel { detail } | Self::Refused { detail } | Self::Channel { detail } => {
                detail
            }
        }
    }
}

/// The notification channel, as the app sees it.
///
/// A port rather than a set of calls, so the ledger's rules — dedup, do-not-disturb, the record kept
/// when delivery fails — can be exercised against something that is not a desktop session (§10.2's
/// injected dependencies). It takes `&mut self` because a real channel holds state: a permission
/// answer, a connection to the daemon.
pub trait NotificationDelivery: Send {
    fn deliver(&mut self, notice: &PetNotice) -> Result<(), DeliveryFailure>;
}

/// The channel that is not one: every delivery fails, visibly.
///
/// **No production path constructs this any more.** The app runs [`SystemNotifications`], and the
/// `NoChannel` *finding* — the arm of [`DeliveryFailure`] a user on a bare session is owed — is
/// produced by that channel's own classification, so §7.2's `unread-list` fallback still works the
/// way it always did: the row stays unread, the ledger records `failed`, and the settings page can
/// say why no toast appeared. A silent success is the one thing worse than no notification — a user
/// who believes they will be told.
///
/// What it is kept for is the port's own contract: "a channel that cannot deliver says so" is a
/// rule about the *trait*, and the ledger's cases pin it against a channel that can do nothing else
/// (`tests/desktop_pet_notification_test/delivery.rs`). A machine with no daemon is the same
/// behaviour reached the other way round, and that one is measured against a real bus
/// (`tests/desktop_pet_notification_channel_test.rs`).
#[derive(Clone, Debug, Default)]
pub struct NoChannel {
    /// What is missing, in words the user can act on.
    pub detail: String,
}

impl NoChannel {
    pub fn new() -> Self {
        Self {
            detail: "this build has no system-notification channel; the pet's unread list is the \
                     surface that remains"
                .to_string(),
        }
    }
}

impl NotificationDelivery for NoChannel {
    fn deliver(&mut self, _notice: &PetNotice) -> Result<(), DeliveryFailure> {
        Err(DeliveryFailure::NoChannel {
            detail: self.detail.clone(),
        })
    }
}

/// The well-known name, object path and interface of the desktop notification specification.
///
/// Named rather than spelled at the call, because `tests/desktop_pet_notification_channel_test.rs`
/// spells them independently and would otherwise move with a drift it exists to catch: a channel
/// that called the right *idea* at the wrong path is a toast nobody ever sees, and it is the one
/// failure a green test that shared the constant would not catch.
#[cfg(target_os = "linux")]
pub const NOTIFICATION_SERVICE: &str = "org.freedesktop.Notifications";
#[cfg(target_os = "linux")]
pub const NOTIFICATION_OBJECT: &str = "/org/freedesktop/Notifications";
#[cfg(target_os = "linux")]
pub const NOTIFICATION_INTERFACE: &str = "org.freedesktop.Notifications";

/// How long one delivery may take before it is called a failure.
///
/// A parameter and not a guess about patience: the ledger holds its own lock across
/// [`NotificationDelivery::deliver`], so this is the longest a window's read of the pet's ledger
/// can be made to wait by a daemon that has stopped answering. A local D-Bus round trip is
/// well under a millisecond when it works at all, and a daemon that has not answered in two seconds
/// is not going to — while zbus's own default is *no* timeout, which would hang the pet's task for
/// as long as the daemon stayed wedged.
#[cfg(target_os = "linux")]
pub const DELIVERY_BUDGET: Duration = Duration::from_secs(2);

/// The channel this build runs with.
///
/// One function rather than a constructor call at each site, because which implementation a target
/// gets is a fact about the *target* and not about the caller: D-Bus is Linux's, `zbus` is a
/// Linux-only dependency of this crate for exactly that reason (`instance_guard.rs`, the other
/// thing here that talks to a bus), and everywhere else the honest answer is still
/// [`NoChannel`] — the same finding a Linux session with no daemon reaches by classification, said
/// before the fact instead of after it.
pub fn system_channel() -> Box<dyn NotificationDelivery> {
    #[cfg(target_os = "linux")]
    {
        Box::new(SystemNotifications::new())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Box::new(NoChannel::new())
    }
}

/// Where the channel's connection is made.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, Eq)]
enum Bus {
    /// The session bus the environment names, falling back to `$XDG_RUNTIME_DIR/bus` — what the app
    /// runs on.
    Session,
    /// One bus, named by address. For a test that started its own; never for the app.
    At(String),
}

/// The session's notification daemon, over D-Bus: the channel the app runs with.
///
/// A connection is opened per delivery rather than held. That is not laziness: a held connection
/// answers about the bus as it was when the app started, so a session whose daemon was restarted —
/// or a bus that was not up yet — would be remembered wrongly for the life of the process, and
/// §7.2's fallback is only honest if "there is no channel *now*" is answered now.
#[cfg(target_os = "linux")]
pub struct SystemNotifications {
    bus: Bus,
    /// How long one delivery may take. See [`DELIVERY_BUDGET`].
    budget: Duration,
}

#[cfg(target_os = "linux")]
impl Default for SystemNotifications {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "linux")]
impl SystemNotifications {
    /// The channel that reaches this session's notification daemon.
    pub fn new() -> Self {
        Self {
            bus: Bus::Session,
            budget: DELIVERY_BUDGET,
        }
    }

    /// The same channel, pointed at one bus by address.
    ///
    /// For a test that starts its own bus — so nothing here raises a toast on the desktop of
    /// whoever is running the suite — and for nothing else: the app's bus is the session's own, and
    /// an address chosen by a caller is not a thing this app has any use for.
    pub fn at(address: impl Into<String>) -> Self {
        Self {
            bus: Bus::At(address.into()),
            budget: DELIVERY_BUDGET,
        }
    }

    /// A connection to the bus this channel was built for, or why there is none.
    ///
    /// Every failure here is `no-channel` and none of them is classified further: an address this
    /// build cannot parse, a socket that is not there, a handshake that is refused — none of them
    /// is a channel that exists and misbehaved, and the user's fallback is the same for all three.
    fn connect(&self) -> Result<zbus::blocking::Connection, DeliveryFailure> {
        let builder = match &self.bus {
            Bus::Session => zbus::blocking::connection::Builder::session(),
            Bus::At(address) => zbus::blocking::connection::Builder::address(address.as_str()),
        }
        .map_err(|error| DeliveryFailure::NoChannel {
            detail: error.to_string(),
        })?;
        builder
            .method_timeout(self.budget)
            .build()
            .map_err(|error| DeliveryFailure::NoChannel {
                detail: error.to_string(),
            })
    }
}

#[cfg(target_os = "linux")]
impl NotificationDelivery for SystemNotifications {
    /// Ask the daemon to show this notice, and answer what it said.
    ///
    /// `Ok` means the daemon accepted the method and replied without an error — which is the whole
    /// of what any client can know from this side of the bus, and the honest meaning of
    /// `DeliveryState::Delivered`. Everything the notice carries is what §6.3 allows it to carry:
    /// the app's name, a title that names no note, a sentence about the ending, and the one hint
    /// the user's own sound switch governs. There is no action, no URL, no path and no note name —
    /// there is nothing here to send one from.
    fn deliver(&mut self, notice: &PetNotice) -> Result<(), DeliveryFailure> {
        let connection = self.connect()?;
        let summary = notice.title();
        let body = notice.body();
        // The specification's own hint, so a user who turned the sound off is not told twice: the
        // daemon decides whether it honours it, and this side claims nothing past asking.
        let hints: HashMap<&str, zbus::zvariant::Value<'_>> = match notice.sound {
            true => HashMap::new(),
            false => HashMap::from([("suppress-sound", zbus::zvariant::Value::from(true))]),
        };
        // A permission request is a question the user has to answer (§6.2), and a toast that slides
        // off the screen while they are looking at another window is exactly the invisibility this
        // channel exists to end. The specification's `0` is "never expire"; every other ending
        // takes the daemon's own timeout (`-1`), because a completion is news and not a demand.
        let expire_timeout: i32 = match notice.state {
            PetTaskState::WaitingInput => 0,
            _ => -1,
        };
        connection
            .call_method(
                Some(NOTIFICATION_SERVICE),
                NOTIFICATION_OBJECT,
                Some(NOTIFICATION_INTERFACE),
                "Notify",
                &(
                    APP_NAME,
                    // `replaces_id`: never. The ledger is the thing that decides whether two
                    // endings are one notice (§6.3's dedup and coalescing), and a channel that
                    // replaced by id would be a second opinion about it.
                    0u32,
                    // The daemon picks the icon from the app's own desktop entry; naming one here
                    // would be a path this module has no business carrying.
                    "",
                    summary.as_str(),
                    body.as_str(),
                    // No actions: §7.2 forbids a button that does nothing, and a button *here*
                    // would have to be answered by a listener this build does not have.
                    Vec::<&str>::new(),
                    hints,
                    expire_timeout,
                ),
            )
            .map_err(|error| classify_call(&error))?;
        Ok(())
    }
}

/// What the bus said when a notice could not be carried.
///
/// The distinction is the module's, not zbus's: the same `Err` covers "nothing on this session is
/// called that", "the desktop declined" and "the daemon is there and could not carry it", and they
/// call for three different things — D3's fallback, the user's own notification settings, and a
/// retry that may work later. The connection itself is *not* classified here: it has its own
/// function, because a bus that could not be opened and a daemon that stopped answering arrive as
/// the same `zbus::Error::InputOutput` and mean opposite things to the person reading the row.
///
/// The `detail` is the error's own sentence, kept whole. It is what makes a line in the log
/// diagnosable, and it is never what the user is asked to act on.
#[cfg(target_os = "linux")]
fn classify_call(error: &zbus::Error) -> DeliveryFailure {
    let detail = error.to_string();
    // A name nobody owns, in either of the two shapes it arrives in — the bus's own error to the
    // method call, and the one zbus raises when it resolves the destination itself. Both mean one
    // thing to a user: nothing on this session can show a notification. This is the arm the bare
    // session measures, and it is also the one D-Bus *service activation* usually spares a user —
    // a stock session bus starts a daemon on demand rather than reporting that it has none.
    let unowned = matches!(
        error,
        zbus::Error::MethodError(name, ..) if is_unowned(name.as_str())
    ) || matches!(error, zbus::Error::FDO(inner) if matches!(
        &**inner,
        zbus::fdo::Error::ServiceUnknown(_) | zbus::fdo::Error::NameHasNoOwner(_)
    ));
    if unowned {
        return DeliveryFailure::NoChannel { detail };
    }
    match error {
        // The bus or the daemon refused the call. The user's own settings or session policy are
        // where that is fixed, so it is the one arm that is not about this machine's wiring.
        zbus::Error::MethodError(name, ..) if name.as_str() == DENIED => {
            DeliveryFailure::Refused { detail }
        }
        zbus::Error::FDO(inner) if matches!(&**inner, zbus::fdo::Error::AccessDenied(_)) => {
            DeliveryFailure::Refused { detail }
        }
        // Everything else — a daemon that owns the name and never answers (measured: it is a
        // timeout), a malformed reply, an error the specification does not name — is a channel that
        // exists and could not carry this notice. That is the arm that may be transient, and the
        // one the ledger does not retry.
        _ => DeliveryFailure::Channel { detail },
    }
}

/// The error name the bus uses for a call the sender is not allowed to make.
#[cfg(target_os = "linux")]
const DENIED: &str = "org.freedesktop.DBus.Error.AccessDenied";

/// Whether a D-Bus error name is the bus saying "nothing here is called that".
#[cfg(target_os = "linux")]
fn is_unowned(name: &str) -> bool {
    matches!(
        name,
        "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner"
    )
}
