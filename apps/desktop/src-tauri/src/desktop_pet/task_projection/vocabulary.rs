//! What a task is, and what the host did with one frame about it.
//!
//! One of the parts `../task_projection` divides into, along the line §9 draws for this contract.
//! The seam is who changes the module: this one moves when the *product* gains a state or a way of
//! naming a task, `./outcomes` moves when the *ACP vocabulary* gains a kind, and `../task_projection`
//! moves when a rule about several tasks changes. "What can the pet show?" and "what does this
//! frame mean?" are different questions, and after the split they are different files.
//!
//! Every type here is D1's frozen shape (`pet-contracts/task.ts`, `pet-contracts/gateway.ts`),
//! field for field and spelling for spelling: the frontend reads these through serde, and a name
//! that drifted would be a field that silently reads as absent. The one exception is
//! [`SessionKey`], which the contract names as a key — `petKeyToken`'s own doc says the identity's
//! session part, without the run, is a key in its own right — but has no interface for. It is
//! defined here, next to the task key it is a projection of, because two modules key a stream by it
//! and a second definition of it would be the same defect as a second [`PetTaskKey`].

use serde::{Deserialize, Serialize};

use super::Incarnation;

/// One run, named by every fact that tells it apart from another.
///
/// D1's `PetTaskKey` field for field, and a tuple in Rust's sense rather than a string: `Hash` and
/// `Eq` on the whole value is what lets it be a map key directly, so there is no encoding step for
/// a suffix match to get wrong later. `session_id` is a field *in* the key and never the key.
///
/// `Deserialize` as well as `Serialize`, because the ledger persists this key inside its rows
/// (`../history.rs`): a record of tasks is read back with the same spelling it was written with,
/// and one definition of the key is what keeps "the same spelling" from being two agreements.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetTaskKey {
    pub agent_id: String,
    pub profile_id: String,
    pub runtime_epoch: String,
    pub vault_id: String,
    pub session_id: String,
    /// Non-null: a task *is* a run, while `None` on an envelope means no turn owns the event.
    pub run_id: String,
}

impl PetTaskKey {
    /// Whether this key names a run of the instance `incarnation` and `epoch` identify together.
    ///
    /// The whole identity and not the epoch alone: see `../TaskProjection::abandon` for the silent
    /// failure that narrower comparison produced.
    pub(super) fn is_of(&self, incarnation: &Incarnation, epoch: &str) -> bool {
        self.agent_id == incarnation.agent_id
            && self.profile_id == incarnation.profile_id
            && self.vault_id == incarnation.vault_id
            && self.runtime_epoch == epoch
    }
}

/// The part of a task's identity that its event stream belongs to: the five ACP fields, no run.
///
/// [`PetTaskKey`] with the run left out, and a key in its own right rather than a convenience: the
/// sequence space belongs to a *session* (§6.3), so the counters that make a replay recognizable
/// have to outlive a run boundary — a second run of one session is a new task and the same stream.
/// `runtime_epoch` is in the five for the reason `agent_runtime/snapshot.rs` gives about its own
/// counter: a restarted runtime starts a new stream, so a number from the previous incarnation
/// must not be compared against it. Two agents sharing a session id are likewise two sessions,
/// which is what keeps each one's frames out of the other's stream.
///
/// Defined once, here, because both readers key by it — the ledger files its stream marks under it
/// (`../history.rs`) and the projection files its sequence log under it — and it used to be two
/// types of this name, one in each file, field for field and spelling for spelling. That is the
/// hazard [`PetTaskKey`]'s own doc names, in the place where it costs most: a mark filed under the
/// wrong session is a replay read as news, or a frame read as a gap.
///
/// `Serialize` as well as `Deserialize`, because the ledger persists this key inside its rows: a
/// mark is read back with the same spelling it was written with, and one definition of the key is
/// what keeps "the same spelling" from being two agreements.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionKey {
    pub agent_id: String,
    pub profile_id: String,
    pub runtime_epoch: String,
    pub vault_id: String,
    pub session_id: String,
}

