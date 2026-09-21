//! The one session slot every agent command reads, and the channel the runtime's frames are
//! published on.
//!
//! **Why this is a module and not part of `agent.rs`.** The parent had reached 634 lines against the
//! 600-line budget `docs/dev.md:286` puts on a business file, and the split is by *reason to
//! change* — the criterion that same section states. The two items here are one subject: what a
//! command needs in order to answer *at all* — the session this app is running, and the channel a
//! frame about it arrives on. What makes this file change is the shape of that shared state: a
//! second slot, a different lifetime for a session, a channel that becomes per-session. Nothing
//! about a refusal's wording, an engine's lifecycle or a session's commands changes it.
//!
//! The channel is declared here rather than beside the emitter in `agent_events.rs`, because a
//! channel's *name* is the one thing both sides of the wire have to spell the same, and this module
//! is where the state a frame is about already lives. `agent_events` reads it from
//! `super::agent::AGENT_EVENT_CHANNEL`, which is the path it has always used.

use std::sync::{Mutex, MutexGuard};

use crate::agent_runtime::driver::Session;

use super::failure::AgentFailure;

/// The one sentence a poisoned slot is refused with, wherever it is refused.
///
/// One constant and not two spellings: a reader and a writer must not be able to describe the same
/// condition differently, which is the same rule `AgentFailure`'s docblock gives about a code and
/// its sentence.
const POISONED: &str = "the agent session state was poisoned by a panic";

/// The channel the runtime's events are published on.
///
/// One channel for every session, not one per session: §6.2's envelope carries the composite
/// identity, so a frame already says which session, run and sequence it belongs to — and a
/// channel per session would leak a listener for every session a window ever opened. The adapter
/// (`tauri-agent/ipc.ts`) declares the same name from the other side; it is the wire's, and the
/// two spellings are one decision.
pub const AGENT_EVENT_CHANNEL: &str = "agent-event";

/// What every agent command needs: the session this app is running, if any.
///
/// One slot, `None` until `agent_start` fills it — the shape `KeyVault` and `AgentRuntimeState`
/// use, and here for a reason of Tauri's rather than of taste: `manage` sets a type's state once,
/// so a second `agent_start` after a stop has nowhere to put a fresh value except *inside* a
/// state that already exists. The slot is that inside, and it is also what makes the answer to
/// "is an engine running" one value rather than a set of Arc fields that could disagree.
pub struct AgentIpcState {
    session: Mutex<Option<Session>>,
}

impl Default for AgentIpcState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

impl AgentIpcState {
    /// The slot itself, or the refusal every caller but one shares.
    ///
    /// **Why the writers go through this too.** `install` and `clear` used to swallow the poison
    /// (`if let Ok(..)`, `.ok()`), so after a panic while the slot was held, `agent_start` answered
    /// a handle and an epoch for a session nothing had installed, and a later `clear` returned
    /// `None` — which is also how `stop_running_engine` decides whether to revoke the permission
    /// table and retire the pet's tasks. Five readers refused loudly and the two writers failed
    /// soft; the asymmetry was the defect. A caller that must not proceed answers the sentence, and
    /// a caller that can still do its work is written so that it does (see
    /// [`stop_running_engine`](super::lifecycle::stop_running_engine)).
    fn locked(&self) -> Result<MutexGuard<'_, Option<Session>>, AgentFailure> {
        self.session
            .lock()
            .map_err(|_| AgentFailure::unavailable(POISONED))
    }

    /// The running session, or the sentence that says there is none.
    ///
    /// `runtime-unavailable` for both arms, and for the same reason: neither is a fact about a
    /// session — there is no session — so the code names the one thing they have in common, which
    /// is that nothing here can be asked. A window that branches on it is branching on "start an
    /// engine", which is exactly what the sentence tells the user to do.
    pub fn session(&self) -> Result<Session, AgentFailure> {
        self.locked()?.as_ref().cloned().ok_or_else(|| {
            AgentFailure::unavailable("no agent session is running: start one first")
        })
    }

    /// Installs the session a start produced, replacing whatever was there.
    ///
    /// It reports the poison rather than dropping the session on the floor, and
    /// [`agent_start`](super::lifecycle::agent_start) answers that refusal by taking the engine down
    /// again: an engine that is running while nothing can address it is worse than a start that
    /// failed.
    pub fn install(&self, session: Session) -> Result<(), AgentFailure> {
        *self.locked()? = Some(session);
        Ok(())
    }

    /// Takes the session out, answering it to the caller: the caller is the one that has to end
    /// its turns and answer its prompts, and it must do that before the runtime goes.
    ///
    /// `Ok(None)` is "there was nothing installed", which is a fact; `Err` is "this slot cannot be
    /// read", which is a different one and is why the two are not collapsed.
    pub fn clear(&self) -> Result<Option<Session>, AgentFailure> {
        Ok(self.locked()?.take())
    }

    /// The same slot, read as a *state* rather than as a refusal.
    ///
    /// [`session`](Self::session) answers the sentence for a caller that cannot proceed without
    /// one. The grants readout is the opposite case: "no engine is running" is one of its own
    /// answers — a page must be able to draw it — so a caller that turned it into an error would
    /// have to reconstruct the state it threw away. A poisoned lock is still `None` here, because
    /// a panic on another task is not a session either.
    pub fn session_or_none(&self) -> Option<Session> {
        self.session.lock().ok().and_then(|slot| slot.clone())
    }
}

#[cfg(test)]
mod tests;
