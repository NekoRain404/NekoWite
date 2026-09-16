//! A channel that is not one, a stream that hands out sequence numbers, and the two contract
//! readers the pin tests share.
//!
//! `notification_delivery.rs` takes its channel through a port (§10.2), so the ledger's rules —
//! dedup, do-not-disturb, what a failed delivery leaves behind — are exercised with no desktop
//! session in sight. This is that port, backed by a list and a switch that makes it refuse.
//!
//! It is `Arc<Mutex<_>>` rather than `Rc<RefCell<_>>` because `NotificationDelivery` is `Send`: what
//! a test may substitute has to be at least what a real adapter is, or the substitution would be
//! testing a shape the product does not have.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::desktop_pet::history::TaskHistory;
use crate::desktop_pet::notification_delivery::{DeliveryFailure, NotificationDelivery, PetNotice};
use crate::desktop_pet::notification_policy::{
    NotificationOutcome, NotificationPolicy, NotificationPreferences, SilenceReason, TaskFact,
};
use crate::desktop_pet::task_projection::{PetTaskKey, PetTaskState, SessionKey};

pub const AGENT: &str = "opencode";
pub const PROFILE: &str = "default";
pub const EPOCH: &str = "epoch-1";
pub const VAULT: &str = "vault-1";
pub const SESSION: &str = "session-1";

// --- the tasks under test -----------------------------------------------------------------------

/// A task in the default session, differing only in its run.
pub fn key(run: &str) -> PetTaskKey {
    key_for(AGENT, SESSION, run)
}

/// A task in a named session — the helper every "these are not the same task" case reaches for.
pub fn key_for(agent: &str, session: &str, run: &str) -> PetTaskKey {
    PetTaskKey {
        agent_id: agent.to_string(),
        profile_id: PROFILE.to_string(),
        runtime_epoch: EPOCH.to_string(),
        vault_id: VAULT.to_string(),
        session_id: session.to_string(),
        run_id: run.to_string(),
    }
}

/// The session a key belongs to, for `set_viewing` and the gap assertions.
pub fn session_of(key: &PetTaskKey) -> SessionKey {
    key.session()
}

/// One session's stream, numbering what it hands out.
///
/// The sequence is the host's own (`agent_runtime/session.rs`), and §6.3 makes it the thing that
/// separates a replay from news. Tests that want a replay or a gap use [`Stream::numbered`], which
/// is the only way to write a sequence by hand.
#[derive(Default)]
pub struct Stream {
    counters: Mutex<BTreeMap<String, u64>>,
}

impl Stream {
    pub fn new() -> Self {
        Self::default()
    }

    /// The next frame for this session.
    pub fn at(&self, key: &PetTaskKey, state: PetTaskState, at_ms: i64) -> TaskFact {
        let sequence = self.next(key);
        TaskFact {
            key: key.clone(),
            state,
            permission_request_id: None,
            sequence,
            at_ms,
            label: None,
        }
    }

    /// A frame about a permission request, so the request id is in the key's own space.
    pub fn asking(&self, key: &PetTaskKey, request_id: &str, at_ms: i64) -> TaskFact {
        let sequence = self.next(key);
        TaskFact {
            key: key.clone(),
            state: PetTaskState::WaitingInput,
            permission_request_id: Some(request_id.to_string()),
            sequence,
            at_ms,
            label: None,
        }
    }

    /// A frame with a sequence of the caller's choosing: a replay, or a hole.
    ///
    /// The counter is moved forward if this is ahead of it, so the next [`Stream::at`] lands after
    /// this frame rather than below it.
    pub fn numbered(
        &self,
        key: &PetTaskKey,
        state: PetTaskState,
        sequence: u64,
        at_ms: i64,
    ) -> TaskFact {
        let mut counters = self.counters.lock().expect("lock");
        let entry = counters.entry(key.session().token()).or_insert(0);
        *entry = (*entry).max(sequence);
        TaskFact {
            key: key.clone(),
            state,
            permission_request_id: None,
            sequence,
            at_ms,
            label: None,
        }
    }
}

impl Stream {
    fn next(&self, key: &PetTaskKey) -> u64 {
        let mut counters = self.counters.lock().expect("lock");
        let entry = counters.entry(key.session().token()).or_insert(0);
        *entry += 1;
        *entry
    }
}

// --- the channel -------------------------------------------------------------------------------

#[derive(Default)]
pub struct ChannelState {
    pub delivered: Vec<PetNotice>,
    /// How many times the ledger asked, whether or not the ask succeeded. The at-most-once rule
    /// (§6.3) is about this number rather than about `delivered.len()`.
    pub attempts: usize,
    /// When set, every delivery fails with it — a channel that cannot is reachable without
    /// inventing one.
    pub refusal: Option<DeliveryFailure>,
}

#[derive(Clone, Default)]
pub struct RecordingChannel {
    state: Arc<Mutex<ChannelState>>,
}

impl RecordingChannel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, ChannelState> {
        self.state
            .lock()
            .expect("the fake's lock is never held across a panic")
    }

    pub fn notices(&self) -> Vec<PetNotice> {
        self.state().delivered.clone()
    }

    pub fn count(&self) -> usize {
        self.state().delivered.len()
    }

    pub fn attempts(&self) -> usize {
        self.state().attempts
    }

    pub fn refuse_with(&self, failure: DeliveryFailure) {
        self.state().refusal = Some(failure);
    }

    /// The channel answers again — a daemon that came back, or a permission the user granted.
    pub fn accept(&self) {
        self.state().refusal = None;
    }
}

