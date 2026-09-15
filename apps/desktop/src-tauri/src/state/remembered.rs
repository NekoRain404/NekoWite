//! The vault root the backend remembers across runs.
//!
//! This is its own concern — persistence of the last root — and it is the
//! second of the two things that can vouch for a root: `VaultRegistry::register`
//! accepts a path the user picked this session, or one this module recorded.

use std::path::{Path, PathBuf};

use tauri::Manager;

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
