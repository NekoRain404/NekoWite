//! The live-buffer seam: this process asking a window what a note holds *right now*.
//!
//! `fs/read_text_file` is described by ACP as access to "unsaved editor state" and Zed
//! answers it from the open buffer (`project.open_buffer`, `acp_thread.rs:4595`); we answered
//! it from `std::fs::read_to_string` (`storage/file_store.rs`). That divergence is a silent
//! one — an agent re-reading a note the user is mid-edit in receives older, saved text and
//! proposes a change against a version they have already moved past — and it is the reason
//! this module exists. `fs_capability`'s module header states the divergence; this is the
//! direction that closes it.
//!
//! **It is not ACP, and it cannot be borrowed from ACP.** The SDK's connection has exactly two
//! participants and a client's only peer is the agent (`agent-client-protocol-2.1.0/src/
//! concepts/peers.rs:31-32`), so there is no reverse request from the client into its own UI
//! anywhere in the protocol, the schema or the SDK. What this needs is in-process IPC between
//! Rust and a webview — Tauri's own surface — and the SDK's contribution is only the shape of
//! the question the host must eventually answer.
//!
//! **The value type is shared and is not duplicated here.** [`LiveNote`] carries the same
//! three facts the window's `AgentLiveNote` carries (`src/features/agent/services/
//! agent-context-snapshot.ts`): the buffer's text, whether it is dirty, and the document-
//! INSTANCE revision that `agent-edit-apply.ts` and `agent-svg-insertion.ts` both judge
//! staleness against. There is one lookup behind both consumers — the window's tab store —
//! and this port is the second *end* of it, not a second implementation.
//!
//! **The deadline is over our own memory, and that is why it is not the deadline
//! `permissions.rs` refuses.** `PermissionRefusal::Expired` argues that a host-side deadline
//! would be "a policy nothing measured" over *another party's* work — a human deciding, an
//! engine thinking — neither of which has an upper bound. [`LIVE_NOTE_BOUND`] bounds this
//! process answering a question about a `Map` it already holds, behind one in-process IPC hop.
//! A lookup that has not come back is not slow, it is broken. What the bound prevents is
//! concrete: `runs::dispatch_fs` serves file requests one at a time, so a read that never
//! resolves parks the loop and every later read *and write* on that runtime is never
//! answered, for as long as the rail lives.
//!
//! **What expiry may not become is disk.** [`LiveNoteAnswer::NotHeld`] is the only arm a
//! caller may serve from the file, and it is the only arm that was *asked for*: a window said
//! no tab holds this path. `Unknown` — no window registered, a window that went away, a window
//! that says it cannot answer yet, the deadline, two windows disagreeing — is an error the
//! model can act on. A stale read that silently succeeds is indistinguishable from a correct
//! one, which is the failure class this whole area keeps producing.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

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

/// The three channel names this seam is wired with.
///
/// The question is published on the request channel and the window answers on the answer
/// channel; the attach channel carries a window's registration. They live here rather than beside
/// the Tauri adapter because a channel name is the *wire*, and the wire has two ends: the other
/// half is `src/features/agent/services/live-note-responder.ts`, and
/// `tests/agent_live_note_test.rs` compares the two spellings because nothing else can. A
/// mismatch is a wire that silently never connects.
pub const LIVE_NOTE_REQUEST_CHANNEL: &str = "agent-live-note-request";
pub const LIVE_NOTE_ANSWER_CHANNEL: &str = "agent-live-note-answer";
pub const LIVE_NOTE_ATTACH_CHANNEL: &str = "agent-live-note-attach";

