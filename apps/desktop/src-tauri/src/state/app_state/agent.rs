//! The agent subsystem's handle and the start path that fills it: the engine that is running, the
//! definitions it was started from, and the live-buffer seam it reads through.
//!
//! A module of its own because [`AgentRuntimeState`] and [`start_session`] change together and for
//! one reason — the shape of a start. The slots are the order a start must fill, and the start is
//! where §3.4's refusal, §8.1's profile and the epoch's installation are decided. Which *program*
//! is launched is [`super::launch`]'s, and how a registry is reached is
//! [`super::registry_access`]'s.

use std::sync::{Arc, Mutex};

use tauri::Manager;

use crate::agent_runtime::driver::{self, Session};
use crate::agent_runtime::events::{AgentEventEnvelope, AgentIdentity};
use crate::agent_runtime::profile::ProfileStore;
use crate::agent_runtime::registry::{AgentInstance, AgentRegistry, DEFAULT_PROFILE};
use crate::state::desktop_pet_state::DesktopPetState;
use crate::state::live_note_windows::live_notes;
use crate::storage::agent_files::AgentVaultFiles;
use crate::storage::key_store::data_dir;

use super::launch::{profile_refusal, start_refusal};
use super::registry_access::registry_for;

// ---------------------------------------------------------------------------
// Agent runtime state
// ---------------------------------------------------------------------------

/// The agent subsystem, as a handle Tauri holds.
///
/// Two slots, both `None` until a session is started, and for the same reason
/// `KeyVault` is lazy: neither can be built at startup. The engine is a child
/// process whose program path is the packaging step's decision (`binary_registry`
/// resolves the sidecar, §3.2), and the definitions that describe it come from
/// the user's settings. An app that opened either before a window existed would
/// be answering for a failure nobody asked for, and — because a start that fails
/// must not leave a half-open subsystem behind — the start path fills both only
/// after it has everything it needs.
///
/// What this deliberately does **not** carry is an epoch counter.
/// `super::watcher::WatcherState::generation` is the same idea for the folder watcher, and
/// §6.2's `runtimeEpoch` is minted where it belongs: `agent_runtime::registry`
/// claims one per (agent, profile, vault) when an instance starts and releases it
/// when that instance ends, so an envelope's epoch and the registry's answer to
/// "which incarnation is live" are one value. A counter here would be a second
/// answer to a question that must have exactly one, and the two would drift the
/// first time a start failed between the claim and the runtime.
#[derive(Default)]
pub struct AgentRuntimeState {
    /// Which engines this app knows and which profile belongs to which — the
    /// definitions, not the processes. `Mutex` because adding, disabling and
    /// removing a definition all take `&mut`; starting one takes `&self`.
    ///
    /// Shared (`Arc`) rather than owned, and only because a start *awaits*:
    /// `AgentRegistry::start` spawns the engine and completes its handshake on
    /// the caller's task, and a `MutexGuard` held across that await would make
    /// every Tauri command that starts an engine unsendable. A holder clones the
    /// `Arc` and drops the guard. A mutation path — none exists yet: no task owns
    /// the registry's settings IPC — takes the value back out with
    /// `Arc::try_unwrap`, which succeeds exactly when no start is in flight, and
    /// that is the state in which a definition may be changed at all (§3.4.7).
    pub registry: Mutex<Option<Arc<AgentRegistry>>>,
    /// The engine that is running, if one is. One at a time: §6.1 requires a
    /// single session writer per vault, and a second instance for the same
    /// (agent, profile, vault) is refused by the registry rather than kept here.
    ///
    /// Dropping the value is what stops the engine and frees the registration
    /// ([`AgentInstance`]'s own `Drop`), so a stop is this slot being emptied —
    /// and a replacement start is it being refilled after that.
    pub instance: Mutex<Option<AgentInstance>>,
    /// The window side of the live-buffer seam: which windows can be asked what a
    /// note holds, and the questions outstanding.
    ///
    /// `None` until a start has happened, because reaching a window needs an
    /// `AppHandle` and there is none before `setup` — the reason the desktop pet's
    /// state is built there rather than by `Default`. Built on the first start and
    /// then **kept**, which is the property that makes it worth storing here: a
    /// window registers once and stays registered across a vault switch or a
    /// restart of the engine, so a new runtime does not begin with a window that
    /// can no longer be asked about the note on screen. A registration carries no
    /// document — see `state/live_note_windows.rs` for what travels and why.
    pub live_notes: Mutex<Option<crate::agent_runtime::LiveNotes>>,
}

