//! §6's projection: what the runtime is doing, reduced to what a pet window may be told.
//!
//! §6.1 makes the host the single source of truth for a task, and §9's tree puts this module at
//! the seam: the runtime's own envelopes go in, and `PetTaskProjection` — D1's frozen shape
//! (`pet-contracts/gateway.ts:36-43`) — comes out. Nothing here starts, cancels or re-sends
//! anything, for the reason that contract gives: a projection that could act would be a second
//! place where a run's life is decided.
//!
//! The module is divided by what changes a piece, the way D1's own contract is:
//!
//! - `./vocabulary` — what a task is and what one frame did with it. Moves when the *product*
//!   gains a state or a way of naming a task.
//! - `./outcomes` — §6.2's table, from an ACP fact to a pet state. Moves when the *runtime's
//!   vocabulary* gains a kind, and is where §6.2's prohibitions live.
//! - this file — the state machine: which incarnation may write, which tasks exist, and what one
//!   frame does to them. Moves when a rule about several tasks changes.
//!
//! Three failures of identity are what this module exists to make impossible. None of them is a
//! bug in a function; each is a design that looks reasonable until two engines are running.
//!
//! - **Two engines may report the same `sessionId`.** An engine chooses its own session ids and
//!   knows nothing about the others, so a map keyed by session id — or worse, a lookup by
//!   `endsWith(':session')`, which is what the upstream app does (`state.ts:54`, `:85-89`) —
//!   makes two engines' work one entry. Every key here is [`PetTaskKey`]: the five identity
//!   fields §6.1 requires plus the run, as a structured tuple that is `Hash`/`Eq` itself rather
//!   than a joined string anything could match a suffix of. A run's sequence number is filed
//!   under [`SessionKey`], which is why two engines sharing a session id cannot consume each
//!   other's frames.
//! - **An instance ends and its frames keep arriving.** `runtime_epoch` is minted per
//!   incarnation by `agent_runtime::registry` and is part of every envelope, so the projection
//!   does not need a counter of its own: it holds which epoch is *installed* for each
//!   (agent, profile, vault) and refuses a frame that names any other. This is the same shape as
//!   `state::WatcherState::generation` — a mark that makes trailing work from the previous
//!   installation recognizable instead of applicable — and it deliberately reuses the identity
//!   the registry already mints rather than adding a second answer to "which incarnation is
//!   live", for the reason `app_state.rs:171-178` gives.
//! - **Several runs are in flight at once.** §6.3 keeps every task on the list, so the store is
//!   a store of tasks and not "the current one": two runs of one session, two sessions of one
//!   engine and two engines are all separate entries, and nothing here collapses them.
//!
//! A fourth rule is a refusal to act rather than a structure: **silence is not information.**
//! Upstream deletes a working session that has been quiet for five minutes (`state.ts:36-38`,
//! `:126-133`), and §3.1.2 forbids both halves of that — silence may neither complete a task nor
//! remove one. There is no expiry anywhere in this module, and the clock is read only to stamp
//! `updated_at`.
//!
//! Wiring is deliberately not here. `lib.rs`, `commands/mod.rs` and `desktop_pet/mod.rs` are the
//! integrator's serialized files, so this tree is declared by path in
//! `tests/desktop_pet_task_projection_test.rs` until they land — the convention
//! `desktop_pet_ipc_test.rs` established. The exact wiring line is in this task's report.

mod outcomes;
mod vocabulary;

pub use vocabulary::{
    Disposition, FrameOrder, Ingest, PetTaskKey, PetTaskProjection, PetTaskState,
};

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use crate::agent_runtime::events::{AgentEventEnvelope, AgentIdentity};
use crate::agent_runtime::snapshot::SessionSnapshot;

use outcomes::{outcome_of, outcome_of_snapshot, state_name, Outcome};