/// One note as the WINDOW has it.
///
/// Every field is copied from `AgentLiveNote` by the window's answer, and none of them is a
/// second shape for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveNote {
    /// Document-INSTANCE identity. It moves at the keystroke AND when a document instance is
    /// replaced (a note closed and reopened at the same path), so it is identity and not a
    /// digest of the text. This module must not mint one, and a caller must not derive one:
    /// a content hash cannot express the instance property, so it would be silently wrong in
    /// exactly the reopened-file case the conflict judgement is tested against.
    pub revision: String,
    /// `AgentLiveNoteBuffer::text`, both arms — the buffer, never the disk.
    pub text: String,
    /// `state == 'dirty'`. Carried because it is the difference between a round trip that
    /// bought the user's typing and one that bought nothing.
    pub dirty: bool,
}

/// What a window is asked.
///
/// No session identity travels with it: a window answers about a vault and a path, and nothing
/// else it is told may influence the answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveNoteQuestion {
    /// This host's id for the request, and the only thing that binds an answer to it.
    pub request_id: String,
    /// The vault ROOT. The same spelling as `SessionSlot::vault_root`, which is what makes
    /// "which windows can speak for this vault" a comparison of two strings that are one fact.
    pub vault_id: String,
    /// The note, as the FRONTEND spells an open tab's path.
    ///
    /// `Tab`'s path is not a spelling of convenience: `file_store::list_dir_entries` renders
    /// every entry through `domain::path_policy::ipc_path`, so it is the canonical absolute
    /// path (on Windows, with the verbatim prefix stripped). The ACP request carries a path in
    /// the engine's spelling, so the read arm resolves it within the session root and renders
    /// it the same way before asking — asking with anything else would never match a tab, and
    /// a lookup that never matches answers `not-held` and serves disk: the silent failure this
    /// module exists to remove.
    pub path: String,
}

/// One window's answer, as it arrives from the window.
///
/// The window's vocabulary is `held`, `not-held` or `cannot-answer` **with a reason**. It has
/// no word for "unknown": [`LiveNoteAnswer::Unknown`] is this host's alone, and it means "no
/// answer this host trusts". Folding `cannot-answer` into `not-held` is the defect the whole
/// module is about, because `not-held` is the one arm a caller may serve from disk.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum LiveNoteReply {
    Held {
        revision: String,
        text: String,
        dirty: bool,
    },
    NotHeld,
    /// The window knows it cannot answer yet, and says why — e.g. the tab is still on its
    /// first read, so what it holds is a placeholder wearing the note's path.
    CannotAnswer {
        reason: String,
    },
}

/// One answer as it comes off the wire: the reply, plus the evidence that it belongs to the
/// question it names.
///
/// `vaultId` and `path` travel back for the reason `PermissionAnswer` carries its identity: an
/// answer naming a different vault or a different path is a stale or forged window, and the
/// answer is refused rather than applied. `windowId` is the answering window's own identity,
/// and it is what tells a *duplicate* (the same window answering twice — `Expired`) apart from
/// a *disagreement* (two windows, one path — `Unknown`). Without it those two are the same
/// event, and §2.2's rule could not be implemented at all.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum LiveNoteAnswerPayload {
    Held {
        request_id: String,
        vault_id: String,
        path: String,
        window_id: String,
        revision: String,
        text: String,
        dirty: bool,
    },
    NotHeld {
        request_id: String,
        vault_id: String,
        path: String,
        window_id: String,
    },
    CannotAnswer {
        request_id: String,
        vault_id: String,
        path: String,
        window_id: String,
        reason: String,
    },
}

impl LiveNoteAnswerPayload {
    fn request_id(&self) -> &str {
        match self {
            LiveNoteAnswerPayload::Held { request_id, .. }
            | LiveNoteAnswerPayload::NotHeld { request_id, .. }
            | LiveNoteAnswerPayload::CannotAnswer { request_id, .. } => request_id,
        }
    }

    fn vault_id(&self) -> &str {
        match self {
            LiveNoteAnswerPayload::Held { vault_id, .. }
            | LiveNoteAnswerPayload::NotHeld { vault_id, .. }
            | LiveNoteAnswerPayload::CannotAnswer { vault_id, .. } => vault_id,
        }
    }

