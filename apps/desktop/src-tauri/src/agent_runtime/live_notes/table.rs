//! The questions this host has asked and the windows that may answer them: what is kept per question
//! while it is open, when it resolves, what an answer that does not belong to it is refused as, and
//! what abandoning a question leaves behind.
//!
//! **Why it is a file of its own.** It was the middle of `live_notes.rs`, which passed the 600-line
//! budget `docs/dev.md:286` puts on a business source file, and the criterion that section states is
//! the number of reasons a file changes rather than its length. This module moves when the table's
//! rules move — [`LIVE_NOTE_BOUND`], what a late or duplicate answer is refused as, how many retired
//! ids are remembered, or what dropping an abandoned call leaves behind — while `super::vocabulary`
//! moves when the wire does and `super::port` moves when the shape the host is reached through does.
//! A bound on this process's own memory is not the same change as a field the window sends.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::oneshot;

use super::port::LiveNoteWindows;
use super::vocabulary::{
    LiveNote, LiveNoteAnswer, LiveNoteAnswerPayload, LiveNoteQuestion, LiveNoteRefusal,
    LiveNoteReply,
};

/// How long a window that has registered for this vault may take to answer.
///
/// Three orders of magnitude above the honest cost of the lookup (a `Map` read behind one
/// in-process IPC hop), and at the top of the band a desktop user reads as "slow" rather than
/// "hung". **The value is not measured**, and the code says so: a spurious expiry costs the
/// agent an error for a note that was perfectly readable, while the state it prevents is
/// silent and permanent. If a legitimate main-thread stall above ten seconds is ever measured
/// on this machine, this number is wrong and should be raised — which is why the expiry is
/// named in the error rather than being invisible.
///
/// Deliberately not `session::CONTROL_BOUND`: that one's reason is "session control calls are
/// answered out of the engine's own state, so they are quick by construction", and borrowing
/// the number would import a justification about the *engine* for a bound on a window.
pub const LIVE_NOTE_BOUND: Duration = Duration::from_secs(10);

/// How many retired request ids are remembered, so a late answer is refused as *late* rather
/// than as unknown. The same trade `permissions::ANSWERED_MEMORY` makes: it only sharpens a
/// refusal, so a bound is safe — an id that falls out of the ring is still refused, with the
/// less precise reason, and nothing is served either way.
const RETIRED_MEMORY: usize = 32;

/// One question in flight.
///
/// `pub(super)` rather than private because the helper that parks a question by hand builds one and
/// reaches the table's `pending` map directly: `live_notes` owns that helper, so the entry type and
/// its fields are visible to it and to nothing else.
pub(super) struct Pending {
    pub(super) question: LiveNoteQuestion,
    /// How many windows were asked. Set once [`LiveNoteWindows::ask`] has answered — a window
    /// can reply before that line runs, so `0` means "not known yet", never "nobody".
    pub(super) expected: usize,
    /// `(windowId, reply)`, one per window. Two entries from one window is the duplicate this
    /// refuses rather than a disagreement.
    pub(super) answers: Vec<(String, LiveNoteReply)>,
    /// The waiting half. Taken when the question resolves.
    pub(super) sender: Option<oneshot::Sender<LiveNoteAnswer>>,
}

/// The questions this host has asked, and the answers windows gave.
///
/// Modelled on `PermissionTable`, and for the same reason: an id minted here, a handle parked
/// against it, and a refusal vocabulary for everything that arrives against a question that is
/// over. Nothing is cached — a `Held` answer is invalidated by the next keystroke and a
/// `NotHeld` answer by the user opening the tab, and neither invalidation is observable from
/// here. "Add a small cache" is the obvious next optimisation and it reintroduces exactly the
/// staleness this closes.
#[derive(Default)]
pub struct LiveNoteTable {
    next_id: AtomicU64,
    // Visible to `live_notes` for the same reason `Pending` is: the helper in `super::tests` parks a
    // question by hand through this map.
    pub(super) pending: Mutex<HashMap<String, Pending>>,
    /// Ids whose question is over, so a late or duplicate answer is refused *as* late.
    retired: Mutex<VecDeque<String>>,
}