/// The host's clock, in epoch milliseconds. Injected rather than read (§10.2), so a test can move
/// time without waiting for it — and so "no expiry" is testable rather than asserted.
pub type PetClock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The real clock, for a host that has no reason to control time.
pub fn system_clock() -> PetClock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0)
    })
}

/// One engine session: §6.1's identity without the run.
///
/// Private, and not a second public key. A sequence number belongs to a *session* (§6.3), so the
/// counters have to outlive a run boundary — and they have to be separated by the whole identity,
/// because two engines numbering their own frames from one would otherwise look like one stream.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(super) struct SessionKey {
    agent_id: String,
    profile_id: String,
    runtime_epoch: String,
    vault_id: String,
    session_id: String,
}

/// The facts that name one runtime *instance*: §6.1's identity without its epoch.
///
/// The same triple `registry::LiveInstances` keys its table by, and for its reason: a different
/// profile or vault is a different process, so an epoch is only the successor of another one
/// within a triple (`registry.rs:399-440`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(super) struct Incarnation {
    agent_id: String,
    profile_id: String,
    vault_id: String,
}

impl Incarnation {
    fn of(identity: &AgentIdentity) -> Self {
        Self {
            agent_id: identity.agent_id.clone(),
            profile_id: identity.profile_id.clone(),
            vault_id: identity.vault_id.clone(),
        }
    }

    /// Whether this stream belongs to the instance `self` and `epoch` identify together.
    fn names(&self, session: &SessionKey, epoch: &str) -> bool {
        session.agent_id == self.agent_id
            && session.profile_id == self.profile_id
            && session.vault_id == self.vault_id
            && session.runtime_epoch == epoch
    }
}

/// The sequence space of one session, as this host has seen it.
#[derive(Debug, Default)]
struct SequenceLog {
    accepted: BTreeSet<u64>,
    /// The highest number reached without a hole. A gap is reported rather than repaired: §6.3
    /// requires the ledger to notice one, and a projection that silently stitched two
    /// non-adjacent parts of a stream would leave it nothing to notice.
    contiguous: u64,
}

impl SequenceLog {
    fn has(&self, sequence: u64) -> bool {
        self.accepted.contains(&sequence)
    }

    fn accept(&mut self, sequence: u64) {
        self.accepted.insert(sequence);
        while self.accepted.contains(&(self.contiguous + 1)) {
            self.contiguous += 1;
        }
    }

    fn order(&self, sequence: u64) -> FrameOrder {
        let mut missing = Vec::new();
        if !self.accepted.contains(&sequence) {
            for number in (self.contiguous + 1)..sequence {
                if !self.accepted.contains(&number) {
                    missing.push(number);
                }
            }
        }
        FrameOrder { sequence, missing }
    }
}

/// The host's trusted tasks, as the pet may see them.
///
/// §6.1's single source of truth, held once: a window reads this and never learns anything about
/// a run from anywhere else. It is not `Sync`-by-construction on purpose — a caller that wants to
/// share it takes a lock, so there is exactly one place where a frame is applied.
pub struct TaskProjection {
    now: PetClock,
    /// Which epoch is installed for each triple. Bounded by the engines this host started.
    incarnations: BTreeMap<Incarnation, String>,
    /// Every task, by its whole key. A `BTreeMap` so `tasks()` is stable across calls — the order
    /// is *stable*, not *meaningful*: §6.3's ranking is a display rule and lives in
    /// `pet-bubble-layout.ts`, so nothing here should be read as a priority.
    tasks: BTreeMap<PetTaskKey, PetTaskProjection>,
    sequences: HashMap<SessionKey, SequenceLog>,
}

impl TaskProjection {
    pub fn new(now: PetClock) -> Self {
        Self {
            now,
            incarnations: BTreeMap::new(),
            tasks: BTreeMap::new(),
            sequences: HashMap::new(),
        }
    }