impl NotificationDelivery for RecordingChannel {
    fn deliver(&mut self, notice: &PetNotice) -> Result<(), DeliveryFailure> {
        let mut state = self.state();
        state.attempts += 1;
        if let Some(failure) = &state.refusal {
            return Err(failure.clone());
        }
        state.delivered.push(notice.clone());
        Ok(())
    }
}

// --- policies -----------------------------------------------------------------------------------

pub fn policy(channel: &RecordingChannel) -> NotificationPolicy {
    NotificationPolicy::new(
        Box::new(channel.clone()),
        NotificationPreferences::default(),
        TaskHistory::new(),
    )
}

pub fn policy_with(
    channel: &RecordingChannel,
    preferences: NotificationPreferences,
) -> NotificationPolicy {
    NotificationPolicy::new(Box::new(channel.clone()), preferences, TaskHistory::new())
}

/// A policy that came back from a ledger it was handed — the restart of §6.3.
pub fn restored(
    channel: &RecordingChannel,
    preferences: NotificationPreferences,
    history: TaskHistory,
) -> NotificationPolicy {
    NotificationPolicy::new(Box::new(channel.clone()), preferences, history)
}

// --- reading an outcome ---------------------------------------------------------------------------

/// The reason nothing was said, or a panic naming what happened instead.
pub fn silent(outcome: &NotificationOutcome) -> SilenceReason {
    match outcome {
        NotificationOutcome::Silent(reason) => *reason,
        other => panic!("expected silence, got {other:?}"),
    }
}

/// The notice that went out, or a panic naming what happened instead.
pub fn delivered(outcome: &NotificationOutcome) -> PetNotice {
    match outcome {
        NotificationOutcome::Delivered(notice) => notice.clone(),
        other => panic!("expected a delivery, got {other:?}"),
    }
}

/// The notice that could not go out, and why.
pub fn refused(outcome: &NotificationOutcome) -> (&PetNotice, &DeliveryFailure) {
    match outcome {
        NotificationOutcome::DeliveryFailed { notice, failure } => (notice, failure),
        other => panic!("expected a delivery failure, got {other:?}"),
    }
}

/// How many completions are gathered, and when the burst closes.
pub fn gathering(outcome: &NotificationOutcome) -> (usize, i64) {
    match outcome {
        NotificationOutcome::Coalescing { count, due_at_ms } => (*count, *due_at_ms),
        other => panic!("expected a coalescing burst, got {other:?}"),
    }
}

/// Deliver a burst that has closed, which every completion test has to do: §6.3 merges completions
/// rather than sending each one, so the notice is what the flush produces.
pub fn flush(policy: &mut NotificationPolicy, now_ms: i64) -> PetNotice {
    delivered(&policy.flush_due(now_ms).expect("a burst was due"))
}

// --- reading the frozen contracts -----------------------------------------------------------------

/// A path inside the frozen D1 contract, from this crate's manifest directory.
pub fn contract(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/platform/gateways")
        .join(relative);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
}

/// The text between two markers, or a panic naming the marker that moved.
pub fn slice_between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text
        .find(start)
        .unwrap_or_else(|| panic!("{start} is not in the contract"));
    let rest = &text[from + start.len()..];
    let to = rest
        .find(end)
        .unwrap_or_else(|| panic!("{end} does not follow {start} in the contract"));
    &rest[..to]
}

/// The same, for the `skip`-th occurrence of `start`: the settings file states a domain's fields
/// once in the values type and once in the defaults.
pub fn slice_after<'a>(text: &'a str, start: &str, skip: usize, end: &str) -> &'a str {
    let mut rest = text;
    for _ in 0..=skip {
        let from = rest
            .find(start)
            .unwrap_or_else(|| panic!("{start} has no occurrence {skip} in the contract"));
        rest = &rest[from + start.len()..];
    }
    let to = rest
        .find(end)
        .unwrap_or_else(|| panic!("{end} does not follow {start} in the contract"));
    &rest[..to]
}

/// Every single-quoted string in a slice, in order.
pub fn quoted(slice: &str) -> Vec<String> {
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

/// Every `name: 'value',` line in a slice — a table literal's keys and their string values.
///
/// A key may be quoted or not: the contract writes `'max-turn-requests': 'stopped'` beside
/// `refusal: 'refused'`, because only the names that are not valid identifiers need the quotes.
pub fn quoted_pairs(slice: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for line in slice.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with('*')
            || line.starts_with('/')
            || line.starts_with('}')
        {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().trim_matches('\'');
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            continue;
        }
        let values = quoted(value);
        if let Some(value) = values.first() {
            pairs.push((name.to_string(), value.clone()));
        }
    }
    pairs
}

/// Every `name: true|false,` line in a slice — a defaults block's keys and their values.
pub fn boolean_pairs(slice: &str) -> Vec<(String, bool)> {
    let mut pairs = Vec::new();
    for line in slice.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('*') || line.starts_with('/') {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim().trim_end_matches(',');
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        match value {
            "true" => pairs.push((name.to_string(), true)),
            "false" => pairs.push((name.to_string(), false)),
            _ => {}
        }
    }
    pairs
}

/// The state a contract name denotes, read through the same serde path the ledger writes it with —
/// so a name in `task.ts` that no state here answers to fails loudly rather than being skipped.
pub fn state_named(name: &str) -> PetTaskState {
    serde_json::from_str::<PetTaskState>(&format!("\"{name}\""))
        .unwrap_or_else(|error| panic!("{name} is not a state this build knows: {error}"))
}

/// Every `name:` identifier in a slice — a type block's field names, comments skipped.
pub fn identifiers(slice: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in slice.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('*') || line.starts_with('/') {
            continue;
        }
        let Some((name, _)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            names.push(name.to_string());
        }
    }
    names
}
