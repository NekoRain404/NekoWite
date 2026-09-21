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
//!
//! This file is now the composition root of that module and nothing else: the implementation is
//! split by reason to change across five private submodules — `watcher` (the folder-watcher handle
//! and the generation mark trailing work is retired by), `ai` (the AI request registry and the key
//! vault), `agent` (the engine handle and the start path that fills it), `registry_access` (how a
//! registry is reached and edited) and `launch` (which program is launched, and the sentences a
//! refusal is written in) — and re-exported below. They stay private so `state::app_state::NAME`
//! remains the only way in: the split moved the code, not the surface, and no caller had to be
//! edited for it.

mod agent;
mod ai;
mod launch;
mod registry_access;
mod watcher;

pub use agent::{start_session, AgentRuntimeState};
pub use ai::{AiState, KeyVault};
pub use launch::program_to_launch;
pub use registry_access::{edit_registry, registry_of};
pub use watcher::WatcherState;

// The AI limiter's bounds stay at `pub(crate)`: that is the visibility they had here before the
// split, and `state.rs` re-exports them at the same one rather than as part of the public surface.
pub(crate) use ai::{CONCURRENCY_LIMIT, MAX_PENDING};
