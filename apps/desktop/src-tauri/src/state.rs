//! Managed app state: the structs Tauri holds via `.manage()` and the helpers
//! they expose. This is the only place that owns the session-wide state;
//! command and service modules reach it through `tauri::State` (`app.state`).
//!
//! Vault confinement lives here too: [`VaultRegistry`] records which vault
//! roots the user actually opened, and [`require_opened_vault`] is the guard
//! every path-confined command calls before touching a file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};

use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::domain::path_policy::canonicalize_vault_root;
use crate::errors::vault_root_unauthorized_error;

// ---------------------------------------------------------------------------
// Vault registry
// ---------------------------------------------------------------------------

/// Server-side record of the vault root(s) the user actually opened this
/// session. The frontend registers a vault (via `register_vault`, or
/// implicitly when the native folder dialog returns a pick) and every
/// path-confined command then refuses a `vault_root` that is NOT in this set —
/// closing the hole where window code could pass an arbitrary absolute path
/// (e.g. `/home/user/.ssh`) as the "vault root" to read/write outside any
/// vault the user opened.
#[derive(Default)]
pub struct VaultRegistry(Mutex<HashSet<PathBuf>>);

impl VaultRegistry {
    /// Record `root` (canonicalized) as the opened vault.
    ///
    /// The UI is single-vault: registering a new root replaces any previously
    /// authorized one so a closed vault cannot keep answering path-confined
    /// commands for the rest of the session.
    pub fn register(&self, root: &str) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        let mut set = self.0.lock().map_err(|e| e.to_string())?;
        set.clear();
        set.insert(canonical.clone());
        Ok(canonical)
    }

    /// Drop authorization for `root`. Unknown roots are a no-op.
    pub fn unregister(&self, root: &str) -> Result<(), String> {
        let canonical = canonicalize_vault_root(root)?;
        let mut set = self.0.lock().map_err(|e| e.to_string())?;
        set.remove(&canonical);
        Ok(())
    }

    /// Prove `root` was opened by the user. Returns the canonicalized root or
    /// an error with a recovery hint when the root was never authorized.
    pub fn authorize(&self, root: &str) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        let set = self.0.lock().map_err(|e| e.to_string())?;
        if set.contains(&canonical) {
            Ok(canonical)
        } else {
            Err(vault_root_unauthorized_error(root))
        }
    }
}

/// Require `root` to be a vault the user opened this session, or fail with a
/// recovery hint. Called at the top of every path-confined command.
pub fn require_opened_vault(registry: &VaultRegistry, root: &str) -> Result<(), String> {
    registry.authorize(root).map(|_| ())
}

// ---------------------------------------------------------------------------
// Asset-scope state
// ---------------------------------------------------------------------------

/// The vault root whose `asset://` media scope is currently open.
///
/// The fs scope is append-only — `tauri`'s `Scope` exposes `allow_directory`
/// and `forbid_directory` but nothing that removes an allowance — so the only
/// way to close a vault the user has left is to *forbid* it. Remembering which
/// root is open is what makes that possible: without it a vault that was once
/// opened keeps serving `asset://` reads for the rest of the session, across
/// every later vault switch.
#[derive(Default)]
pub struct MediaScope(Mutex<Option<PathBuf>>);

impl MediaScope {
    /// Record `root` as the open media root, returning the root it replaced.
    ///
    /// Returning the replaced root is the whole point: the caller forbids it,
    /// and it must be read and replaced under one lock so two concurrent opens
    /// cannot both miss (or both revoke) the same predecessor.
    pub fn open(&self, root: &Path) -> Option<PathBuf> {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let previous = guard.clone();
        *guard = Some(root.to_path_buf());
        previous
    }
}

#[cfg(test)]
mod media_scope_tests {
    use super::MediaScope;
    use std::path::{Path, PathBuf};

    #[test]
    fn the_first_open_replaces_nothing() {
        let scope = MediaScope::default();
        assert_eq!(scope.open(Path::new("/vault/a")), None);
    }

    #[test]
    fn a_later_open_hands_back_the_root_it_replaced() {
        let scope = MediaScope::default();
        scope.open(Path::new("/vault/a"));
        assert_eq!(
            scope.open(Path::new("/vault/b")),
            Some(PathBuf::from("/vault/a"))
        );
        // Re-opening the same root reports it as replaced, which the caller
        // filters with an equality check — revoking then re-allowing would
        // forbid the vault that is staying open.
        assert_eq!(
            scope.open(Path::new("/vault/b")),
            Some(PathBuf::from("/vault/b"))
        );
    }
}

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
