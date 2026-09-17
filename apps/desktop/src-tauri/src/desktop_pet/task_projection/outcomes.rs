//! What an ACP fact means for a task: §6.2's table, as a total mapping.
//!
//! The counterpart of D1's `pet-contracts/events.ts`, and the same rule holds: the match is over
//! the kind enum, so a kind added to the runtime's vocabulary is an arm that has to be written
//! here rather than a payload that quietly reaches nothing. That is what lets the ACP owner widen
//! their contract without this one drifting from it in silence — the report of a kind's absence is
//! a compile error.
//!
//! The rows are also where §6.2's prohibitions live: no percentage is guessed from a lull, a
//! ceiling is not a success, a refusal is not a success, a cancellation is neither a success nor a
//! failure, and a lost runtime is never read as done.

use serde_json::Value;

use crate::agent_runtime::events::{AgentEventEnvelope, AgentEventKind};
use crate::agent_runtime::snapshot::{SessionSnapshot, SessionState};

use super::vocabulary::PetTaskState;

/// What one frame says about a task, before it is filed under one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Outcome {
    pub(super) state: PetTaskState,
    /// Set only by a permission request: any other fact about a run releases the prompt it was
    /// waiting on, because a run that has moved on is not waiting for an answer any more.
    pub(super) permission_request_id: Option<String>,
}

/// A string member of a payload, or `None` when it is absent or not a string.
fn payload_str<'a>(payload: &'a Value, field: &str) -> Option<&'a str> {
    payload.get(field).and_then(Value::as_str)
}

/// The state a stop reason means. §6.2's five rows, total over the reasons the contract names.
///
/// One spelling, and it is the contract's: `agent_runtime::runs` normalizes the engine's
/// `snake_case` `StopReason` into the `kebab-case` the contract's validator accepts before the
/// payload is published, so a reason that arrives here under some other spelling is a reason this
/// host does not know rather than a second way of writing one it does.
///
/// A reason this host does not know is `unknown`, never `turn-finished`: §6.2 forbids asserting a
/// normal ending for a turn whose ending is not known.
fn state_from_stop_reason(reason: Option<&str>) -> PetTaskState {
    match reason {
        Some("end-turn") => PetTaskState::TurnFinished,
        Some("max-tokens") | Some("max-turn-requests") => PetTaskState::Stopped,
        Some("refusal") => PetTaskState::Refused,
        Some("cancelled") => PetTaskState::Cancelled,
        _ => PetTaskState::Unknown,
    }
}

/// The state a failure code means. §6.2's rows, and the same two judgements D1 draws: a
/// cancellation is not a failure, and a runtime that is gone makes the task `interrupted` rather
/// than `failed` — there is no panel left to hold the failure's detail.
fn state_from_failure_code(code: Option<&str>) -> PetTaskState {
    match code {
        Some("cancelled") => PetTaskState::Cancelled,
        Some("process-exited") | Some("runtime-unavailable") => PetTaskState::Interrupted,
        // An unknown code is still a failure: this arm is the one D1's total table reaches with
        // every code that is neither a cancellation nor a lost runtime, and an unrecognized one
        // is no more a success than a recognized one is.
        _ => PetTaskState::Failed,
    }
}

/// What one frame means for a task, or `None` when it means nothing about one.
///
/// Most kinds mean nothing: a streamed chunk is not a start signal and a pause in one is not a
/// completion.
pub(super) fn outcome_of(envelope: &AgentEventEnvelope) -> Option<Outcome> {
    match envelope.kind {
        AgentEventKind::PermissionRequest => Some(Outcome {
            state: PetTaskState::WaitingInput,
            permission_request_id: payload_str(&envelope.payload, "requestId").map(str::to_string),
        }),
        AgentEventKind::RunFinished => Some(Outcome {
            state: state_from_stop_reason(payload_str(&envelope.payload, "stopReason")),
            permission_request_id: None,
        }),
        AgentEventKind::RunFailed => Some(Outcome {
            state: state_from_failure_code(payload_str(&envelope.payload, "code")),
            permission_request_id: None,
        }),
        AgentEventKind::TextDelta
        // The user's own half, replayed by a load: a message is content, and the rows that mean
        // something about a task are the ones below that say what the *engine* is doing about it.
        // The window's own projection has no pet fact for this kind either
        // (`pet-contracts/events.ts`, `'user-delta': noPetFact`), so this is the same judgement
        // on both sides of the boundary.
        | AgentEventKind::UserDelta
        // A thought chunk is the engine's reasoning about a turn, not a state of it: §6.2 has no
        // row for "the model is thinking", and one would be the percentage this table forbids.
        | AgentEventKind::ThoughtDelta
        | AgentEventKind::ToolUpdate
        | AgentEventKind::CommandsChanged
        // A session's option list says what the engine offers, not what a task is doing: the
        // model a turn ran with is not a state of the turn, and reading one as progress would
        // be the percentage §6.2 forbids this table from guessing.
        | AgentEventKind::ConfigChanged
        | AgentEventKind::FilesChanged => None,
    }
}

/// What a session snapshot means for a run.
///
/// D1's `petOutcomeFromSnapshot`: `running` is `working` with no percentage guessed from anything,
/// `waiting-permission` is `waiting-input`, and — the row that matters — **`completed` projects
/// nothing.** The snapshot cannot say *how* a run ended (ledger §7.7), so reading it as
/// `turn-finished` would assert a normal ending for a turn that may have hit a ceiling. `ready`
/// projects nothing either: §6.2 has no row for an engine with no turn going, and inventing one
/// would put an idle session on the pet's list of things it is doing.
///
/// The oldest unanswered request is the one the user has to deal with first, and snapshots never
/// evict unanswered requests, so the first is the whole set's head rather than a window onto it.
pub(super) fn outcome_of_snapshot(snapshot: &SessionSnapshot) -> Option<Outcome> {
    match snapshot.state {
        SessionState::Running => Some(Outcome {
            state: PetTaskState::Working,
            permission_request_id: None,
        }),
        SessionState::WaitingPermission => Some(Outcome {
            state: PetTaskState::WaitingInput,
            permission_request_id: snapshot
                .permissions
                .first()
                .and_then(|event| payload_str(&event.payload, "requestId"))
                .map(str::to_string),
        }),
        SessionState::Cancelled => Some(Outcome {
            state: PetTaskState::Cancelled,
            permission_request_id: None,
        }),
        SessionState::Failed => Some(Outcome {
            state: PetTaskState::Failed,
            permission_request_id: None,
        }),
        SessionState::Ready | SessionState::Completed => None,
    }
}

/// The state's name as D1 spells it, for a refusal's detail string.
///
/// Spelled out rather than derived from `Debug` so a rename in the enum cannot quietly change what
/// a log line says.
pub(super) fn state_name(state: PetTaskState) -> &'static str {
    match state {
        PetTaskState::Working => "working",
        PetTaskState::WaitingInput => "waiting-input",
        PetTaskState::TurnFinished => "turn-finished",
        PetTaskState::Stopped => "stopped",
        PetTaskState::Refused => "refused",
        PetTaskState::Cancelled => "cancelled",
        PetTaskState::Failed => "failed",
        PetTaskState::Interrupted => "interrupted",
        PetTaskState::Unknown => "unknown",
    }
}
