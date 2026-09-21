//! The managed states that have nothing to do with vaults: the folder watcher,
//! the stronghold handle, the AI request registry and the agent runtime.
//!
//! They share a module because they share a shape — each is a handle Tauri
//! holds for one subsystem, reached through `app.state::<T>()` — not because
//! they interact. Nothing here knows about paths, roots or confinement.
//!
//! The desktop pet's handle used to live here too. It moved to
//! [`super::desktop_pet_state`] because its assembly is a startup concern of its own — a data
//! directory, the stored switch that decides whether a pet is on screen before anything else
//! happens, and a window system that needs a running app — and because this file was over
//! §13.1's budget with it in. `crate::state::DesktopPetState` is the same path it always was.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};

use tauri::Manager;
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::agent_runtime::binary_registry::{self, BinaryRegistry};
use crate::agent_runtime::driver::{self, Session};
use crate::agent_runtime::events::{AgentEventEnvelope, AgentIdentity};
use crate::agent_runtime::profile::{ProfileError, ProfileStore};
use crate::agent_runtime::registry::{
    AgentInstance, AgentRegistry, RegistryError, DEFAULT_PROFILE,
};
use crate::state::desktop_pet_state::DesktopPetState;
use crate::state::live_note_windows::live_notes;
use crate::storage::agent_files::AgentVaultFiles;
use crate::storage::key_store::data_dir;

// ---------------------------------------------------------------------------
// Watcher state
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct WatcherState {
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// Bumped every time `watch_folder` installs a new watcher so trailing-edge
    /// flush tasks from the previous vault stop emitting.
    pub generation: Arc<AtomicU64>,
}

// ---------------------------------------------------------------------------
// Key vault state
// ---------------------------------------------------------------------------

/// Managed stronghold handle, opened lazily on first use (or by
/// `set_master_password`, which swaps the inner snapshot after re-encryption).
pub struct KeyVault(pub Mutex<Option<Stronghold>>);

impl Default for KeyVault {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

// ---------------------------------------------------------------------------
// AI state
// ---------------------------------------------------------------------------

/// Set of in-flight completion ids. `ai_cancel` removes an id, the stream
/// loop in `ai_complete` checks membership before each chunk and breaks when
/// the id is gone.
///
/// Also carries a bounded concurrency limiter: at most [`CONCURRENCY_LIMIT`]
/// completions stream at once, with [`MAX_PENDING`] more allowed to queue.
/// Beyond that a request is rejected with a clear "busy" error instead of
/// spawning an unbounded number of connections (which would duplicate billing,
/// open many sockets, and stutter every stream).
pub struct AiState {
    pub inflight: Mutex<HashSet<String>>,
    /// A cancellation signal per in-flight id.
    ///
    /// Membership in `inflight` is only observable BETWEEN awaits: the stream
    /// loop learns the id is gone after the current `stream.next()` resolves.
    /// For a reasoning model that await can be silent for tens of seconds (or
    /// until the 120 s read timeout), so cancelling left the connection open, the
    /// provider generating — and billing — and the concurrency permit held,
    /// which after a few cancels surfaced as "too many AI requests". A token can
    /// be awaited alongside the socket, so cancel drops the response body
    /// immediately.
    pub cancels: Mutex<HashMap<String, tokio_util::sync::CancellationToken>>,
    /// Concurrency cap for streaming completions. The permit is held for the
    /// whole request, so a bounded number of connections are ever open.
    pub(crate) semaphore: Arc<tokio::sync::Semaphore>,
    /// How many requests are currently queued waiting for a permit. Bounds the
    /// wait queue so saturation surfaces a fast "busy" error rather than a
    /// growing backlog of idle connections.
    pub(crate) pending: AtomicUsize,
}

impl AiState {
    /// Claim `id` for a new request and register its cancel token.
    ///
    /// Returns `false` when another live request already holds the id, leaving
    /// that request's registration untouched. An id is how `ai_cancel` and the
    /// stream loop address a request, so two live requests cannot share one:
    /// overwriting left the first request's token unreachable, and the first
    /// request's cleanup then removed the second's entries — a request still
    /// streaming that could never be cancelled and looked finished.
    pub fn claim(
        &self,
        id: &str,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<bool, String> {
        let mut inflight = self.inflight.lock().map_err(|e| e.to_string())?;
        if !inflight.insert(id.to_string()) {
            return Ok(false);
        }
        let mut cancels = self.cancels.lock().map_err(|e| e.to_string())?;
        cancels.insert(id.to_string(), cancel);
        Ok(true)
    }

    /// Drop a request's registration. Removing an id that is not registered is
    /// a no-op, so every exit path can call this unconditionally.
    pub fn release(&self, id: &str) {
        if let Ok(mut inflight) = self.inflight.lock() {
            inflight.remove(id);
        }
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(id);
        }
    }