impl AgentRuntimeState {
    /// Lets go of an instance whose engine is no longer there, answering which one it was.
    ///
    /// **The failure this is about.** §3.4 refuses a second engine on one (agent, profile, vault),
    /// and the claim behind that refusal is taken before the engine is spawned and released only when
    /// the instance is dropped. Nothing runs on an engine's way out, so an engine that exits on its
    /// own leaves this app refusing every later start with 「an engine for opencode is already running
    /// in this vault」 — for a process that is not running. Restarting the engine from the UI clears
    /// that by accident (a restart tears the old instance down before it composes a new one), which is
    /// what keeps the wedged state hard to see: the sentence names an engine, and the only engine in
    /// front of the user is the one the app just started. Nothing else clears it, so it lasts until
    /// the app is quit.
    ///
    /// **Why the drop, and not a call into the registry.** [`AgentInstance::shutdown`] — and its
    /// `Drop` — releases the epoch *and* tears the connection down, in that order, and the two are one
    /// act: a release on its own would free the (agent, profile, vault) while an engine could still be
    /// running, which is the second engine §3.4 forbids the instant a start takes the freed slot. So a
    /// stale instance is taken out of the slot and dropped, exactly as `agent_stop` lets one go, and
    /// the registry is told nothing the instance did not tell it itself.
    ///
    /// **The reading can say "running".** [`AgentInstance::engine_is_running`] is the kernel's answer
    /// about the process this host spawned, so a live engine — however wedged, however silent — comes
    /// back `true`, the claim stays held, and the next start is refused. That refusal is the honest
    /// one: §3.4's rule is about two engines writing one profile, and a reading eager enough to free a
    /// live engine's claim is a reading that puts two on one profile.
    ///
    /// **What the caller still owes.** The instance's end restates nothing on its own: in the app, the
    /// desktop pet's task list and the window's session both still name this incarnation, and both are
    /// settled by the start that follows (`start_session` retires the pet's tasks and installs the
    /// session). This is why it answers the identity it let go of rather than a bare `()`.
    pub fn release_a_stale_instance(&self) -> Result<Option<AgentIdentity>, String> {
        let stale = {
            let mut slot = self
                .instance
                .lock()
                .map_err(|_| "the agent runtime state was poisoned by a panic".to_string())?;
            match slot.as_ref() {
                Some(instance) if !instance.engine_is_running() => slot.take(),
                // Either there is no instance, or the one in the slot is running an engine. Both are
                // states this method has nothing to do.
                _ => None,
            }
        };
        // Dropped outside the lock: this is a connection teardown, and it has no business running
        // under the slot every agent command in the app reaches through.
        let Some(instance) = stale else {
            return Ok(None);
        };
        let identity = instance.identity().clone();
        drop(instance);
        Ok(Some(identity))
    }
}

// ---------------------------------------------------------------------------
// Starting the agent subsystem
// ---------------------------------------------------------------------------

