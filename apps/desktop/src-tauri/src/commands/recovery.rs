//! Recovery commands: the trash and history side of the IPC surface.
//!
//! These prove the vault was opened, then delegate to the trash/history
//! storage layer. Command names, DTOs and error strings are unchanged from the
//! pre-split layout.

use crate::state::{require_opened_vault, VaultRegistry};
use crate::storage::file_store::{self, HistoryEntry};
use crate::storage::trash_store::{self, ClearTrashReport, TrashEntry};

#[tauri::command(rename_all = "snake_case")]
pub async fn list_trash(
    vault_root: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Vec<TrashEntry>, String> {
    require_opened_vault(&state, &vault_root)?;
    trash_store::list_trash(&vault_root)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn restore_from_trash(
    vault_root: String,
    trash_path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    trash_store::restore_from_trash(&vault_root, &trash_path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn clear_trash(
    vault: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<ClearTrashReport, String> {
    require_opened_vault(&state, &vault)?;
    trash_store::clear_trash(&vault)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn list_history(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Vec<HistoryEntry>, String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::list_history(&vault_root, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn read_history(
    vault_root: String,
    path: String,
    id: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::read_history(&vault_root, &path, &id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn restore_history(
    vault_root: String,
    path: String,
    id: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::restore_history(&vault_root, &path, &id)
}
