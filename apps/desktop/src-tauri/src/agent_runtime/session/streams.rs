//! The reading half of one runtime: the streams the engine writes on.
//!
//! **Why it is a file of its own.** It was a section of [`super`], which passed the 600-line budget
//! `docs/dev.md:286` puts on a business source file, and the criterion that section states is the
//! number of reasons a file changes rather than its length. This module moves when the *stream set*
//! moves: a third channel a driver has to serve, or a change to which of the two one loop may take.
//! The parent moves when the host's own table of sessions does. The two halves are one object
//! already — asking takes `&self` and reading takes `&mut` — which is why the seam is where the
//! type's own doc says it is.

use tokio::sync::mpsc;

use super::super::acp_transport::PermissionRequest;
use super::super::events::AgentEventEnvelope;

/// The reading half of one runtime: the streams the engine writes on.
///
/// Split from [`AgentRuntime`](super::AgentRuntime) at construction, exactly as
/// [`EngineConnection::connect`](super::super::acp_transport::EngineConnection::connect) hands back
/// an [`EngineEvents`](super::super::acp_transport::EngineEvents) beside the connection — and for
/// the reason that split's own doc gives, one layer up: asking takes `&self`, reading takes `&mut`,
/// and the object every caller
/// asks through must not be the object the reader is parked on.
///
/// Two accessors on one `&mut self` cannot be held at once, and the driver needs both: while it
/// waits for a `session/update`, a permission request may arrive, and answering a permission is a
/// command that must not be blocked behind the wait. One task owning both receivers by value is
/// the shape that has no lock to hold across a wait, and therefore no way for the stop §6.2
/// requires to be stuck behind a pending request (T3 found the shape this replaces).
///
/// **It ends on its own.** Both channels are the runtime's: when the runtime goes, both `recv`s
/// answer `None`, so a driver ends with the incarnation it feeds and needs no handle to be
/// aborted through — which is also why nothing here carries a generation counter.
pub struct AgentRuntimeEvents {
    pub(super) incoming: mpsc::UnboundedReceiver<AgentEventEnvelope>,
    pub(super) permissions: mpsc::UnboundedReceiver<PermissionRequest>,
}

/// What the runtime hands its reader: either stream, whichever has something.
pub enum RuntimeEvent {
    Event(AgentEventEnvelope),
    Permission(PermissionRequest),
}

impl AgentRuntimeEvents {
    /// The next host event, or `None` once the runtime has stopped.
    pub async fn next_event(&mut self) -> Option<AgentEventEnvelope> {
        self.incoming.recv().await
    }

    /// The next engine→client request waiting for an answer.
    ///
    /// Nothing answers it here: §6.3 requires the engine's own option ids to be what the user is
    /// offered, and choosing between them is T3/T7's. What this guarantees is only that the
    /// request is not lost, which §6.2 demands in as many words.
    pub async fn next_permission(&mut self) -> Option<PermissionRequest> {
        self.permissions.recv().await
    }

    /// Whichever of the two arrives first.
    ///
    /// One method rather than a `select!` at every call site, because two `&mut self` borrows of
    /// this type cannot be held at once — the property the split exists for: exactly one loop
    /// reads the engine. Both `recv`s are cancel-safe, so the arm that does not win loses nothing,
    /// and `select!` picks among ready arms at random rather than starving one of them.
    pub async fn next(&mut self) -> Option<RuntimeEvent> {
        tokio::select! {
            event = self.incoming.recv() => event.map(RuntimeEvent::Event),
            permission = self.permissions.recv() => permission.map(RuntimeEvent::Permission),
        }
    }
}