    /// Interrupt a live request. `false` when nothing was registered under
    /// `id`, so the caller can tell "cancelled" from "there was nothing to
    /// cancel".
    ///
    /// The token is signalled, not just dropped: removing the id is only
    /// visible to the stream loop between reads, and a reasoning model can be
    /// silent for a long time. The token is awaited alongside the socket, so
    /// this is what actually closes the connection and frees the concurrency
    /// permit now rather than after the next chunk or the read timeout.
    pub fn cancel(&self, id: &str) -> Result<bool, String> {
        let token = self.cancels.lock().map_err(|e| e.to_string())?.remove(id);
        self.inflight.lock().map_err(|e| e.to_string())?.remove(id);
        match token {
            Some(token) => {
                token.cancel();
                Ok(true)
            }
            None => Ok(false),
        }
    }
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            inflight: Mutex::new(HashSet::new()),
            cancels: Mutex::new(HashMap::new()),
            semaphore: Arc::new(tokio::sync::Semaphore::new(CONCURRENCY_LIMIT)),
            pending: AtomicUsize::new(0),
        }
    }
}

pub(crate) const CONCURRENCY_LIMIT: usize = 3;
pub(crate) const MAX_PENDING: usize = 8;

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
/// `WatcherState::generation` above is the same idea for the folder watcher, and
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
/// §3.2's managed layout or the sidecar beside the executable ([`program_to_launch`]),
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

/// The definitions this app knows, for a reader that only looks — the settings surface's read.
///
/// A share rather than a borrow, because the command that asks runs on another task and a start may
/// be in flight beside it. What it deliberately is *not* is a mutation path: a change goes through
/// [`edit_registry`], which is the only way to get `&mut`, so no caller can edit a definition while
/// a start is awaiting on it (§3.4.7).
pub fn registry_of(
    state: &AgentRuntimeState,
    managed: &Path,
) -> Result<Arc<AgentRegistry>, String> {
    registry_for(state, managed)
}

/// Applies a change to the definitions — register, enable, disable — and answers
/// what the change produced.
///
/// The refusal grammar belongs to the caller: `change` returns its own value, so
/// "the backend said no" is data inside the answer while an `Err` from here means
/// the change *never ran* — the two failure channels T13a's settings surface
/// keeps apart, expressed as two types instead of two conventions.
///
/// **Why the value is taken out and put back.** The registry is stored as an
/// `Arc` because a start awaits while holding it (see the field), and a mutation
/// needs `&mut`. `Arc::try_unwrap` succeeds exactly when no start is in flight,
/// so the `Err` arm below is not a lock timeout — it is §3.4.7's rule, seen from
/// the other side: a definition may not be edited while an engine is being
/// started from it. The slot is held for the whole operation, so nothing can
/// observe it empty, and a value that came back out of `try_unwrap` is put back
/// unchanged.
pub fn edit_registry<T>(
    state: &AgentRuntimeState,
    managed: &Path,
    change: impl FnOnce(&mut AgentRegistry) -> T,
) -> Result<T, String> {
    let mut slot = state
        .registry
        .lock()
        .map_err(|_| "the agent registry state was poisoned by a panic".to_string())?;
    let registry = match slot.take() {
        Some(registry) => registry,
        // Not built yet: this is the first thing to ask for it, and the build is the same one a
        // start would have done — a settings page that could not read before a session started
        // would be a page that only worked in one order.
        None => Arc::new(AgentRegistry::with_bundled(program_to_launch(
            managed,
            &executable_dir(),
        )?)),
    };
    match Arc::try_unwrap(registry) {
        Ok(mut owned) => {
            let answer = change(&mut owned);
            *slot = Some(Arc::new(owned));
            Ok(answer)
        }
        Err(shared) => {
            // An engine start is in flight and holds a share of this registry. Reported as a
            // failure of *this call* rather than as a refusal, because the request was never
            // considered — and left in the slot exactly as it was.
            *slot = Some(shared);
            Err(
                "an engine is being started, so its registration cannot be changed right now; \
                 try again in a moment"
                    .to_string(),
            )
        }
    }
}

/// This app's agent definitions, built on first use.
fn registry_for(state: &AgentRuntimeState, managed: &Path) -> Result<Arc<AgentRegistry>, String> {
    let mut slot = state
        .registry
        .lock()
        .map_err(|_| "the agent registry state was poisoned by a panic".to_string())?;
    if let Some(registry) = slot.as_ref() {
        return Ok(Arc::clone(registry));
    }
    let registry = Arc::new(AgentRegistry::with_bundled(program_to_launch(
        managed,
        &executable_dir(),
    )?));
    *slot = Some(Arc::clone(&registry));
    Ok(registry)
}

/// The directory of the running executable, which is where a bundled engine sits
/// (§3.2). Empty when the platform will not say, which makes the lookup fail with
/// the sentence [`program_to_launch`] writes rather than with a guess.
fn executable_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

