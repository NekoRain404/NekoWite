//! How a refused call is reported to the window: the condition's own code, the sentence, and the
//! wording a refused permission answer is given.
//!
//! **Why this is a module and not part of `agent.rs`.** The parent had reached 634 lines against the
//! 600-line budget `docs/dev.md:286` puts on a business file, and the split is by *reason to
//! change* — the criterion that same section states. What makes this file change is a refusal: a
//! code added to `AgentFailureCode`, a sentence reworded, a sixth arm on `PermissionRefusal`.
//! Nothing here changes because an engine starts, a session opens, or a permission is answered.
//!
//! The type and [`refusal_message`] travel together because they are one decision read twice:
//! [`AgentFailure::of_permission`] is that sentence plus the code naming the condition it belongs
//! to, and an arm added in one of the two files alone would be a code and a sentence that describe
//! different conditions.

use serde::Serialize;

use crate::agent_runtime::events::AgentFailureCode;
use crate::agent_runtime::permissions::PermissionRefusal;
use crate::agent_runtime::session::SessionError;

/// A failure as it crosses the IPC boundary: the condition's own code, and the sentence.
///
/// The contract's `AgentFailure` (`agent-contracts/failure.ts`) on this side of the wire — the same
/// pair of fields a `run-failed` frame carries, so a call and a turn name a condition the same way.
/// It exists because a command's rejection used to be the *sentence alone*: `SessionError::failure_code`
/// was written, tested and reached by nothing, so a window that received 「this session is already
/// answering」 had nothing to branch on and no way to learn which condition it had hit. That is the
/// same defect one layer up from a frame nothing can read, and the fix is the same: the fact
/// travels with the wording.
///
/// **This is a rejection, and it is the only thing on this surface that is.** A refusal that is
/// *data* — a registry entry a page renders, a skill arrangement the backend would not accept —
/// travels in the `Ok` arm as a value (`RegistryRefusal`, `SkillError`), and the settings clients
/// state that rule in their own headers. The agent surface is the other case, and deliberately: the
/// contract's `AgentGateway` declares every method as rejecting with an `AgentFailure`, because
/// 「the engine did not answer」 and 「this turn is already running」 are one channel to the caller —
/// a gateway method cannot return a value *and* fail to have run.
///
/// The code is computed here rather than taken from the caller, for the reason §6.1 gives about
/// identity: a renderer that could name the condition could name one it did not hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFailure {
    pub code: AgentFailureCode,
    pub message: String,
}

impl AgentFailure {
    pub fn new(code: AgentFailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The runtime's own refusal, as the contract names it: the code and the sentence are the two
    /// halves `SessionError` already keeps apart, and this only carries them across.
    pub fn of_session(error: &SessionError) -> Self {
        Self::new(error.failure_code(), error.failure_message())
    }

    /// A refused permission answer.
    ///
    /// Four of the five refusals are one condition on this vocabulary — `permission-denied`, "the
    /// answer did not take effect" — and the fifth names a session this host does not have, which
    /// is the same fact `SessionError::UnknownSession` answers with. The split is made here, where
    /// the refusal was raised, rather than by a window that would have to read five sentences to
    /// guess it; the sentences stay untouched and remain the part the user reads.
    pub fn of_permission(refusal: &PermissionRefusal) -> Self {
        match refusal {
            PermissionRefusal::UnknownSession { session_id } => Self::new(
                AgentFailureCode::SessionStale,
                format!("session {session_id} is not one this app opened"),
            ),
            other => Self::new(AgentFailureCode::PermissionDenied, refusal_message(other)),
        }
    }

    /// There is no engine to ask: no session has been started, or the state that holds one is gone.
    ///
    /// `runtime-unavailable` is the code the contract's own adapter uses for the same fact when it
    /// answers it alone (`tauri-agent.ts`), so a caller sees one word for "nothing is running"
    /// whichever side refused.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(AgentFailureCode::RuntimeUnavailable, message)
    }

    /// A session id this host does not hold — §6.1's guard, refused everywhere it appears.
    pub fn stale(message: impl Into<String>) -> Self {
        Self::new(AgentFailureCode::SessionStale, message)
    }

    /// A vault or path the user never opened.
    ///
    /// The app's own confinement refusing to serve a folder nothing vouches for: the request asked
    /// for something outside what this window may reach, which is what `permission-denied` names.
    pub fn not_permitted(message: impl Into<String>) -> Self {
        Self::new(AgentFailureCode::PermissionDenied, message)
    }
}

/// The sentence the renderer shows for a refused answer.
///
/// It lives on this side because it is presentation: the runtime answers with the fact, and the
/// wording is about what the user's click did. "no longer open" and "answered already" are
/// different facts about that click, and the difference is worth keeping (spec §3.5: Zed's
/// duplicate repaints the tool call though the engine never sees it).
pub fn refusal_message(refusal: &PermissionRefusal) -> String {
    match refusal {
        PermissionRefusal::Expired { request_id } => {
            format!("permission request {request_id} is no longer open")
        }
        PermissionRefusal::AlreadyAnswered { request_id } => {
            format!("permission request {request_id} was answered already")
        }
        PermissionRefusal::IdentityMismatch { field } => format!(
            "this answer does not belong to that request: {field} is not the one it was raised \
             under"
        ),
        PermissionRefusal::OptionNotOffered { option_id } => {
            format!("the engine did not offer the option {option_id}")
        }
        PermissionRefusal::UnknownSession { session_id } => {
            format!("session {session_id} is not one this app opened")
        }
    }
}
