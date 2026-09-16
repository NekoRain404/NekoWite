//! Managed app state: the structs Tauri holds via `.manage()` and the helpers
//! they expose. This is the only place that owns the session-wide state;
//! command and service modules reach it through `tauri::State` (`app.state`).
//!
//! Vault confinement lives here too: [`VaultRegistry`] records which vault
//! roots the user actually opened, and [`require_opened_vault`] is the guard
//! every path-confined command calls before touching a file.
//!
//! The implementation is split by concern across three private submodules —
//! `vault_confinement` (the registry and the rules a root must pass),
//! `remembered` (the root that survives a restart) and `app_state` (the
//! watcher, key, AI and agent handles, and the start path that fills the
//! agent's) — and re-exported below. They stay
//! private so `crate::state::NAME` remains the only way in: the split moved the
//! code, not the surface, and no caller had to be edited for it.

mod app_state;
mod remembered;
mod vault_confinement;

pub use app_state::{
    program_to_launch, start_session, AgentRuntimeState, AiState, KeyVault, WatcherState,
};
pub use remembered::{
    read_remembered_vault, remember_vault, remembered_vault, remembered_vault_dir,
    write_remembered_vault,
};
pub use vault_confinement::{require_opened_vault, VaultRegistry};

// The AI limiter's bounds are `pub(crate)`, so they are re-exported at the same
// visibility rather than as part of the public surface.
pub(crate) use app_state::MAX_PENDING;

// `CONCURRENCY_LIMIT` reaches the rest of the crate by path only from `limits`'
// test module — `AiState::default`, the one other reader, uses the constant
// directly inside `app_state` — so a non-test build has no consumer for this
// re-export and `unused_imports` fires on it. The path stays anyway: it is the
// one those tests already use, and editing a caller to suit a refactor is the
// thing this split exists to avoid.
#[allow(unused_imports)]
pub(crate) use app_state::CONCURRENCY_LIMIT;
