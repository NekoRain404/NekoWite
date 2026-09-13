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

use tauri::Manager;
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::domain::path_policy::{canonicalize_vault_root, ipc_path};
use crate::errors::vault_root_unauthorized_error;

// ---------------------------------------------------------------------------
// Vault registry
// ---------------------------------------------------------------------------

/// Server-side record of the vault root the user actually opened this session.
/// Every path-confined command refuses a `vault_root` that is NOT in this set —
/// closing the hole where window code could pass an arbitrary absolute path
/// (e.g. `/home/user/.ssh`) as the "vault root" to read/write outside any
/// vault the user opened.
#[derive(Default)]
pub struct VaultRegistry {
    /// The root path-confined commands may be pointed at. The UI is
    /// single-vault, so registering replaces whatever was there: a closed vault
    /// must not keep answering commands for the rest of the session.
    opened: Mutex<HashSet<PathBuf>>,
    /// Roots the user chose in the native folder dialog this session.
    ///
    /// This is the only evidence the backend has that a path came from a
    /// person. `register_vault` is an IPC command, so "the window asked for it"
    /// is worth nothing on its own: a compromised renderer can ask for `/etc`
    /// exactly as easily as for the user's notes. A folder the user pointed at
    /// in the OS dialog is a fact the renderer cannot manufacture.
    chosen: Mutex<HashSet<PathBuf>>,
}

impl VaultRegistry {
    /// Record that the user picked `root` in the native folder dialog, without
    /// registering anything.
    ///
    /// Registering here would de-authorize the vault still on screen
    /// (`register` replaces it), and the frontend flushes the outgoing vault's
    /// dirty tabs before it commits to a new one — those writes would then be
    /// refused and the switch would abort, leaving the UI on a vault the
    /// backend no longer serves. The pick is remembered; `register` is called
    /// once the switch is actually committed.
    pub fn approve_pick(&self, root: &str) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        if !canonical.is_dir() {
            return Err(format!(
                "{} is not a folder and cannot be opened as a vault",
                ipc_path(&canonical)
            ));
        }
        let mut chosen = self.chosen.lock().map_err(|e| e.to_string())?;
        chosen.insert(canonical.clone());
        Ok(canonical)
    }

    /// Record `root` (canonicalized) as the opened vault.
    ///
    /// `remembered` is the root the BACKEND itself recorded the last time a
    /// vault was opened ([`remembered_vault`]). Passing it is what lets a
    /// session start on the vault the user was working in yesterday without a
    /// fresh dialog; it is not something the window can invent, because that
    /// record is only ever written here, from a root that got through this
    /// function.
    pub fn register(&self, root: &str, remembered: Option<&Path>) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        if !canonical.is_dir() {
            return Err(format!("cannot open {root} as a vault: it is not a folder"));
        }
        if let Some(refusal) = vault_root_structural_refusal(&canonical) {
            return Err(refusal);
        }
        let chosen = self
            .chosen
            .lock()
            .map_err(|e| e.to_string())?
            .contains(&canonical);
        let recalled = remembered.is_some_and(|record| same_folder(record, &canonical));
        if !chosen && !recalled {
            return Err(unvouched_vault_root_error(root));
        }
        let mut set = self.opened.lock().map_err(|e| e.to_string())?;
        set.clear();
        set.insert(canonical.clone());
        Ok(canonical)
    }

    /// Drop authorization for `root`. Unknown roots are a no-op.
    pub fn unregister(&self, root: &str) -> Result<(), String> {
        let canonical = canonicalize_vault_root(root)?;
        let mut set = self.opened.lock().map_err(|e| e.to_string())?;
        set.remove(&canonical);
        Ok(())
    }

    /// Prove `root` was opened by the user. Returns the canonicalized root or
    /// an error with a recovery hint when the root was never authorized.
    pub fn authorize(&self, root: &str) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        let set = self.opened.lock().map_err(|e| e.to_string())?;
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