/// Starts the engine for `vault_id`, fills the instance slot, and answers the
/// session the IPC layer addresses.
///
/// Everything a start needs comes from the app's own places: the program from
/// §3.2's managed layout or the sidecar beside the executable ([`program_to_launch`](super::launch::program_to_launch)),
/// the engine's roots from the profile (§8.1), the file capability from the
/// app's own write path (`storage::agent_files`). None of that can be resolved
/// before a window exists — which is why both slots above are empty until this
/// call, and why Tauri cannot simply build the subsystem at startup.
///
/// `sink` is where the runtime's published envelopes go — the window's event
/// channel, in the app. It arrives as a closure so that this file, and
/// [`driver`], need no knowledge of Tauri's event API.
///
/// The refusals are sentences rather than T3a's data-only `RegistryError`,
/// because of what reads them: a start failure reaches the user as the
/// rejection of the promise `agent_start` returned, with no form and no mapper
/// in between, while `RegistryError`'s own vocabulary is what T13a's settings
/// page maps for a registration form. Where the two overlap (a program that is
/// not there) the sentence names the path and the state, which is what the form
/// needs to say too.
pub async fn start_session(
    state: &AgentRuntimeState,
    app: &tauri::AppHandle,
    vault_id: &str,
    sink: impl Fn(AgentEventEnvelope) + Send + 'static,
) -> Result<Session, String> {
    // The pet hears the runtime's own frames from *this* point rather than from a subscription of
    // its own: §6.1's single task fact source is the stream the driver reads, and a second reader
    // would see half of it (its own doc says so). The projection is fed before the window's sink
    // is called, so the task a frame is about is recorded by the time anything a user sees exists
    // — a window that mounted in that instant reads the list, not the frame.
    let sink = {
        let pet = app.clone();
        move |envelope: AgentEventEnvelope| {
            // A poisoned lock or a feed that cannot answer costs the *push*, never the frame: the
            // window's own read, and the event below, still happen.
            // A build without the pet's state (this crate's own test apps) has no list to feed:
            // the frame still reaches the window's sink below, which is what it is for. `try_state`
            // rather than `state`, because a panic on the driver's task would end the event loop.
            if let Some(state) = pet.try_state::<DesktopPetState>() {
                match state.tasks.apply(&envelope) {
                    Ok(Some(tasks)) => crate::desktop_pet::publish_tasks(&pet, &tasks),
                    Ok(None) => {}
                    Err(detail) => {
                        eprintln!("nekowite: the pet's task list did not follow a frame: {detail}")
                    }
                }
            }
            sink(envelope);
        }
    };
    let managed = data_dir(app)?;
    let registry = registry_for(state, &managed)?;
    let agent_id = registry.default_agent_id().to_string();
    // Before anything is composed, the slot is emptied of an engine that is no longer there: the
    // registry refuses a second engine per (agent, profile, vault) §3.4, and that refusal must be
    // about a process rather than about a claim the host never let go of. An engine that exited on
    // its own leaves exactly such a claim — see [`AgentRuntimeState::release_a_stale_instance`] — and
    // the drop it performs here is what frees it, through the instance's own teardown, before the
    // start below can be refused on its behalf.
    if let Some(gone) = state.release_a_stale_instance()? {
        // The pet's list, while the old incarnation's identity is still in hand: an instance the host
        // has let go of cannot still be running anything, and a row that says otherwise outlives the
        // process it names. The same restatement `stop_running_engine` performs on the stop path, and
        // for the same reason — a successful start below reaches it a second time through `install`,
        // and a start that *fails* is the case this is here for: a `working` row must not outlive the
        // engine it belongs to just because the replacement could not be started.
        if let Some(pet) = app.try_state::<DesktopPetState>() {
            match pet.tasks.retire(&gone) {
                Ok(Some(tasks)) => crate::desktop_pet::publish_tasks(app, &tasks),
                Ok(None) => {}
                Err(detail) => {
                    eprintln!(
                        "nekowite: the pet's task list did not follow a dead engine: {detail}"
                    )
                }
            }
        }
    }
    // §8.1: opening the profile is what creates and binds it on first use, and
    // its root is the engine's `HOME` and its XDG roots.
    let profile = ProfileStore::new(&managed)
        .open(&agent_id, DEFAULT_PROFILE)
        .map_err(|error| profile_refusal(&error))?;
    let mut instance = registry
        .start(
            &agent_id,
            DEFAULT_PROFILE,
            vault_id,
            profile.root(),
            // §8.1: the profile is where an engine's authorization lives, and this is the moment it
            // reaches the engine — through the environment, never `argv` (P0 §3). The profiles are
            // not shared between engines, and `start` has just checked that this one belongs to
            // this agent, so nothing here is a credential borrowed from another engine.
            profile.credentials(),
            Arc::new(AgentVaultFiles),
            // The other half of the file capability: a *read* serves the buffer the user is
            // typing into, which means asking the window holding the vault. Same shape as
            // `AgentVaultFiles` and same reason — the runtime declares the port, the app
            // supplies the end that reaches its own surfaces.
            live_notes(state, app)?,
        )
        .await
        .map_err(|error| start_refusal(&error))?;
    // §3.4's last line: which config option selects the model is the adapter's
    // answer, and the renderer is *told* it rather than looking for an option
    // whose name suggests a model.
    let model_option_id = registry
        .get(&agent_id)
        .and_then(|registration| registration.adapter())
        .and_then(|adapter| adapter.model_option_id())
        .map(str::to_string);
    let session = driver::install(&mut instance, model_option_id, sink)?;
    // The instance is the incarnation — it holds the epoch claim and it is what
    // tears the engine down when it goes — so it is stored *after* the session
    // is built. A previous instance, if one was still there, is dropped by the
    // assignment, which is the same teardown `agent_stop` performs.
    let mut slot = state
        .instance
        .lock()
        .map_err(|_| "the agent runtime state was poisoned by a panic".to_string())?;
    // The epoch is installed *before* the instance is stored, so the first frame of the new
    // incarnation is never refused as foreign while the old one is still on the feed. Installing
    // a different epoch is the projection's proof that the previous one is over, which is what
    // restates anything it had in flight as `interrupted` (§6.2's last row) — so a restart is a
    // reminder about work that was cut off, and never a run left saying `working` for ever.
    if let Some(pet) = app.try_state::<DesktopPetState>() {
        match pet.tasks.install(&session.identity) {
            Ok(Some(tasks)) => crate::desktop_pet::publish_tasks(app, &tasks),
            Ok(None) => {}
            Err(detail) => {
                eprintln!("nekowite: the pet's task list did not follow a start: {detail}")
            }
        }
    }
    *slot = Some(instance);
    Ok(session)
}
