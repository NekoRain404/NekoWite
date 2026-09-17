//! The one task that reads what a runtime's engine sends.
//!
//! [`AgentRuntimeEvents`] holds both of a runtime's streams, and this is the loop that drains
//! them: every envelope goes into the session snapshot and then out to whoever is showing the
//! window, and every permission request goes into the table that answers it. Nothing else reads
//! the engine — which is the property the split exists for, and the reason the loop can hold
//! `&mut` on both receivers without a lock anyone could be blocked behind.
//!
//! **It is not owned by anything, and it does not need to be.** The streams are the runtime's own
//! channels, so when the runtime goes both `recv`s answer `None` and this returns; there is no
//! `JoinHandle` to keep, and nothing to abort when a session is replaced. What a *stale* task
//! could still do — deliver a frame after its incarnation stopped being the live one — cannot be
//! acted on either: every envelope carries the epoch it was minted under, which is what §6.2's
//! trailing-edge rule is made of, and the window's subscriber filters on it. So the shape here is
//! the watcher's `generation` precedent with the counter already minted by `registry`: no second
//! authority, and no manager holding a handle it would only ever drop.
//!
//! One consequence worth stating rather than discovering: the sink is *called on this task*, so a
//! sink that blocks (or awaits) would stop the engine's frames from being read at all. Tauri's
//! `emit` does neither — it serializes and hands the payload to the event loop.

use std::sync::Arc;

use super::events::{AgentEventEnvelope, AgentIdentity};
use super::permission_grants::EngineHttp;
use super::permissions::PermissionTable;
use super::registry::AgentInstance;
use super::session::{AgentRuntime, AgentRuntimeEvents, RuntimeEvent};
use super::snapshot::{SessionSnapshots, REPLAY_WINDOW};

/// One running session subsystem: everything a command that addresses the live runtime needs.
///
/// The runtime's three companions travel with it because they are all bound to the same
/// incarnation — the permission table answers this engine's requests, the snapshots replay this
/// engine's stream, and the model option id is this engine's adapter's answer — so a value that
/// held one without the others would be a state the app cannot be in. `install` is the only
/// constructor, and it is the join that made the runtime's receivers move: the table needs the
/// runtime *before* it is shared ([`PermissionTable::new`] reads it), the commands need it
/// shared, and the driver needs the streams out of it.
///
/// `Clone` is cheap and deliberate: a command takes a copy out of the state's lock and holds it
/// across its awaits, so nothing is locked while an engine call is in flight.
#[derive(Clone)]
pub struct Session {
    /// The five-field identity's first four; a session id says which session of it.
    pub identity: AgentIdentity,
    /// The asking half, shared: every command takes `&self`, and no command owns it.
    pub runtime: Arc<AgentRuntime>,
    pub permissions: Arc<PermissionTable>,
    pub snapshots: Arc<SessionSnapshots>,
    /// The config option that selects the model, from the adapter (§3.4: no component may guess
    /// an engine's option id, and the renderer is told rather than left to look for one).
    pub model_option_id: Option<String>,
    /// The engine's own HTTP surface for this incarnation, when its adapter verified one. Read
    /// from the instance rather than passed in: it is a property of the process this session is
    /// talking to, and a caller that supplied it could supply another engine's port.
    pub http: Option<EngineHttp>,
}

/// Takes a started instance apart into the state the commands address, and starts the one task
/// that reads it.
///
/// The instance is borrowed, not consumed: it stays the owner of the incarnation — the epoch
/// claim and the teardown — and lives in the runtime state for as long as this session does.
pub fn install<F>(
    instance: &mut AgentInstance,
    model_option_id: Option<String>,
    sink: F,
) -> Result<Session, String>
where
    F: Fn(AgentEventEnvelope) + Send + 'static,
{
    let events = instance.take_events().ok_or_else(|| {
        "this engine's event stream has already been taken; a second reader would see half of it"
            .to_string()
    })?;
    let identity = instance.identity().clone();
    let runtime = Arc::clone(instance.runtime());
    let permissions = PermissionTable::new(identity.clone(), &runtime);
    let snapshots = Arc::new(SessionSnapshots::new(identity.clone(), REPLAY_WINDOW));
    spawn(
        events,
        Arc::clone(&permissions),
        Arc::clone(&snapshots),
        sink,
    );
    Ok(Session {
        identity,
        runtime,
        permissions,
        snapshots,
        model_option_id,
        http: instance.http(),
    })
}

/// Reads `events` until the runtime behind it is gone.
///
/// `sink` is where a published envelope goes — the window's event channel, in the app. It is a
/// closure rather than a channel so this module needs no Tauri type and no second queue: the
/// driver is the only producer, and a queue between it and the window would only add a place for
/// frames to pile up unnoticed.
fn spawn<F>(
    mut events: AgentRuntimeEvents,
    permissions: Arc<PermissionTable>,
    snapshots: Arc<SessionSnapshots>,
    sink: F,
) -> tokio::task::JoinHandle<()>
where
    F: Fn(AgentEventEnvelope) + Send + 'static,
{
    tokio::spawn(async move {
        while let Some(next) = events.next().await {
            match next {
                RuntimeEvent::Event(envelope) => {
                    // Recorded before it is delivered: the snapshot is the *own* stream's
                    // projection, so a window that mounts in the instant after this call finds
                    // the frame here rather than in the gap it was told to avoid.
                    snapshots.record(&envelope);
                    sink(envelope);
                }
                RuntimeEvent::Permission(request) => {
                    // A request that cannot be shown is still answered — `adopt` refuses it to
                    // the engine, which is blocking on it. What is left to report is why, and
                    // stderr is the only channel this task has: it is a host-side inconsistency
                    // (the engine asked about a session this host never opened), not an event of
                    // the session the window is following.
                    if let Err(refusal) = permissions.adopt_known(request).await {
                        eprintln!("nekowite: could not show a permission request: {refusal:?}");
                    }
                }
            }
        }
    })
}
