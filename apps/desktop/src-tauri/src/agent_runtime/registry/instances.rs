//! The live-instance bookkeeping: which (agent, profile, vault) runtimes this host has started and
//! not yet seen end, and the handle that owns one incarnation.
//!
//! A module of its own rather than a section of [`super`], and the split is by what makes each part
//! change. This file moves when *teardown* moves — the epoch table's deduplication rule (§3.4: two
//! engines on one profile are two writers into one config and one session store), the claim taken
//! before a process exists, and the two steps §6.2 requires of an instance this host lets go of. A
//! definition ([`super::registration`]) never sees a process and this file never sees one: the
//! registry ([`super::table`]) is the only thing that holds both, which is why neither of the two
//! has to learn about the other.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use super::super::adapters::{AgentAdapter, Capability, HostFeature};
use super::super::events::AgentIdentity;
use super::super::permission_grants::EngineHttp;
use super::super::session::{AgentRuntime, AgentRuntimeEvents};
use super::error::RegistryError;

/// The runtimes this registry has started and not yet seen end: (agent, profile, vault) -> the
/// epoch of the instance holding it. Shared with the instances themselves ([`AgentInstance`]),
/// because "am I still the live incarnation" is a question only this table can answer.
pub(super) struct LiveInstances {
    counter: u64,
    /// Read directly by [`super::table`]'s `running_agent_ids`, which needs the keys of the table
    /// rather than one epoch out of it — the same view one level down instead of another accessor.
    pub(super) live: BTreeMap<(String, String, String), String>,
}

impl LiveInstances {
    pub(super) fn new() -> Self {
        Self {
            counter: 0,
            live: BTreeMap::new(),
        }
    }

    /// Mints an epoch for one (agent, profile, vault), or refuses.
    ///
    /// The triple is the unit of deduplication: §3.4 rules out one global engine standing in for
    /// every agent, and two engines on one profile would be two writers into one config and one
    /// session store. A different profile or vault is a different instance and is allowed — which
    /// is what makes "multiple agents" a boundary rather than a word in the plan.
    pub(super) fn claim(
        &mut self,
        agent_id: &str,
        profile_id: &str,
        vault_id: &str,
    ) -> Result<String, RegistryError> {
        let key = (
            agent_id.to_string(),
            profile_id.to_string(),
            vault_id.to_string(),
        );
        // Claimed before the process exists, so two concurrent starts of the same runtime cannot
        // both spawn and only then discover each other.
        if let Some(epoch) = self.live.get(&key) {
            return Err(RegistryError::AlreadyRunning {
                agent_id: agent_id.to_string(),
                epoch: epoch.clone(),
            });
        }
        self.counter += 1;
        // The process id is what makes an epoch unique across *runs*: §6.1's composite identity
        // exists so a frame from a previous incarnation is recognizable as stale, and a name
        // restarting at one would hand the new process the names the old one's persisted
        // envelopes carry.
        let epoch = format!("epoch-{}-{}", std::process::id(), self.counter);
        self.live.insert(key, epoch.clone());
        Ok(epoch)
    }

    pub(super) fn release(&mut self, epoch: &str) {
        self.live.retain(|_, held| held != epoch);
    }

    fn is_live(&self, epoch: &str) -> bool {
        self.live.values().any(|held| held == epoch)
    }

    /// The epoch of the instance running for `agent_id`, if there is one.
    pub(super) fn epoch_of(&self, agent_id: &str) -> Option<String> {
        self.live
            .iter()
            .find(|((agent, _, _), _)| agent == agent_id)
            .map(|(_, epoch)| epoch.clone())
    }
}

/// One running engine, as this host knows it. Dropping one tears its engine down — the epoch is
/// released *and* the engine is asked to exit — so an instance the Rust side no longer holds is
/// exactly the case where nobody else could stop it, and §6.2's rule is that this host cleans up
/// the processes it started, and only those.
///
/// The runtime inside is shared with the IPC layer, so the engine has two owners while a session
/// is live. That is why the teardown hangs off this type's [`Drop`] as well as off `shutdown`:
/// dropping the instance cannot rely on the last `Arc` going with it.
///
/// The fields are `pub(super)` rather than private because one caller outside this file builds the
/// value: [`super::table`]'s `start` assembles the instance it has just launched. The struct and
/// that constructor sat in one module before the split, and a constructor moved in here would have
/// been a rewrite rather than the move this split is; `pub(super)` is the narrowest visibility that
/// keeps the construction where §6.2's sequence already reads it.
pub struct AgentInstance {
    pub(super) identity: AgentIdentity,
    pub(super) adapter: &'static dyn AgentAdapter,
    /// The engine's own HTTP surface for *this* launch, when its adapter has one. It is a fact
    /// about the incarnation rather than about the registration — the port belongs to the process
    /// this instance started — and it is read through [`Session`](super::super::driver::Session) by the
    /// one command that needs it.
    pub(super) http: Option<EngineHttp>,
    pub(super) runtime: Arc<AgentRuntime>,
    /// The reading half, until the driver takes it. `None` afterwards — see
    /// [`AgentInstance::take_events`].
    pub(super) events: Option<AgentRuntimeEvents>,
    pub(super) live: Arc<Mutex<LiveInstances>>,
}