    fn path(&self) -> &str {
        match self {
            LiveNoteAnswerPayload::Held { path, .. }
            | LiveNoteAnswerPayload::NotHeld { path, .. }
            | LiveNoteAnswerPayload::CannotAnswer { path, .. } => path,
        }
    }

    fn window_id(&self) -> &str {
        match self {
            LiveNoteAnswerPayload::Held { window_id, .. }
            | LiveNoteAnswerPayload::NotHeld { window_id, .. }
            | LiveNoteAnswerPayload::CannotAnswer { window_id, .. } => window_id,
        }
    }

    fn reply(&self) -> LiveNoteReply {
        match self {
            LiveNoteAnswerPayload::Held {
                revision,
                text,
                dirty,
                ..
            } => LiveNoteReply::Held {
                revision: revision.clone(),
                text: text.clone(),
                dirty: *dirty,
            },
            LiveNoteAnswerPayload::NotHeld { .. } => LiveNoteReply::NotHeld,
            LiveNoteAnswerPayload::CannotAnswer { reason, .. } => LiveNoteReply::CannotAnswer {
                reason: reason.clone(),
            },
        }
    }
}

/// The answer to one question about one path.
///
/// `NotHeld` is the ONLY arm that may become disk, and it may only become disk because it was
/// asked for: a window that holds this vault said no tab holds this path. Every other arm is
/// an error the engine can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveNoteAnswer {
    Held(LiveNote),
    NotHeld,
    /// No answer to be had, with the reason: no window registered for this vault, the window
    /// went away, the window said it cannot answer yet, or the deadline. NEVER folded into
    /// `NotHeld`.
    Unknown(String),
}

/// Why a window's answer was not applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveNoteRefusal {
    /// The question has ended — resolved, retired by the deadline, or already answered by this
    /// same window. No timer of its own: "expired" means the request is over, which is the
    /// usage `PermissionRefusal::Expired` already gives the word.
    Expired { request_id: String },
    /// The answer names another vault than the question did.
    VaultMismatch {
        request_id: String,
        expected: String,
        answered: String,
    },
    /// The answer names another path than the question did.
    PathMismatch {
        request_id: String,
        expected: String,
        answered: String,
    },
    /// No question of ours ever carried this id.
    NoSuchRequest { request_id: String },
}

impl LiveNoteRefusal {
    /// The sentence for a log line. There is no user-facing surface for these — a window that
    /// answers the wrong question is a host inconsistency, not something the user did — so
    /// this is the report rather than the wording of a prompt.
    pub fn sentence(&self) -> String {
        match self {
            LiveNoteRefusal::Expired { request_id } => {
                format!("live-note request {request_id} is no longer open")
            }
            LiveNoteRefusal::VaultMismatch {
                request_id,
                expected,
                answered,
            } => {
                format!("live-note answer {request_id} names the vault {answered}, not {expected}")
            }
            LiveNoteRefusal::PathMismatch {
                request_id,
                expected,
                answered,
            } => format!("live-note answer {request_id} names {answered}, not {expected}"),
            LiveNoteRefusal::NoSuchRequest { request_id } => {
                format!("no live-note request of this host's was called {request_id}")
            }
        }
    }
}

/// How a question reaches the windows, and how many of them can answer it.
///
/// The runtime declares the port and whoever owns the IPC surface implements it, the same way
/// [`super::fs_capability::VaultFiles`] is declared here and implemented by `storage`. It
/// exists as a trait so a test can hand in a window that answers, and so `agent_runtime` does
/// not learn about Tauri.
pub trait LiveNoteWindows: Send + Sync + 'static {
    /// Ask every window that can speak for the question's vault. `0` means none can, and the
    /// caller must not wait: waiting for a listener that does not exist is the only thing that
    /// can turn a missing capability into a ten-second stall on the serialized fs loop.
    fn ask(&self, question: &LiveNoteQuestion) -> usize;
}

