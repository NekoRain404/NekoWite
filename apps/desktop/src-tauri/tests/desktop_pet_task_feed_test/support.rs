//! The fixtures the behaviour files share: one identity and the frame built from it, the channel
//! double the ledger cases drive, and the four ways a feed is built and moved.
//!
//! What is here is what more than one domain needs; a fixture only one domain uses stays with it —
//! `data_dir`, `feed_on` and the ledger's own readers are in `ledger_store.rs` for that reason. The
//! channel is the one thing these cases substitute, because `PetTaskFeed::new` carries the app's own
//! channel and a case that ended a run through it would raise a real notification on whoever is
//! running the suite.

use std::sync::{Arc, Mutex};

use serde_json::json;

use nekowite_lib::agent_runtime::events::{AgentEventEnvelope, AgentEventKind, AgentIdentity};
use nekowite_lib::desktop_pet::notification_delivery::DeliveryFailure;
use nekowite_lib::desktop_pet::{
    NoChannel, NotificationDelivery, NotificationPolicy, NotificationPreferences, PetNotice,
    PetTaskFeed, TaskHistory,
};

pub const AGENT: &str = "opencode";
pub const PROFILE: &str = "default";
pub const VAULT: &str = "vault-a";
pub const SESSION: &str = "ses-1";

pub fn identity(epoch: &str) -> AgentIdentity {
    AgentIdentity {
        agent_id: AGENT.to_string(),
        profile_id: PROFILE.to_string(),
        runtime_epoch: epoch.to_string(),
        vault_id: VAULT.to_string(),
    }
}

pub fn envelope(
    identity: &AgentIdentity,
    run_id: Option<&str>,
    sequence: u64,
    kind: AgentEventKind,
    payload: serde_json::Value,
) -> AgentEventEnvelope {
    AgentEventEnvelope {
        agent_id: identity.agent_id.clone(),
        profile_id: identity.profile_id.clone(),
        runtime_epoch: identity.runtime_epoch.clone(),
        vault_id: identity.vault_id.clone(),
        session_id: SESSION.to_string(),
        run_id: run_id.map(str::to_string),
        sequence,
        kind,
        payload,
    }
}

/// A feed with one instance installed and one run in flight, as a prompt leaves it.
///
/// Built with a channel that cannot reach a desktop, and that is not a shortcut: `PetTaskFeed::new`
/// now carries the app's own channel (`notification_delivery.rs`), so a case here that ended a run
/// through it would raise a real notification on whoever is running the suite. That is not a
/// hypothesis — `dbus-monitor` on the live session bus recorded six `Notify` calls to the session's
/// own daemon from these tests, with these bodies, before this line existed. What these cases are
/// about is the list a window reads, so the channel is the one thing they substitute — exactly as
/// the ledger cases below substitute it for `Recording`.
pub fn running() -> PetTaskFeed {
    let feed = PetTaskFeed::with_notifications(NotificationPolicy::new(
        Box::new(NoChannel::new()),
        NotificationPreferences::default(),
        TaskHistory::new(),
    ));
    feed.install(&identity("epoch-1"))
        .expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-0")
        .expect("the lock is fresh");
    feed
}

/// A channel that keeps what it was asked to show, and can be told to refuse.
#[derive(Clone, Default)]
pub struct Recording {
    state: Arc<Mutex<ChannelState>>,
}

#[derive(Default)]
struct ChannelState {
    notices: Vec<PetNotice>,
    /// Set when every delivery must fail, so the "nothing can show it" machine is reachable without
    /// inventing a different port.
    refusal: Option<DeliveryFailure>,
}

impl Recording {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn refusing() -> Self {
        let channel = Self::new();
        channel.accepted_state().refusal = Some(DeliveryFailure::NoChannel {
            detail: "this machine has no notification daemon".to_string(),
        });
        channel
    }

    fn accepted_state(&self) -> std::sync::MutexGuard<'_, ChannelState> {
        self.state
            .lock()
            .expect("the fake's lock is never held across a panic")
    }

    pub fn notices(&self) -> Vec<PetNotice> {
        self.accepted_state().notices.clone()
    }
}

impl NotificationDelivery for Recording {
    fn deliver(&mut self, notice: &PetNotice) -> Result<(), DeliveryFailure> {
        let mut state = self.accepted_state();
        if let Some(failure) = &state.refusal {
            return Err(failure.clone());
        }
        state.notices.push(notice.clone());
        Ok(())
    }
}

/// A feed whose ledger was given this channel and these switches.
pub fn feed_with(channel: &Recording, preferences: NotificationPreferences) -> PetTaskFeed {
    PetTaskFeed::with_notifications(NotificationPolicy::new(
        Box::new(channel.clone()),
        preferences,
        TaskHistory::new(),
    ))
}

/// A feed with one run in flight, as a prompt leaves it.
pub fn feed_running(channel: &Recording) -> PetTaskFeed {
    let feed = feed_with(channel, NotificationPreferences::default());
    feed.install(&identity("epoch-1"))
        .expect("the lock is fresh");
    feed.started(&identity("epoch-1"), SESSION, "run-0")
        .expect("the lock is fresh");
    feed
}

/// One run ending, as the driver publishes it.
pub fn ending(feed: &PetTaskFeed, run: &str, sequence: u64) {
    feed.apply(&envelope(
        &identity("epoch-1"),
        Some(run),
        sequence,
        AgentEventKind::RunFinished,
        json!({ "stopReason": "end-turn" }),
    ))
    .expect("the lock is fresh");
}

/// The due time of the burst that is gathering, or a panic naming what is wrong.
pub fn due(feed: &PetTaskFeed) -> i64 {
    feed.notifications()
        .expect("the ledger's lock is fresh")
        .pending_due()
        .expect("a completion is gathering")
}
