//! The fixtures every case below builds its frames from.
//!
//! Two things are worth stating about what is *not* here. There is no fake engine, because the
//! projection never touches one: its whole input is the host's own envelope, so a case constructs
//! exactly the frame it is about — including the frames a well-behaved engine would never send,
//! which is the point of several of them. And there is no helper that builds a task's key from a
//! session id, because a helper that could would be the very shortcut §6.1 forbids: every key in
//! these tests names all six fields, including the ones a test does not care about, so that a test
//! cannot accidentally agree with a bug that ignores them.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::desktop_pet::task_projection::{PetClock, PetTaskKey, PetTaskState, TaskProjection};
use nekowite_lib::agent_runtime::events::{AgentEventEnvelope, AgentEventKind, AgentIdentity};
use nekowite_lib::agent_runtime::snapshot::{SessionSnapshot, SessionState, SnapshotIdentity};

/// The agent, profile and vault the default identity names. A second agent is a second identity,
/// not a second field of this one: `other` below is what produces the collisions the cases are
/// about.
pub const AGENT: &str = "opencode";
pub const PROFILE: &str = "default";
pub const VAULT: &str = "vault-a";

/// One instance of one engine, as `registry::AgentRegistry::start` hands it out.
pub fn identity(agent: &str, vault: &str, epoch: &str) -> AgentIdentity {
    AgentIdentity {
        agent_id: agent.to_string(),
        profile_id: PROFILE.to_string(),
        runtime_epoch: epoch.to_string(),
        vault_id: vault.to_string(),
    }
}

/// The ordinary case: the app's own engine, in the default vault, on its first instance.
pub fn first_instance() -> AgentIdentity {
    identity(AGENT, VAULT, "epoch-1")
}

/// A second engine — different id, same profile and vault, which is what §3.4 allows and what
/// makes "two agents" a boundary rather than a word in the plan.
pub fn other_instance() -> AgentIdentity {
    identity("other-engine", VAULT, "epoch-1")
}

/// A clock a test moves by hand, so "nothing expires" can be tested instead of waited for.
pub fn clock() -> (PetClock, Arc<AtomicU64>) {
    let now = Arc::new(AtomicU64::new(1_000));
    let handle = Arc::clone(&now);
    (Arc::new(move || handle.load(Ordering::SeqCst)), now)
}

pub fn projection() -> TaskProjection {
    let (now, _) = clock();
    TaskProjection::new(now)
}

/// A projection and the clock its `updated_at` stamps come from.
pub fn projection_with_clock() -> (TaskProjection, Arc<AtomicU64>) {
    let (now, handle) = clock();
    (TaskProjection::new(now), handle)
}

/// One envelope, with every field a case might need to make wrong.
///
/// Written out field by field rather than with a `..default()` so that adding a field to the
/// envelope is a compile error here — an event this host learns to carry should be one a test
/// notices, not one it silently leaves empty.
pub fn envelope(
    identity: &AgentIdentity,
    session_id: &str,
    run_id: Option<&str>,
    sequence: u64,
    kind: AgentEventKind,
    payload: Value,
) -> AgentEventEnvelope {
    AgentEventEnvelope {
        agent_id: identity.agent_id.clone(),
        profile_id: identity.profile_id.clone(),
        runtime_epoch: identity.runtime_epoch.clone(),
        vault_id: identity.vault_id.clone(),
        session_id: session_id.to_string(),
        run_id: run_id.map(str::to_string),
        sequence,
        kind,
        payload,
    }
}

/// A frame that says the run ended, with the stop reason the contract spells.
pub fn finished(
    identity: &AgentIdentity,
    session_id: &str,
    run_id: &str,
    sequence: u64,
    stop_reason: &str,
) -> AgentEventEnvelope {
    envelope(
        identity,
        session_id,
        Some(run_id),
        sequence,
        AgentEventKind::RunFinished,
        json!({ "stopReason": stop_reason, "usage": null }),
    )
}

/// A frame the host publishes for a lot of kinds and that means nothing about a task's state.
pub fn chatter(
    identity: &AgentIdentity,
    session_id: &str,
    run_id: &str,
    sequence: u64,
) -> AgentEventEnvelope {
    envelope(
        identity,
        session_id,
        Some(run_id),
        sequence,
        AgentEventKind::TextDelta,
        json!({ "text": "still going" }),
    )
}

/// A permission request, in the shape `permissions::PermissionPrompt` serializes to.
pub fn permission(
    identity: &AgentIdentity,
    session_id: &str,
    run_id: &str,
    sequence: u64,
    request_id: &str,
) -> AgentEventEnvelope {
    envelope(
        identity,
        session_id,
        Some(run_id),
        sequence,
        AgentEventKind::PermissionRequest,
        json!({
            "requestId": request_id,
            "toolCallId": "tool-1",
            "title": "A tool wants to run",
            "input": { "state": "absent" },
            "options": [{ "optionId": "once", "name": "Allow once", "kind": "allow_once" }],
        }),
    )
}

/// The key a case expects to find, named field by field for `support.rs`'s stated reason.
pub fn key(identity: &AgentIdentity, session_id: &str, run_id: &str) -> PetTaskKey {
    PetTaskKey {
        agent_id: identity.agent_id.clone(),
        profile_id: identity.profile_id.clone(),
        runtime_epoch: identity.runtime_epoch.clone(),
        vault_id: identity.vault_id.clone(),
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
    }
}

/// How many tasks the projection is holding — the count §6.3's 「持续显示每个任务」 is about.
pub fn task_count(projection: &TaskProjection) -> usize {
    projection.tasks().len()
}

/// The state one task is in, or a panic naming the key so a missing task reads as itself rather
/// than as an index error.
pub fn state_of(projection: &TaskProjection, key: &PetTaskKey) -> &'static str {
    projection
        .task(key)
        .map(|task| state_name(task.state))
        .unwrap_or_else(|| panic!("no task under {}", key.session_id))
}

/// A session snapshot, in the shape `snapshot::SessionSnapshots` hands a mounting window.
pub fn snapshot(
    identity: &AgentIdentity,
    session_id: &str,
    run_id: Option<&str>,
    sequence: u64,
    state: SessionState,
    pending: &[AgentEventEnvelope],
) -> SessionSnapshot {
    SessionSnapshot {
        identity: SnapshotIdentity {
            agent_id: identity.agent_id.clone(),
            profile_id: identity.profile_id.clone(),
            runtime_epoch: identity.runtime_epoch.clone(),
            vault_id: identity.vault_id.clone(),
            session_id: session_id.to_string(),
        },
        state,
        run_id: run_id.map(str::to_string),
        sequence,
        events: Vec::new(),
        permissions: pending.to_vec(),
    }
}

/// The state's name as D1 spells it. Spelled out here rather than derived from `Debug`, so a
/// rename in the enum is a failing test rather than a passing one with a new string in it.
pub fn state_name(state: PetTaskState) -> &'static str {
    use PetTaskState::*;
    match state {
        Working => "working",
        WaitingInput => "waiting-input",
        TurnFinished => "turn-finished",
        Stopped => "stopped",
        Refused => "refused",
        Cancelled => "cancelled",
        Failed => "failed",
        Interrupted => "interrupted",
        Unknown => "unknown",
    }
}