    /// The host started an instance, and this is its identity.
    ///
    /// Installing a *different* epoch for a triple is proof the previous one is over rather than a
    /// guess: `registry::LiveInstances::claim` refuses a second live instance for one
    /// (agent, profile, vault), so a new epoch in that slot can only follow a release. Its
    /// in-flight runs were therefore cut off by a runtime that went away, which §6.2 maps to
    /// `interrupted` and never to a completion. A new epoch for a *different* vault is a different
    /// process and abandons nothing.
    ///
    /// Returns the tasks it had to restate, so a caller that wants to remind about them can, and
    /// an empty vector when there was nothing in flight.
    pub fn install(&mut self, identity: &AgentIdentity) -> Vec<PetTaskProjection> {
        let triple = Incarnation::of(identity);
        let previous = self
            .incarnations
            .insert(triple.clone(), identity.runtime_epoch.clone());
        match previous {
            Some(epoch) if epoch != identity.runtime_epoch => self.abandon(&triple, &epoch),
            _ => Vec::new(),
        }
    }

    /// The host's instance is over: it stopped, it exited, or it was dropped.
    ///
    /// Kept apart from [`TaskProjection::install`] because those are two different moments and
    /// only one of them has a successor. Frames for the retired epoch are refused from here on.
    pub fn retire(&mut self, identity: &AgentIdentity) -> Vec<PetTaskProjection> {
        let triple = Incarnation::of(identity);
        if self.incarnations.get(&triple) != Some(&identity.runtime_epoch) {
            return Vec::new();
        }
        self.incarnations.remove(&triple);
        self.abandon(&triple, &identity.runtime_epoch)
    }

    /// Which epoch is installed for a triple, if any. What a caller compares a frame against
    /// rather than keeping an epoch of its own.
    pub fn installed(&self, agent_id: &str, profile_id: &str, vault_id: &str) -> Option<&str> {
        self.incarnations
            .get(&Incarnation {
                agent_id: agent_id.to_string(),
                profile_id: profile_id.to_string(),
                vault_id: vault_id.to_string(),
            })
            .map(String::as_str)
    }

    /// A run began on a session.
    ///
    /// §6.1 is why this is an entry point and not an event: no ACP frame says "a run started", so
    /// the host's own view of the session is where it comes from — the command that issued the
    /// prompt. Nothing here guesses it from text.
    pub fn started(&mut self, identity: &AgentIdentity, session_id: &str, run_id: &str) -> Ingest {
        let key = key_of(identity, session_id, run_id);
        self.fact(
            identity,
            key,
            FrameOrder::off_stream(),
            Outcome {
                state: PetTaskState::Working,
                permission_request_id: None,
            },
        )
    }

    /// The user answered a permission on `request_id`, so the run is no longer waiting on it.
    ///
    /// §6.1 again: a permission's *release* is not an event either. It is deliberately not a
    /// general "clear whatever is pending": the id has to match, or an answer to a request the
    /// prompt list has since replaced would clear a wait on a different one.
    pub fn answered(
        &mut self,
        identity: &AgentIdentity,
        session_id: &str,
        run_id: &str,
        request_id: &str,
    ) -> Option<Ingest> {
        let key = key_of(identity, session_id, run_id);
        let held = self.tasks.get(&key)?;
        if held.permission_request_id.as_deref() != Some(request_id) {
            return None;
        }
        Some(self.fact(
            identity,
            key,
            FrameOrder::off_stream(),
            Outcome {
                state: PetTaskState::Working,
                permission_request_id: None,
            },
        ))
    }