/// The error for a root that nothing vouches for. It names the two things that
/// do vouch for one, because the caller is a user whose vault did not open.
fn unvouched_vault_root_error(root: &str) -> String {
    format!(
        "refusing to open a vault the user did not choose: {root}. \
         The backend only serves a folder the user picked in the folder dialog, \
         or the vault it opened last. Use \"Open folder\" to choose it."
    )
}

/// A folder that is structurally incapable of being a vault, however it was
/// chosen.
///
/// `register` is the one place that decides this, so it stays a policy about
/// vaults rather than a list of names: `/` and the user's home are exactly the
/// two folders whose children are "everything on the machine" and "everything
/// of mine". Neither can hold a note collection of its own, and serving one
/// would hand every path-confined command the run of the filesystem — not
/// because a rule failed, but because there would be no boundary left to
/// enforce. Everything else stays a matter of the user having chosen it.
fn vault_root_structural_refusal(path: &Path) -> Option<String> {
    let shown = ipc_path(path);
    // `/` on unix, `C:\` on windows: the only paths without a parent.
    if path.parent().is_none() {
        return Some(format!(
            "refusing to open {shown} as a vault: it is the filesystem root, \
             which would put every file on the machine inside the vault. \
             Choose the folder that holds your notes."
        ));
    }
    if let Some(home) = home_dir().and_then(|home| home.canonicalize().ok()) {
        if path == home {
            return Some(format!(
                "refusing to open {shown} as a vault: it is your home directory, \
                 which holds your keys, configuration and browser data. \
                 Choose a folder inside it, such as ~/Documents/notes."
            ));
        }
        // `starts_with` also covers equality, but the case above has its own
        // message: "you picked home itself" and "you picked a folder that
        // contains home" are different mistakes.
        if home.starts_with(path) {
            return Some(format!(
                "refusing to open {shown} as a vault: it contains your home directory. \
                 Choose a folder inside your home directory."
            ));
        }
    }
    None
}

/// The user's home directory: the folder whose children are the user's private
/// data on every platform this app ships for.
#[cfg(unix)]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(windows)]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// Whether two paths name the same folder. Canonicalizes when it can, so a
/// record written through one spelling (a symlinked home, a `/tmp` that is a
/// link) still matches the other, and falls back to the literal comparison when
/// the folder is gone.
fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

// ---------------------------------------------------------------------------
// The root the backend remembers
// ---------------------------------------------------------------------------

/// File under the app's config directory holding the vault root that was opened
/// last. It exists so a restart can reopen that vault without asking the user
/// to pick it again, while still refusing a root the window announces on its
/// own: nothing but a successful `register` writes this file, and the renderer
/// has no IPC path to the config directory.
const REMEMBERED_VAULT_FILE: &str = "last-vault";

/// Read the recorded root. A missing, unreadable or unusable record simply
/// vouches for nothing — the user picks the vault again.
pub fn read_remembered_vault(file: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(file).ok()?;
    let path = PathBuf::from(raw.trim());
    // A relative or empty record is not a vault: the same check the registry
    // applies to a root it is handed, so a truncated or hand-edited file cannot
    // authorize something the normal path never could.
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return None;
    }
    Some(path)
}

/// Write the recorded root. One line, no structure: the file is a note to the
/// next launch, not a database.
pub fn write_remembered_vault(file: &Path, root: &Path) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(file, format!("{}\n", root.display()))
}

fn remembered_vault_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(REMEMBERED_VAULT_FILE))
}

/// The vault root the backend recorded last, if any.
pub fn remembered_vault(app: &tauri::AppHandle) -> Option<PathBuf> {
    read_remembered_vault(&remembered_vault_file(app)?)
}

/// Record `root` as the vault to reopen next launch.
///
/// Best-effort on purpose: a config directory that cannot be written costs the
/// next launch a folder pick, which is not a reason to fail the open the user
/// is in the middle of.
pub fn remember_vault(app: &tauri::AppHandle, root: &Path) {
    if let Some(file) = remembered_vault_file(app) {
        let _ = write_remembered_vault(&file, root);
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
