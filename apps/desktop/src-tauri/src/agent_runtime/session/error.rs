//! The refusals a session call can make, and the contract code each one answers as.
//!
//! **Why it is a file of its own.** It was the top of [`super`], which passed the 600-line budget
//! `docs/dev.md:286` puts on a business source file; the criterion that section states is the
//! number of reasons a file changes rather than its length. This module moves when the *vocabulary*
//! moves: a code the contract adds, a refusal that turns out to be two facts, or a sentence the
//! user reads. The parent moves when the host's own table of sessions does — which ids it holds,
//! and the calls that keep that table in step with the engine. Nothing below reads that table or an
//! engine answer: a variant carries the id or the sentence it was built with and nothing else.
//!
//! The mapping is asserted at the bottom of this file rather than only at the boundary, because
//! this is where it is a decision — the boundary passes whatever
//! [`SessionError::failure_code`] answers through.

use super::super::events::{AgentFailureCode, TransportError};

/// Why a session call was refused.
#[derive(Debug, Clone)]
pub enum SessionError {
    Transport(TransportError),
    /// The host was asked about a session it never opened: §6.1 forbids
    /// inventing a session id, and answering about one would be exactly that.
    UnknownSession {
        session_id: String,
    },
    /// §6.2: one active generation per session. A second prompt is refused
    /// rather than queued behind the first, because a silent queue turns a
    /// user's second thought into a surprise answer minutes later.
    RunInProgress {
        session_id: String,
    },
    /// A load named a session this host already holds.
    ///
    /// Not a fault in the engine: a session this app opened is open, and re-loading it would
    /// replace the slot a window is following — dropping its run, its vault root and its
    /// engine-reported options — with a second copy of itself. The user picked a row they are
    /// already in, and the answer is to say so rather than to reload underneath them.
    AlreadyOpen {
        session_id: String,
    },
    /// A `session/load` for this session is already in flight.
    ///
    /// Its own variant rather than a reuse of [`Self::AlreadyOpen`], because the two are different
    /// facts about the user's click and the wording is what they act on: one says the session is
    /// open (do nothing), the other says it is being opened (wait a moment). They also reach
    /// different states — the second is transient, and a caller that treated it as the first would
    /// tell the user their session was already open while it was still coming back.
    LoadInFlight {
        session_id: String,
    },
    /// A turn carried a block the engine's own handshake does not license.
    ///
    /// Its own variant rather than a transport failure, because nothing was sent: the host refused
    /// before the frame was built, and the condition is the engine's report rather than anything
    /// that happened on the wire. The window gates the same control on the same report, so this arm
    /// is the race — a runtime replaced between the report being read and the turn being sent —
    /// answered as a refusal instead of as a frame the engine never said it would read.
    AttachmentRefused {
        detail: String,
    },
}

impl SessionError {
    /// The condition, as the contract names it.
    pub fn failure_code(&self) -> AgentFailureCode {
        match self {
            SessionError::Transport(error) => error.failure_code(),
            // A session the host does not have is a session whose runtime epoch
            // has moved on — the app restarted, the vault was switched — which
            // is what `session-stale` describes.
            SessionError::UnknownSession { .. } => AgentFailureCode::SessionStale,
            // Its own condition and its own code: the turn is *still running*, which `Cancelled`
            // said the opposite of, and which no other code in the vocabulary names. The window's
            // half of the same refusal is `TurnInFlight` too (`tauri-agent.ts`).
            SessionError::RunInProgress { .. } => AgentFailureCode::TurnInFlight,
            // The session is one this host holds, so the epoch has not moved — what is wrong is
            // that the caller asked to open something that is already open. It is a state
            // conflict of its own and it has its own code, for the reason the `SessionOpen` arm
            // gives: `buffer-conflict` is this vocabulary's word for a stream that cannot be
            // continued, and neither of these is that.
            SessionError::AlreadyOpen { .. } => AgentFailureCode::SessionOpen,
            SessionError::LoadInFlight { .. } => AgentFailureCode::LoadInFlight,
            SessionError::AttachmentRefused { .. } => AgentFailureCode::AttachmentUnsupported,
        }
    }

    /// The sentence the user sees.
    pub fn failure_message(&self) -> String {
        match self {
            SessionError::Transport(error) => error.failure_message(),
            SessionError::UnknownSession { session_id } => {
                format!("session {session_id} is no longer open")
            }
            SessionError::RunInProgress { .. } => {
                "this session is already answering; wait for it or stop it".to_string()
            }
            SessionError::AlreadyOpen { session_id } => {
                format!("session {session_id} is already open in this window")
            }
            SessionError::LoadInFlight { session_id } => {
                format!("session {session_id} is still being reopened; wait for it to finish")
            }
            // The refusal's own sentence, built where the report it reads lives
            // (`super::attachments::AttachmentRefusal`) — this arm only carries it.
            SessionError::AttachmentRefused { detail } => detail.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two refusals about *what the session is doing* carry codes that say so.
    ///
    /// Both were published as `buffer-conflict`, which is the vocabulary's word for a stream that
    /// cannot be continued (`tauri-agent.ts`'s sequence gap; the window reducer's capacity abort)
    /// and for nothing else. A reader who saw it on a load had to open both sources to learn which
    /// condition it was, and neither answer was in the word: one refusal means "you are already in
    /// this session, do nothing" and the other "it is still coming back, wait a moment". They are
    /// also the two refusals a *window* can reach by pressing a row in the session list, which is
    /// what makes the difference worth carrying rather than worth explaining.
    ///
    /// Asserted here rather than only at the boundary because this is where the mapping is a
    /// decision: the boundary passes whatever this answers through.
    #[test]
    fn a_state_conflict_is_named_by_its_own_code_and_not_by_a_streams() {
        let open = SessionError::AlreadyOpen {
            session_id: "ses-1".to_string(),
        };
        let loading = SessionError::LoadInFlight {
            session_id: "ses-1".to_string(),
        };
        assert_eq!(open.failure_code(), AgentFailureCode::SessionOpen);
        assert_eq!(loading.failure_code(), AgentFailureCode::LoadInFlight);
        for error in [&open, &loading] {
            assert_ne!(
                error.failure_code(),
                AgentFailureCode::BufferConflict,
                "a state conflict is not a stream that cannot be continued: {error:?}"
            );
        }
        // And the two are different facts, so one code cannot serve both: the first is a
        // statement that there is nothing to do, the second that waiting is what there is to do.
        assert_ne!(open.failure_code(), loading.failure_code());
    }
}