/// One question in flight.
struct Pending {
    question: LiveNoteQuestion,
    /// How many windows were asked. Set once [`LiveNoteWindows::ask`] has answered — a window
    /// can reply before that line runs, so `0` means "not known yet", never "nobody".
    expected: usize,
    /// `(windowId, reply)`, one per window. Two entries from one window is the duplicate this
    /// refuses rather than a disagreement.
    answers: Vec<(String, LiveNoteReply)>,
    /// The waiting half. Taken when the question resolves.
    sender: Option<oneshot::Sender<LiveNoteAnswer>>,
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
    pending: Mutex<HashMap<String, Pending>>,
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

/// The seam as the read path uses it: the questions this host has asked, and the windows that
/// answer them.
///
/// One value rather than two parameters because the two ends are one mechanism — a table that
/// could be asked without a way to reach a window, or a window port with no table behind it,
/// would be a shape nothing in this app can be in.
#[derive(Clone)]
pub struct LiveNotes {
    table: Arc<LiveNoteTable>,
    windows: Arc<dyn LiveNoteWindows>,
}

impl LiveNotes {
    pub fn new(table: Arc<LiveNoteTable>, windows: Arc<dyn LiveNoteWindows>) -> Self {
        Self { table, windows }
    }

    /// The table the answer path completes requests through. Handed out so the IPC surface can
    /// deliver a window's answer without owning the question side.
    pub fn table(&self) -> Arc<LiveNoteTable> {
        Arc::clone(&self.table)
    }