impl AgentInstance {
    /// The composite identity (§6.1) every envelope from this instance carries.
    pub fn identity(&self) -> &AgentIdentity {
        &self.identity
    }

    /// The asking half: every call that issues a request takes `&self`, so this is all a command
    /// needs, and it is a share rather than a borrow because the command runs on another task.
    pub fn runtime(&self) -> &Arc<AgentRuntime> {
        &self.runtime
    }

    /// The engine's own HTTP surface for this launch, when its adapter has one. `None` is a fact
    /// about the engine rather than about this instance's state: an engine with no verified
    /// adapter has no routes this host may call, and the grants readout says so.
    pub fn http(&self) -> Option<EngineHttp> {
        self.http
    }

    /// The reading half, taken once, by whoever drives this runtime.
    ///
    /// `None` means it was taken already. Nothing hands it back, deliberately: two readers of one
    /// engine would each see half the stream — and the whole point of moving the receivers out of
    /// [`AgentRuntime`] is that the reading half has exactly one owner.
    pub fn take_events(&mut self) -> Option<AgentRuntimeEvents> {
        self.events.take()
    }

    /// The same half, borrowed rather than taken, for a caller that reads it in place and never
    /// hands the ownership on (a test, in practice). `None` means the driver has it.
    pub fn events_mut(&mut self) -> Option<&mut AgentRuntimeEvents> {
        self.events.as_mut()
    }

    /// What this engine advertises — and only while this instance is the live one.
    ///
    /// §3.4 requires capabilities to be re-detected after a reconnect or a version change rather than
    /// carried over, so a stopped instance answers [`Capability::Unverified`] instead of repeating what
    /// its process advertised: the answer that cannot put a button in front of a user for a feature
    /// nothing can serve.
    pub fn declared_capability(&self, feature: HostFeature) -> Capability {
        if !self
            .live
            .lock()
            .unwrap()
            .is_live(&self.identity.runtime_epoch)
        {
            return Capability::Unverified;
        }
        self.adapter.declared_capability(feature)
    }

    /// Whether the engine this instance started is still running.
    ///
    /// **The one fact about an instance that can outlive its usefulness.** The claim this instance
    /// holds on its (agent, profile, vault) is taken before the engine is spawned and released only
    /// when the instance is dropped, and nothing runs on an engine's way out — so an engine that
    /// exited on its own leaves the registry refusing every later start with `AlreadyRunning`, for a
    /// process that is not there. A caller that holds the instance (the slot in
    /// [`AgentRuntimeState`](crate::state::AgentRuntimeState), in the app) is the only one that can
    /// both ask this and act on the answer.
    ///
    /// Read through the runtime, from the kernel, at the moment it is asked — not from a flag this
    /// host set and not from the process group, whose surviving members are the engine's subprocesses
    /// rather than the engine. [`AgentRuntime::engine_is_running`] carries what that rules out.
    pub fn engine_is_running(&self) -> bool {
        self.runtime.engine_is_running()
    }

    /// Stops this instance: the registration is free again, and the engine is asked to exit before
    /// it is signalled (§6.2's sequence, in `EngineConnection::shutdown`).
    pub fn shutdown(&self) {
        self.live
            .lock()
            .unwrap()
            .release(&self.identity.runtime_epoch);
        self.runtime.shutdown();
    }
}

impl Drop for AgentInstance {
    /// The same two steps as [`AgentInstance::shutdown`], because an instance the host has let go
    /// of must not leave a process behind: releasing the epoch alone would free the registration
    /// while the engine was still running, which is two engines for one (agent, profile, vault)
    /// the moment a start takes the freed slot. Both steps are idempotent — the epoch is a map
    /// entry, and the connection's stop senders are taken once.
    fn drop(&mut self) {
        self.shutdown();
    }
}
