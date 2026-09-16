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
//! **No channel is implemented in this module.** The only way to reach a Linux notification daemon
//! from this crate is Tauri's notification plugin, and the ledger (§3) holds it back until it has
//! been measured on AppImage/deb/rpm and on a session with no portal — adding it is the integrator's
//! dep change, not this task's. {@link NoChannel} is what the app runs with until then: it fails
//! visibly, which is the one behaviour §7.2's `unread-list` fallback needs from the channel.

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
        self.label
            .clone()
            .unwrap_or_else(|| "NekoWite".to_string())
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
                "The agent declined to continue this run. Open the task for the details.".to_string()
            }
            PetTaskState::Cancelled => "The run was cancelled.".to_string(),
            PetTaskState::Failed => "The run failed. Open the task for the details.".to_string(),
            PetTaskState::Interrupted => {
                "Contact with the runtime was lost while this run was still going. What it managed \
                 is unknown."
                    .to_string()
            }
            PetTaskState::Unknown => {
                "The host cannot reach the runtime, so this task's state is unknown.".to_string()
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
/// This is what the app runs with today, and the failure is the point. §7.2's row for system
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
