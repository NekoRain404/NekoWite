//! What this seam says on the wire, and what the host says back: one note as a window has it, the
//! question put to it, a window's reply, and the answer and refusal vocabulary this host decides in.
//!
//! **Why it is a file of its own.** It was the top of `live_notes.rs`, which passed the 600-line
//! budget `docs/dev.md:286` puts on a business source file, and the criterion that section states is
//! the number of reasons a file changes rather than its length. This module moves when what a note
//! or an answer *is* moves — a field the window's `AgentLiveNote` starts carrying, an arm the
//! responder learns to send, or a channel name the two ends must agree on — while `super::table`
//! moves when this host's rules for a question do and `super::port` moves when the shape the host is
//! reached through does. A wire both ends copy is not the same change as a rule one end enforces.
//!
//! Nothing here holds state or reaches a window: every item is a name the two ends share or a shape
//! serde reads off it, so the one thing that can go wrong in this file is a spelling the other end
//! does not use.

use serde::{Deserialize, Serialize};

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

// `pub(super)` on these five readers because `super::table` decides with them: they were private to
// this file's one module before the split, and `live_notes` is still the only module that may call
// them.
impl LiveNoteAnswerPayload {
    pub(super) fn request_id(&self) -> &str {
        match self {
            LiveNoteAnswerPayload::Held { request_id, .. }
            | LiveNoteAnswerPayload::NotHeld { request_id, .. }
            | LiveNoteAnswerPayload::CannotAnswer { request_id, .. } => request_id,
        }
    }

    pub(super) fn vault_id(&self) -> &str {
        match self {
            LiveNoteAnswerPayload::Held { vault_id, .. }
            | LiveNoteAnswerPayload::NotHeld { vault_id, .. }
            | LiveNoteAnswerPayload::CannotAnswer { vault_id, .. } => vault_id,
        }
    }

    pub(super) fn path(&self) -> &str {
        match self {
            LiveNoteAnswerPayload::Held { path, .. }
            | LiveNoteAnswerPayload::NotHeld { path, .. }
            | LiveNoteAnswerPayload::CannotAnswer { path, .. } => path,
        }
    }

    pub(super) fn window_id(&self) -> &str {
        match self {
            LiveNoteAnswerPayload::Held { window_id, .. }
            | LiveNoteAnswerPayload::NotHeld { window_id, .. }
            | LiveNoteAnswerPayload::CannotAnswer { window_id, .. } => window_id,
        }
    }

    pub(super) fn reply(&self) -> LiveNoteReply {
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