    /// One of the host's session snapshots.
    ///
    /// The identity check first — a snapshot's identity is a claim by one incarnation just as an
    /// envelope's is — then `./outcomes` decides what the state means, and `None` there is a
    /// refusal to project rather than a failure: a snapshot of a session with no run, or one that
    /// says a turn ended without saying how, is a fact about which this module has nothing to say.
    pub fn observe(&mut self, snapshot: &SessionSnapshot) -> Ingest {
        let identity = AgentIdentity {
            agent_id: snapshot.identity.agent_id.clone(),
            profile_id: snapshot.identity.profile_id.clone(),
            runtime_epoch: snapshot.identity.runtime_epoch.clone(),
            vault_id: snapshot.identity.vault_id.clone(),
        };
        let order = FrameOrder {
            sequence: snapshot.sequence,
            missing: Vec::new(),
        };
        if self.installed(&identity.agent_id, &identity.profile_id, &identity.vault_id)
            != Some(identity.runtime_epoch.as_str())
        {
            return Ingest::new(Disposition::Foreign, None, order)
                .saying("the snapshot is from an instance this host is not serving");
        }
        let Some(run_id) = snapshot.run_id.clone() else {
            return Ingest::new(Disposition::Foreign, None, order)
                .saying("the snapshot names no run, so it is about no task");
        };
        let key = key_of(&identity, &snapshot.identity.session_id, &run_id);
        match outcome_of_snapshot(snapshot) {
            Some(outcome) => self.fact(&identity, key, order, outcome),
            None => Ingest::new(Disposition::NoChange, Some(key), order).saying(
                "the snapshot carries no run, or does not say how the run it carries ended",
            ),
        }
    }

    /// Every task the pet shows. A complete list every time, which is why a window needs no
    /// replay machinery to subscribe.
    pub fn tasks(&self) -> Vec<PetTaskProjection> {
        self.tasks.values().cloned().collect()
    }

    /// One task by its whole key.
    ///
    /// There is deliberately no lookup by session id, and none by run id: §6.1's whole point is
    /// that neither of those names a task on its own, and a convenience method that took one would
    /// be the way the wrong engine's task gets clicked.
    pub fn task(&self, key: &PetTaskKey) -> Option<&PetTaskProjection> {
        self.tasks.get(key)
    }

    /// One frame off the runtime's stream.
    pub fn apply(&mut self, envelope: &AgentEventEnvelope) -> Ingest {
        let session = SessionKey {
            agent_id: envelope.agent_id.clone(),
            profile_id: envelope.profile_id.clone(),
            runtime_epoch: envelope.runtime_epoch.clone(),
            vault_id: envelope.vault_id.clone(),
            session_id: envelope.session_id.clone(),
        };
        let order = match self.sequences.get(&session) {
            Some(log) => log.order(envelope.sequence),
            None => FrameOrder {
                sequence: envelope.sequence,
                missing: Vec::new(),
            },
        };

        // The incarnation check comes first, and before the sequence is remembered: a frame from
        // an instance this host is not serving is not part of any stream it is holding, and
        // counting its sequence would put a hole in a stream it has nothing to do with.
        let installed = self.installed(
            &envelope.agent_id,
            &envelope.profile_id,
            &envelope.vault_id,
        );
        if installed != Some(envelope.runtime_epoch.as_str()) {
            return Ingest::new(Disposition::Foreign, None, order).saying(match installed {
                Some(epoch) => format!(
                    "carried runtime instance {}, and this host serves {}",
                    envelope.runtime_epoch, epoch
                ),
                None => format!(
                    "carried runtime instance {}, which this host never started",
                    envelope.runtime_epoch
                ),
            });
        }

        let Some(run_id) = envelope.run_id.clone() else {
            return Ingest::new(Disposition::Foreign, None, order)
                .saying("belongs to no run, so there is no task to change");
        };
        let identity = AgentIdentity {
            agent_id: envelope.agent_id.clone(),
            profile_id: envelope.profile_id.clone(),
            runtime_epoch: envelope.runtime_epoch.clone(),
            vault_id: envelope.vault_id.clone(),
        };
        let key = key_of(&identity, &envelope.session_id, &run_id);

        if self
            .sequences
            .get(&session)
            .is_some_and(|log| log.has(envelope.sequence))
        {
            return Ingest::new(Disposition::Replayed, Some(key), order)
                .saying("this sequence was already accepted");
        }
        self.sequences
            .entry(session)
            .or_default()
            .accept(envelope.sequence);

        let Some(outcome) = outcome_of(envelope) else {
            return Ingest::new(Disposition::NoChange, Some(key), order)
                .saying("this kind says nothing about a task's state");
        };
        self.fact(&identity, key, order, outcome)
    }