/// One state from `PET_TASK_STATES`, kebab-case on the wire so the two are one list rather than two
/// (`pet-contracts/task.ts:69-82`).
///
/// The names are serde's `kebab-case` rename and not a method that returns them: a second spelling
/// is the one that drifts. `Deserialize` as well as `Serialize` because the ledger writes this state
/// into a row and reads it back on the next start (`../history.rs`), and that file is also where
/// `PET_TASK_STATES` — the array of names the ledger's tests pin against the contract — lives: it
/// has no reader in this module, and a copy here would be a second list to keep in step rather than
/// one list in one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetTaskState {
    /// A turn is in flight. Never recorded: it is not an ending, and it is what D4's projection
    /// shows.
    Working,
    /// The engine is waiting on the user to allow or refuse something.
    WaitingInput,
    /// The turn ended normally. Nothing beyond "this turn finished" may be claimed (§6.2).
    TurnFinished,
    /// A limit ended it (`max-tokens`, `max-turn-requests`): reached, not achieved.
    Stopped,
    /// The engine declined to continue. Not a failure and not a success.
    Refused,
    /// Cancelled — by the user, or on their behalf. Neither a success nor a failure (§6.2).
    Cancelled,
    /// The run failed and its detail is in the main panel.
    Failed,
    /// The runtime went away mid-run. Never read as done, and never re-sent.
    Interrupted,
    /// The host cannot be reached, so it cannot say what the task is doing.
    Unknown,
}

impl PetTaskState {
    /// Whether this records how a run ended rather than a belief about one still going.
    ///
    /// D1's `isPetTaskSettled` (`pet-contracts/task.ts:132-141`), which is what §6.3's "a terminal
    /// state is not revived by an older work event" needs. `Unknown` is deliberately not settled:
    /// it admits the host does not know, so a later frame that *does* know has to be able to
    /// replace it.
    pub fn is_settled(self) -> bool {
        matches!(
            self,
            Self::TurnFinished
                | Self::Stopped
                | Self::Refused
                | Self::Cancelled
                | Self::Failed
                | Self::Interrupted
        )
    }
}

/// One task, as the host hands it to a window.
///
/// D1's `PetTaskProjection` field for field. `permission_request_id` is an id to route with and
/// never something to answer with — the contract's own note — so there is nothing here a caller
/// could authorise by accident.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetTaskProjection {
    pub key: PetTaskKey,
    pub state: PetTaskState,
    pub permission_request_id: Option<String>,
    pub updated_at: u64,
}

/// How one frame sat in the stream the host receives.
///
/// Reported rather than acted on, exactly as D1's `PetFrameOrder` is: §6.3's ledger is what
/// decides that a replay must not notify twice or that a gap means restoring from a snapshot, and
/// it can only decide those badly if this layer has already thrown the evidence away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameOrder {
    pub sequence: u64,
    /// The sequence numbers that never arrived, between the last uninterrupted run this host had
    /// and this frame. Non-empty means what the host holds was built on a stream with a hole in it.
    pub missing: Vec<u64>,
}

impl FrameOrder {
    /// For a fact that came off no stream at all — a run's start, an answered permission, either
    /// of which the host reports from its own view rather than from a frame (§6.1). Zero is the
    /// sequence no runtime ever assigns, so a ledger that counts these separately can tell one
    /// from a frame.
    pub(super) fn off_stream() -> Self {
        Self {
            sequence: 0,
            missing: Vec::new(),
        }
    }
}

/// What the projection did with one frame. D1's `PetIngestOutcome` statuses, as an enum because
/// the arms carry different data (`memory-pet/scenario.ts:95-107`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Disposition {
    /// A pet fact, filed under the task the frame named.
    Applied,
    /// Received, but this kind says nothing about a task's state.
    NoChange,
    /// This sequence was already accepted, so it was not applied a second time.
    Replayed,
    /// From an instance this host is not serving, or about no run at all.
    Foreign,
    /// A pet fact for a run that already ended: §6.2's terminal states are not revived.
    Settled,
}

/// What one frame did, and everything the ledger needs to decide the rest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ingest {
    pub disposition: Disposition,
    /// `None` only for a frame that names no run.
    pub key: Option<PetTaskKey>,
    pub order: FrameOrder,
    /// The task as it now stands, when the frame left one.
    pub task: Option<PetTaskProjection>,
    /// Why the frame was refused, for a log or a test. Never a user-facing sentence.
    pub detail: Option<String>,
}

// The three constructors are `pub(super)` because the state machine that produces an `Ingest`
// lives in the module *above* this one, and Rust's privacy runs the other way: an item private to
// a module is visible in it and in its descendants, not in its parent.
impl Ingest {
    pub(super) fn new(
        disposition: Disposition,
        key: Option<PetTaskKey>,
        order: FrameOrder,
    ) -> Self {
        Self {
            disposition,
            key,
            order,
            task: None,
            detail: None,
        }
    }

    pub(super) fn saying(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub(super) fn holding(mut self, task: &PetTaskProjection) -> Self {
        self.task = Some(task.clone());
        self
    }
}