/// The program this host launches, from the two places §3.2 allows.
///
/// A promoted release wins when the pointer names a launchable one — that is
/// what §3.3's update path is for — and anything else falls back to the sidecar
/// shipped beside the executable, which §3.1.1 makes this app's verified base.
/// A pointer that cannot be read is reported and *not* a refusal: the bundled
/// engine is what a start would have used anyway, and refusing to start over a
/// diagnostic would turn a settings-page symptom into a dead session.
///
/// Nothing is searched for on `PATH`: the engine this app runs is the one it
/// ships or installed itself, never one it found.
///
/// `beside` is the directory of the running executable, passed in rather than
/// derived so that the resolution can be exercised without an app bundle.
pub fn program_to_launch(managed: &Path, beside: &Path) -> Result<PathBuf, String> {
    let layout = BinaryRegistry::new(managed).map_err(|error| format!("{error:?}"))?;
    match layout.active_program() {
        Ok(Some(program)) => return Ok(program.path),
        Ok(None) => {}
        Err(error) => eprintln!("nekowite: could not read the agent release pointer: {error:?}"),
    }
    binary_registry::bundled_program(beside)
        .map(|program| program.path)
        .ok_or_else(|| {
            format!(
                "the bundled engine was not found beside {}. It is installed with the app, so \
                 this points at a build or a package that did not carry it.",
                beside.display()
            )
        })
}

/// Why a start was refused, in the words of the thing that refused it.
fn start_refusal(error: &RegistryError) -> String {
    match error {
        RegistryError::Program { program, state } => {
            format!(
                "the agent's program is not launchable: {} ({state:?})",
                program.display()
            )
        }
        RegistryError::Disabled { agent_id } => {
            format!("the agent {agent_id} is switched off in settings")
        }
        RegistryError::ProfileUnbound {
            profile_id,
            agent_id,
            owner,
        } => match owner {
            Some(owner) => {
                format!("the profile {profile_id} belongs to {owner}, not to {agent_id}")
            }
            None => format!("no profile {profile_id} is bound to {agent_id}"),
        },
        RegistryError::AlreadyRunning { agent_id, epoch } => {
            format!("an engine for {agent_id} is already running in this vault ({epoch})")
        }
        RegistryError::LaunchFailed { agent_id, error } => {
            format!(
                "{agent_id} could not be started: {}",
                error.failure_message()
            )
        }
        RegistryError::UnknownAgent { agent_id } => format!("no agent named {agent_id}"),
        RegistryError::Id { field, value } => {
            format!("{value} cannot be used as {field}: it is not a name this app accepts")
        }
        RegistryError::Argument { index } => {
            format!("argument {index} of the agent's command line cannot be passed to a process")
        }
        RegistryError::Environment { name } => {
            format!("the environment variable {name} cannot be passed to a process")
        }
        RegistryError::UnknownAdapter { adapter_id } => {
            format!("no verified adapter for the engine {adapter_id}")
        }
        RegistryError::DuplicateAgent { agent_id } => format!("{agent_id} is registered twice"),
        RegistryError::InstanceRunning { agent_id, epoch } => {
            format!("{agent_id} still has a running engine ({epoch})")
        }
        RegistryError::IsDefault { agent_id } => {
            format!("{agent_id} is the default agent and cannot be removed")
        }
    }
}

/// Why the profile could not be opened.
fn profile_refusal(error: &ProfileError) -> String {
    match error {
        ProfileError::AgentMismatch {
            profile_id, bound, ..
        } => format!("the profile {profile_id} was created for {bound}, not for this agent"),
        ProfileError::Unreadable { path, message } => {
            format!(
                "the profile record {} cannot be read: {message}",
                path.display()
            )
        }
        ProfileError::ReadOnly => {
            "this profile follows the user's own configuration and is not written by the app"
                .to_string()
        }
        other => format!("the agent profile could not be opened: {other:?}"),
    }
}

#[cfg(test)]
mod ai_state_tests {
    use super::AiState;
    use tokio_util::sync::CancellationToken;

    #[test]
    fn a_second_claim_on_a_live_id_is_refused_and_leaves_the_first_alone() {
        let state = AiState::default();
        let first = CancellationToken::new();
        assert!(state.claim("req-1", first.clone()).unwrap());

        let second = CancellationToken::new();
        assert!(
            !state.claim("req-1", second.clone()).unwrap(),
            "a live id must not be handed out twice"
        );

        // The refused claim must not have replaced the first token, or
        // `ai_cancel` would signal a request nobody is running while the real
        // one streams on uncancellable.
        assert!(state.cancel("req-1").unwrap());
        assert!(
            first.is_cancelled(),
            "the owner's token is the one cancelled"
        );
        assert!(!second.is_cancelled());
        assert!(!state.inflight.lock().unwrap().contains("req-1"));
    }

    #[test]
    fn releasing_an_id_frees_it_for_reuse() {
        let state = AiState::default();
        assert!(state.claim("req-2", CancellationToken::new()).unwrap());
        state.release("req-2");
        assert!(!state.inflight.lock().unwrap().contains("req-2"));
        assert!(state.claim("req-2", CancellationToken::new()).unwrap());
    }

    #[test]
    fn cancelling_or_releasing_an_unknown_id_is_not_an_error() {
        let state = AiState::default();
        assert!(!state.cancel("never-started").unwrap());
        state.release("never-started");
    }
}