    /// What `path` holds in `vault_id`, as the window holding it says.
    pub async fn ask(&self, vault_id: &str, path: &str) -> LiveNoteAnswer {
        self.table.ask(self.windows.as_ref(), vault_id, path).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// A window that answers the moment it is asked.
    ///
    /// The real one answers one IPC hop later, which is the same order of events: the table has
    /// parked the question and set `expected` before the reply is delivered. What this cannot
    /// exercise is the deadline, which is ten seconds by design — the test below reaches the
    /// late-answer path by ending the asking itself instead.
    struct AnsweringWindow {
        reached: usize,
        /// What each answering window says, in the order the answers are delivered.
        replies: Vec<(String, LiveNoteReply)>,
        table: StdMutex<Option<Arc<LiveNoteTable>>>,
        asked: StdMutex<Vec<LiveNoteQuestion>>,
    }

    impl AnsweringWindow {
        fn new(reached: usize, replies: Vec<(String, LiveNoteReply)>) -> Arc<Self> {
            Arc::new(Self {
                reached,
                replies,
                table: StdMutex::new(None),
                asked: StdMutex::new(Vec::new()),
            })
        }
    }

    impl LiveNoteWindows for AnsweringWindow {
        fn ask(&self, question: &LiveNoteQuestion) -> usize {
            self.asked.lock().unwrap().push(question.clone());
            let table = self.table.lock().unwrap().clone().expect("installed");
            for (window_id, reply) in &self.replies {
                // Identity is copied from the question rather than scripted: these three
                // fields are evidence, and a window cannot get them wrong without being
                // refused. The refusal vocabulary is exercised directly, below.
                let payload = match reply.clone() {
                    LiveNoteReply::Held {
                        revision,
                        text,
                        dirty,
                    } => LiveNoteAnswerPayload::Held {
                        request_id: question.request_id.clone(),
                        vault_id: question.vault_id.clone(),
                        path: question.path.clone(),
                        window_id: window_id.clone(),
                        revision,
                        text,
                        dirty,
                    },
                    LiveNoteReply::NotHeld => LiveNoteAnswerPayload::NotHeld {
                        request_id: question.request_id.clone(),
                        vault_id: question.vault_id.clone(),
                        path: question.path.clone(),
                        window_id: window_id.clone(),
                    },
                    LiveNoteReply::CannotAnswer { reason } => LiveNoteAnswerPayload::CannotAnswer {
                        request_id: question.request_id.clone(),
                        vault_id: question.vault_id.clone(),
                        path: question.path.clone(),
                        window_id: window_id.clone(),
                        reason,
                    },
                };
                // A refusal is a bug in this file or a real disagreement; either way the test
                // asserts on the answer the asking half receives, so the refusal is carried to
                // it rather than swallowed. A refused answer simply does not resolve.
                let _ = table.answer(payload);
            }
            self.reached
        }
    }

    /// A window that can answer and never does.
    struct SilentWindow;

    impl LiveNoteWindows for SilentWindow {
        fn ask(&self, _question: &LiveNoteQuestion) -> usize {
            1
        }
    }

    fn held(window: &str, text: &str) -> (String, LiveNoteReply) {
        (
            window.to_string(),
            LiveNoteReply::Held {
                revision: format!("{window}:tab-1:7"),
                text: text.to_string(),
                dirty: true,
            },
        )
    }

    fn not_held(window: &str) -> (String, LiveNoteReply) {
        (window.to_string(), LiveNoteReply::NotHeld)
    }

    async fn ask_with(reached: usize, replies: Vec<(String, LiveNoteReply)>) -> LiveNoteAnswer {
        let window = AnsweringWindow::new(reached, replies);
        let table = Arc::new(LiveNoteTable::new());
        *window.table.lock().unwrap() = Some(Arc::clone(&table));
        LiveNotes::new(table, window)
            .ask("/vault", "/vault/notes/x.md")
            .await
    }

    #[tokio::test]
    async fn a_vault_no_window_holds_is_unknown_and_is_not_waited_for() {
        let window = AnsweringWindow::new(0, Vec::new());
        let table = Arc::new(LiveNoteTable::new());
        *window.table.lock().unwrap() = Some(Arc::clone(&table));
        let started = std::time::Instant::now();
        let answer = LiveNotes::new(table, window)
            .ask("/vault", "/vault/notes/x.md")
            .await;
        // The bound is ten seconds: a version of this that waited for a listener which does
        // not exist would be the stall the count exists to prevent.
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(matches!(answer, LiveNoteAnswer::Unknown(_)), "{answer:?}");
    }

    #[tokio::test]
    async fn one_window_holding_the_path_is_the_answer() {
        assert_eq!(
            ask_with(1, vec![held("page-a", "IN THE BUFFER")]).await,
            LiveNoteAnswer::Held(LiveNote {
                revision: "page-a:tab-1:7".to_string(),
                text: "IN THE BUFFER".to_string(),
                dirty: true,
            })
        );
    }

    #[tokio::test]
    async fn one_window_saying_no_tab_holds_it_is_not_held() {
        assert_eq!(
            ask_with(1, vec![not_held("page-a")]).await,
            LiveNoteAnswer::NotHeld
        );
    }

    #[tokio::test]
    async fn a_window_that_cannot_answer_yet_is_unknown_and_never_not_held() {
        let answer = ask_with(
            1,
            vec![(
                "page-a".to_string(),
                LiveNoteReply::CannotAnswer {
                    reason: "the tab is still reading the file".to_string(),
                },
            )],
        )
        .await;
        assert_eq!(
            answer,
            LiveNoteAnswer::Unknown("the tab is still reading the file".to_string())
        );
    }

    #[tokio::test]
    async fn two_windows_holding_one_path_is_unknown_and_never_a_pick() {
        let answer = ask_with(2, vec![held("page-a", "A"), held("page-b", "B")]).await;
        assert!(matches!(answer, LiveNoteAnswer::Unknown(_)), "{answer:?}");
    }

    #[tokio::test]
    async fn a_held_beside_a_not_held_is_unknown() {
        let answer = ask_with(2, vec![held("page-a", "A"), not_held("page-b")]).await;
        assert!(matches!(answer, LiveNoteAnswer::Unknown(_)), "{answer:?}");
    }

    #[tokio::test]
    async fn two_windows_agreeing_that_no_tab_holds_it_is_not_held() {
        assert_eq!(
            ask_with(2, vec![not_held("page-a"), not_held("page-b")]).await,
            LiveNoteAnswer::NotHeld
        );
    }

    #[tokio::test]
    async fn the_same_window_answering_twice_is_a_duplicate_and_not_a_disagreement() {
        // Two answers, one expected window: the second is refused as a duplicate, so the
        // question resolves on the first rather than reading as two windows disagreeing.
        assert_eq!(
            ask_with(1, vec![held("page-a", "A"), held("page-a", "B")]).await,
            LiveNoteAnswer::Held(LiveNote {
                revision: "page-a:tab-1:7".to_string(),
                text: "A".to_string(),
                dirty: true,
            })
        );
    }

    /// Parks one question by hand, the way `ask` parks it, so the refusal vocabulary can be
    /// exercised without a window.
    fn parked(table: &Arc<LiveNoteTable>) -> LiveNoteQuestion {
        let question = LiveNoteQuestion {
            request_id: "live-0".to_string(),
            vault_id: "/vault".to_string(),
            path: "/vault/notes/x.md".to_string(),
        };
        let (sender, _receiver) = oneshot::channel();
        table.pending.lock().unwrap().insert(
            question.request_id.clone(),
            Pending {
                question: question.clone(),
                expected: 1,
                answers: Vec::new(),
                sender: Some(sender),
            },
        );
        question
    }

    #[tokio::test]
    async fn an_answer_that_names_another_vault_or_path_is_refused() {
        let table = Arc::new(LiveNoteTable::new());
        parked(&table);
        let refusal = |vault: &str, path: &str| {
            table.answer(LiveNoteAnswerPayload::NotHeld {
                request_id: "live-0".to_string(),
                vault_id: vault.to_string(),
                path: path.to_string(),
                window_id: "page-a".to_string(),
            })
        };
        assert!(matches!(
            refusal("/other", "/vault/notes/x.md"),
            Err(LiveNoteRefusal::VaultMismatch { .. })
        ));
        assert!(matches!(
            refusal("/vault", "/vault/notes/y.md"),
            Err(LiveNoteRefusal::PathMismatch { .. })
        ));
        // A well-formed answer is still accepted after the two refusals, so neither of them
        // consumed the question.
        assert!(refusal("/vault", "/vault/notes/x.md").is_ok());
    }

    #[tokio::test]
    async fn an_answer_to_a_question_this_host_never_asked_is_refused() {
        let table = Arc::new(LiveNoteTable::new());
        let refusal = table.answer(LiveNoteAnswerPayload::NotHeld {
            request_id: "live-404".to_string(),
            vault_id: "/vault".to_string(),
            path: "/vault/notes/x.md".to_string(),
            window_id: "page-a".to_string(),
        });
        assert!(matches!(
            refusal,
            Err(LiveNoteRefusal::NoSuchRequest { .. })
        ));
    }

    #[tokio::test]
    async fn a_late_answer_to_a_question_that_ended_is_refused_as_expired() {
        let table = Arc::new(LiveNoteTable::new());
        let notes = LiveNotes::new(Arc::clone(&table), Arc::new(SilentWindow));
        let asking = tokio::spawn(async move { notes.ask("/vault", "/vault/notes/x.md").await });
        // Long enough for the child to have parked its question; the ten-second bound is not
        // what ends this one.
        tokio::time::sleep(Duration::from_millis(50)).await;
        asking.abort();
        let _ = asking.await;
        // `Parked` removed the entry when the abort dropped the future, so the id is in the
        // retired ring rather than the pending map.
        let late = table.answer(LiveNoteAnswerPayload::NotHeld {
            request_id: "live-0".to_string(),
            vault_id: "/vault".to_string(),
            path: "/vault/notes/x.md".to_string(),
            window_id: "page-a".to_string(),
        });
        assert!(
            matches!(late, Err(LiveNoteRefusal::Expired { .. })),
            "{late:?}"
        );
    }
}