impl LiveNoteTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Asks the windows what `path` holds in `vault_id`, and answers when the registered
    /// windows have all replied, or when the bound expires.
    ///
    /// Serialized by its caller (`runs::dispatch_fs` serves one file request at a time), so
    /// there is at most one of these waiting at any moment — but nothing here depends on that:
    /// the pending map is keyed by request id and two questions would be two entries.
    pub async fn ask(
        &self,
        windows: &dyn LiveNoteWindows,
        vault_id: &str,
        path: &str,
    ) -> LiveNoteAnswer {
        let request_id = format!("live-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let question = LiveNoteQuestion {
            request_id: request_id.clone(),
            vault_id: vault_id.to_string(),
            path: path.to_string(),
        };
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            request_id.clone(),
            Pending {
                question: question.clone(),
                expected: 0,
                answers: Vec::new(),
                sender: Some(sender),
            },
        );
        // The entry goes when this call ends however it ends — a resolved answer, the
        // deadline, or this future being dropped because the runtime went away mid-question.
        // Without that last case a parked question would outlive the runtime that asked it.
        let _parked = Parked {
            table: self,
            request_id: &request_id,
        };

        let reached = windows.ask(&question);
        if reached == 0 {
            return LiveNoteAnswer::Unknown(format!(
                "no window holds the vault {vault_id}, so nothing can say what {path} holds"
            ));
        }
        self.expect(&request_id, reached);

        match tokio::time::timeout(LIVE_NOTE_BOUND, receiver).await {
            Ok(Ok(answer)) => answer,
            // The sender was dropped without an answer: the windows that were asked are gone.
            Ok(Err(_)) => LiveNoteAnswer::Unknown(format!(
                "every window holding {vault_id} went away before answering for {path}"
            )),
            Err(_) => LiveNoteAnswer::Unknown(format!(
                "no window answered for {path} within {}s",
                LIVE_NOTE_BOUND.as_secs()
            )),
        }
    }

    /// Records how many windows were asked, and resolves the question if they have all
    /// answered already.
    fn expect(&self, request_id: &str, reached: usize) {
        let mut pending = self.pending.lock().unwrap();
        if let Some(entry) = pending.get_mut(request_id) {
            entry.expected = reached;
            resolve(entry);
        }
    }

    /// One window's answer. `Err` is a refusal, and every refusal is a *non*-answer: nothing is
    /// served and nothing is decided.
    pub fn answer(&self, payload: LiveNoteAnswerPayload) -> Result<(), LiveNoteRefusal> {
        let request_id = payload.request_id().to_string();
        let mut pending = self.pending.lock().unwrap();
        let Some(entry) = pending.get_mut(&request_id) else {
            return Err(if self.was_retired(&request_id) {
                LiveNoteRefusal::Expired { request_id }
            } else {
                LiveNoteRefusal::NoSuchRequest { request_id }
            });
        };
        // Evidence first: an answer naming another vault or another path is a stale or forged
        // window, and it is refused before it can decide anything about this question.
        if payload.vault_id() != entry.question.vault_id {
            return Err(LiveNoteRefusal::VaultMismatch {
                request_id,
                expected: entry.question.vault_id.clone(),
                answered: payload.vault_id().to_string(),
            });
        }
        if payload.path() != entry.question.path {
            return Err(LiveNoteRefusal::PathMismatch {
                request_id,
                expected: entry.question.path.clone(),
                answered: payload.path().to_string(),
            });
        }
        // The question is over once its waiting half has been fired, and a second answer from
        // the same window is the same fact at a different scale — both are `Expired`, and
        // neither may decide anything.
        if entry.sender.is_none()
            || entry
                .answers
                .iter()
                .any(|(window, _)| window == payload.window_id())
        {
            return Err(LiveNoteRefusal::Expired { request_id });
        }
        entry
            .answers
            .push((payload.window_id().to_string(), payload.reply()));
        resolve(entry);
        Ok(())
    }

    fn was_retired(&self, request_id: &str) -> bool {
        self.retired
            .lock()
            .unwrap()
            .iter()
            .any(|id| id == request_id)
    }

    /// The one place a request id is remembered, called by whichever of the two lives — the
    /// waiting half or the RAII guard that owns the entry — ends the question first.
    fn retire(&self, request_id: &str) {
        let mut retired = self.retired.lock().unwrap();
        if retired.len() == RETIRED_MEMORY {
            retired.pop_front();
        }
        retired.push_back(request_id.to_string());
    }
}

/// Fires the waiting half exactly once, when every window that was asked has answered.
///
/// The rule it decides by is §2.2's: for one path the host accepts an answer only if the
/// windows asked returned exactly one `Held`, or one or more `NotHeld` and no `Held`. Two
/// `Held` answers, or a `Held` beside a `NotHeld`, is `Unknown` — never a pick. A tie-break
/// here would be a guess about which text the user has, and the wrong guess is
/// indistinguishable from a right one.
///
/// A `CannotAnswer` anywhere is `Unknown` too: a window that says it cannot answer yet means
/// this host does not have the whole picture, and the `Held` beside it may be the placeholder
/// case §4.3 names.
fn resolve(entry: &mut Pending) {
    if entry.expected == 0 || entry.answers.len() < entry.expected {
        return;
    }
    let answer = decide(entry);
    if let Some(sender) = entry.sender.take() {
        let _ = sender.send(answer);
    }
}

fn decide(entry: &Pending) -> LiveNoteAnswer {
    if let Some((_, LiveNoteReply::CannotAnswer { reason })) = entry
        .answers
        .iter()
        .find(|(_, reply)| matches!(reply, LiveNoteReply::CannotAnswer { .. }))
    {
        return LiveNoteAnswer::Unknown(reason.clone());
    }
    let held: Vec<&LiveNoteReply> = entry
        .answers
        .iter()
        .map(|(_, reply)| reply)
        .filter(|reply| matches!(reply, LiveNoteReply::Held { .. }))
        .collect();
    let not_held = entry.answers.len() - held.len();
    if held.len() > 1 || (held.len() == 1 && not_held > 0) {
        // The path is in the sentence because it is the only part of the disagreement a reader
        // can act on; the two texts are deliberately not.
        return LiveNoteAnswer::Unknown(format!(
            "two windows answered differently for {} in {}",
            entry.question.path, entry.question.vault_id
        ));
    }
    let Some(LiveNoteReply::Held {
        revision,
        text,
        dirty,
    }) = entry.answers.iter().map(|(_, reply)| reply).next()
    else {
        return LiveNoteAnswer::NotHeld;
    };
    LiveNoteAnswer::Held(LiveNote {
        revision: revision.clone(),
        text: text.clone(),
        dirty: *dirty,
    })
}

/// Removes a question from the table however the asking ended, and remembers the id so a late
/// answer is refused as late rather than as unknown.
struct Parked<'a> {
    table: &'a LiveNoteTable,
    request_id: &'a str,
}

impl Drop for Parked<'_> {
    fn drop(&mut self) {
        let removed = self.table.pending.lock().unwrap().remove(self.request_id);
        if removed.is_some() {
            self.table.retire(self.request_id);
        }
    }
}
