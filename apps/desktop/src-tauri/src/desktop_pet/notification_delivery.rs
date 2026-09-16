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
//! **No channel is implemented in this module, and {@link NoChannel} is the one the app runs
//! with.** It is not a stand-in for something that exists: it is the port's only implementation in
//! this build, constructed where the pet's state is (`PetTaskFeed::new`), and every notice the
//! ledger decides on therefore fails — visibly, with the row kept unread and marked `failed`, which
//! is the one behaviour §7.2's `unread-list` fallback needs from the channel.
//!
//! What is missing is the *dependency*, not the wiring: the only way to reach a Linux notification
//! daemon from this crate is Tauri's notification plugin, and the ledger (§3) holds it back until
//! it has been measured on AppImage/deb/rpm and on a session with no portal. Adding it is the
//! integrator's dep change — one `tauri-plugin-notification` entry here, one capability line, one
//! `NotificationDelivery` implementation — and until then a reader who wants to know whether the
//! app can raise a toast should read this doc comment, not a report: the answer is no, and the
//! code says so by running the failing channel.

use serde::Serialize;

use super::task_projection::{PetTaskKey, PetTaskState};

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
        self.label.clone().unwrap_or_else(|| "NekoWite".to_string())
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
/// This is what the app runs with — `PetTaskFeed::new` is the construction site, one line, so the
/// claim is checkable rather than asserted — and the failure is the point. §7.2's row for system
/// notifications lists the fallback as 「未读任务入口始终可用」, and that fallback only works if the
/// missing channel is *stated*: the row stays unread, the ledger records `failed`, and the settings
/// page can say why no toast appeared. A silent success here would be the one thing worse than no
/// notification — a user who believes they will be told.
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