    /// File one outcome under its key, once the frame it came from has been accepted.
    ///
    /// The one place a task is written, so §6.3's rule — a terminal state is not revived by a
    /// later work event — is one check rather than one per entry point.
    fn fact(
        &mut self,
        identity: &AgentIdentity,
        key: PetTaskKey,
        order: FrameOrder,
        outcome: Outcome,
    ) -> Ingest {
        if self.installed(&key.agent_id, &key.profile_id, &key.vault_id)
            != Some(identity.runtime_epoch.as_str())
        {
            return Ingest::new(Disposition::Foreign, Some(key), order)
                .saying("its runtime instance is not the one this host serves");
        }
        if let Some(existing) = self.tasks.get(&key) {
            if existing.state.is_settled() {
                // §6.3: the run ended, and its ending is the record. A later turn of the same
                // conversation is a new run — a different key — and never a reason to reopen this
                // one, which is also what makes a reused run id a refusal rather than a revival.
                return Ingest::new(Disposition::Settled, Some(key), order).saying(format!(
                    "{} is already how this run ended",
                    state_name(existing.state)
                ));
            }
        }
        let task = PetTaskProjection {
            key: key.clone(),
            state: outcome.state,
            permission_request_id: outcome.permission_request_id,
            updated_at: (self.now)(),
        };
        self.tasks.insert(key, task.clone());
        Ingest::new(Disposition::Applied, Some(task.key.clone()), order).holding(&task)
    }

    /// Everything one incarnation had in flight, restated as `interrupted`.
    ///
    /// §6.2's last row, and the *narrow* reading of it: a task that already ended keeps its
    /// ending, because the runtime went away after those runs were over and the loss says nothing
    /// about them. A task still in flight was cut off by a runtime that is gone, which is
    /// knowledge rather than absent knowledge — `connection-lost`'s `unknown` belongs to a window
    /// that cannot reach the host, not to a host that watched its own process exit.
    ///
    /// The whole identity is compared, not the epoch alone. The registry's epochs are unique among
    /// the instances it holds (`registry.rs:440-445`, one counter per registry), so the two are
    /// the same set today — but leaning on that would make this function restate *another vault's*
    /// work the moment a caller handed it two identities whose epochs agreed, and it would do it
    /// silently: a running task turned into `interrupted` for a runtime that is still running.
    /// That is not hypothetical — it is what this function did before the case that covers it
    /// existed, with two vaults both on `epoch-1`.
    fn abandon(&mut self, incarnation: &Incarnation, epoch: &str) -> Vec<PetTaskProjection> {
        self.sequences
            .retain(|session, _| !incarnation.names(session, epoch));
        // Collected first because the loop writes into the same map it reads: a set of keys is
        // what lets the borrow end before the mutation starts.
        let keys: Vec<PetTaskKey> = self
            .tasks
            .values()
            .filter(|task| task.key.is_of(incarnation, epoch) && !task.state.is_settled())
            .map(|task| task.key.clone())
            .collect();
        let mut restated = Vec::with_capacity(keys.len());
        for key in keys {
            let task = self.tasks.get_mut(&key).expect("the key came from this map");
            task.state = PetTaskState::Interrupted;
            task.permission_request_id = None;
            task.updated_at = (self.now)();
            restated.push(task.clone());
        }
        restated
    }
}

/// The six fields of a key, in one place: an identity, a session and a run.
fn key_of(identity: &AgentIdentity, session_id: &str, run_id: &str) -> PetTaskKey {
    PetTaskKey {
        agent_id: identity.agent_id.clone(),
        profile_id: identity.profile_id.clone(),
        runtime_epoch: identity.runtime_epoch.clone(),
        vault_id: identity.vault_id.clone(),
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
    }
}
