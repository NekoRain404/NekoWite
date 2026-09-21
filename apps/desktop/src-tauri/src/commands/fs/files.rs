//! The note and directory commands: reading, saving, creating, deleting, listing and renaming
//! inside an opened vault.
//!
//! **This file was split out of `commands/fs.rs`.** It owns one subject — a path inside the vault
//! and the operation the user asked for on it — and changes when that operation or its refusal
//! does. What it does NOT own is the answer to "is this vault one the user opened": that is
//! [`crate::state::require_opened_vault`]'s, called here exactly as it was before the move, and the
//! authority behind it is `commands/fs/vaults.rs`.
//!
//! The commands are re-exported from `commands/fs.rs` together with the two macros
//! `#[tauri::command]` emits beside each one, so `commands::fs::<name>` still names the same
//! function and the same `__cmd__*` macro `lib.rs`'s handler list needs. They are `pub` and the
//! module is private: a `pub` item in a private module is reachable only through that re-export,
//! which is the one spelling the handler list and `build.rs`'s `COMMANDS` already use.

use crate::state::{require_opened_vault, VaultRegistry};
use crate::storage::file_store::{self, FileEntry, FileStat};
use crate::storage::trash_store;

use super::picked::PickedImages;

// The frontend gateway invokes every command with snake_case argument names
// (`vault_root`, `max_history`, `trash_path`, `default_name`, `start_dir`),
// while the default `#[tauri::command]` expects camelCase — hence
// `rename_all = "snake_case"` on all of them. Commands are `async fn` so the
// blocking work (fs I/O, dialogs) runs on Tauri's worker pool instead of the
// main thread.

#[tauri::command(rename_all = "snake_case")]
pub async fn read_file(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::read_file(&vault_root, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn stat_file(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<FileStat, String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::stat_file(&vault_root, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn write_file(
    vault_root: String,
    path: String,
    content: String,
    max_history: Option<u32>,
    expected_content: Option<String>,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Option<String>, String> {
    require_opened_vault(&state, &vault_root)?;
    // `Some(warning)` = the text was written, but something optional around it
    // failed (currently: the history snapshot). The window shows it; it must not
    // be mistaken for a failed save.
    crate::storage::save_store::write_file_guarded(
        &vault_root,
        &path,
        &content,
        max_history,
        expected_content.as_deref(),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn create_new_file(
    vault_root: String,
    path: String,
    content: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<(), String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::create_new_file(&vault_root, &path, &content)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn delete_file(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    trash_store::delete_file(&vault_root, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_dir(
    vault_root: String,
    path: Option<String>,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Vec<FileEntry>, String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::list_dir(&vault_root, path.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_attachment(
    vault: String,
    file_name: String,
    base64: String,
    dir: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    file_store::save_attachment(&vault, &file_name, &base64, &dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn create_dir(
    vault: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    file_store::create_dir(&vault, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn rename_entry(
    vault: String,
    from: String,
    to: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    file_store::rename_entry(&vault, &from, &to)
}

/// Copy a user-picked image into the vault's assets directory and return its
/// vault-relative path. The bytes move backend-side (no base64 IPC hop) and the
/// destination is still confined to the opened vault.
///
/// **"User-picked" is enforced here, not assumed.** The source path is deliberately outside the
/// vault — a picker exists so a file can come from anywhere — so nothing about the *destination*
/// confinement says anything about the source. What makes this call legitimate is that the user
/// chose this exact path in the image dialog a moment ago, which is what [`PickedImages::release`]
/// answers; without it, any window that can invoke this command could name a path of its own and
/// read the copy back through the asset protocol (finding S4 in
/// `docs/audits/2026-09-21-code-review.md`).
#[tauri::command(rename_all = "snake_case")]
pub async fn import_attachment(
    vault: String,
    source_path: String,
    dir: String,
    state: tauri::State<'_, VaultRegistry>,
    picked: tauri::State<'_, PickedImages>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    // Spent before the copy, so a failure of the copy does not leave a usable grant behind: the
    // user picks again, which is one click, and the rule stays one-shot.
    if !picked.release(std::path::Path::new(&source_path)) {
        return Err(format!(
            "refusing to import an image this session did not pick: {source_path}. \
             The backend only copies a file the user chose in the image dialog. \
             Use \"Insert image\" to choose it again."
        ));
    }
    file_store::import_attachment(&vault, &source_path, &dir)
}
