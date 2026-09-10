//! Filesystem commands: the `#[tauri::command]` IPC surface for vault file
//! operations, vault registration and native dialogs.
//!
//! Each command deserializes its snake_case args, proves the vault was opened
//! this session, calls one storage/domain function, and maps the error. All
//! command names, request/response DTOs and error strings are unchanged from
//! the pre-split layout.

use std::path::Path;

use notify::Watcher;
use tauri::Emitter;

use crate::domain::path_policy::{has_hidden_component, resolve_within};
use crate::state::{require_opened_vault, VaultRegistry, WatcherState};
use crate::storage::file_store::{self, FileEntry, FileStat};
use crate::storage::trash_store;

#[tauri::command]
pub fn ping() -> String {
    "pong".into()
}

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
    state: tauri::State<'_, VaultRegistry>,
) -> Result<(), String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::write_file(&vault_root, &path, &content, max_history)
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
pub async fn search_notes(
    vault_root: String,
    query: String,
    max_dirs: Option<usize>,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Vec<FileEntry>, String> {
    require_opened_vault(&state, &vault_root)?;
    // The frontend does not send `max_dirs`, so it defaults to the generous
    // SEARCH_MAX_DIRS — a large vault's search is no longer silently capped.
    // The optional arg is the explicit guard for a future client that wants to
    // bound an unusually deep/hostile tree.
    file_store::search_notes_with_max(&vault_root, &query, 100, max_dirs)
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
pub async fn resolve_media_path(
    vault: String,
    rel_path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    file_store::resolve_media_path(&vault, &rel_path)
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

/// Register a vault root the user opened. Call this right after the user picks
/// a vault (folder dialog) or restores a previously opened one, BEFORE any
/// path-confined command, so the backend will serve it. This is the authority
/// that lets path-confined commands distinguish "a vault the user opened" from
/// arbitrary absolute paths.
#[tauri::command(rename_all = "snake_case")]
pub fn register_vault(
    vault_root: String,
    state: tauri::State<'_, VaultRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.register(&vault_root)?;
    // Registering a vault is the authoritative "the user opened this path" event
    // and fires on EVERY open path (folder dialog + localStorage restore). Extend
    // the asset protocol scope to the whole vault here so pasted/unstaged images —
    // which live under `.tmp/` or a per-note `<name>_assets/` directory, NOT
    // `attachments/` — are servable via asset:// immediately. Previously this
    // only happened from watch_folder, so a vault opened by restore had a stale
    // scope and those images 404'd (imported but never displayed).
    allow_vault_media(&app, &vault_root);
    Ok(())
}

#[tauri::command]
pub async fn open_folder_dialog(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string());
    // The native dialog is a genuine user gesture, so the picked folder is a
    // vault the user actually opened — register it so fs commands can serve it.
    if let Some(ref path) = picked {
        let _ = state.register(path);
    }
    Ok(picked)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn save_file_dialog(
    app: tauri::AppHandle,
    default_name: String,
    start_dir: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_dialog::FilePath;
    let mut builder = app
        .dialog()
        .file()
        .set_file_name(&default_name);
    if let Some(dir) = start_dir {
        builder = builder.set_directory(dir);
    }
    let path = builder.blocking_save_file();
    Ok(path.and_then(|p| match p {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        _ => None,
    }))
}

/// Native multi-select image picker. Returns the absolute paths the user chose
/// (empty when the dialog was cancelled), filtered to the image extensions the
/// import path accepts so an "All files" selection cannot smuggle a
/// non-image into the vault.
#[tauri::command(rename_all = "snake_case")]
pub async fn pick_image_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_dialog::FilePath;
    let picked = app
        .dialog()
        .file()
        .add_filter("Images", file_store::IMPORT_IMAGE_EXTENSIONS)
        .blocking_pick_files();
    let Some(paths) = picked else {
        return Ok(Vec::new());
    };
    Ok(paths
        .into_iter()
        .filter_map(|p| match p {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
        .filter(|p| file_store::is_importable_image(p))
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

/// Copy a user-picked image into the vault's assets directory and return its
/// vault-relative path. The bytes move backend-side (no base64 IPC hop) and the
/// destination is still confined to the opened vault.
#[tauri::command(rename_all = "snake_case")]
pub async fn import_attachment(
    vault: String,
    source_path: String,
    dir: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    file_store::import_attachment(&vault, &source_path, &dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn watch_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    vault_registry: tauri::State<'_, VaultRegistry>,
    vault_root: String,
    path: Option<String>,
) -> Result<(), String> {
    require_opened_vault(&vault_registry, &vault_root)?;
    allow_vault_media(&app, &vault_root);
    let resolved = match path {
        Some(p) => resolve_within(&vault_root, &p)?,
        None => resolve_within(&vault_root, ".")?,
    };
    let mut new_watcher = notify::RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let kind = if event.kind.is_create() {
                    "created"
                } else if event.kind.is_modify() {
                    "modified"
                } else if event.kind.is_remove() {
                    "removed"
                } else {
                    &format!("{:?}", event.kind).to_lowercase()
                };
                for path in event.paths {
                    // History/trash churn and our own snapshot temp writes
                    // happen under hidden directories; never surface them.
                    if has_hidden_component(&path) {
                        continue;
                    }
                    let _ = app.emit(
                        "fs-change",
                        serde_json::json!({
                            "path": path.to_string_lossy(),
                            "kind": kind,
                        }),
                    );
                }
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    new_watcher
        .watch(&resolved, notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // Replacing the managed watcher drops the previous one, so a vault
    // switch stops the abandoned watcher instead of stacking a new thread.
    // A poisoned lock must not panic — return the error instead so the stale
    // watcher stays in place rather than being torn down mid-switch.
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(new_watcher);
    Ok(())
}

/// Allow the asset protocol to serve files from the vault (and its
/// attachments tree) no matter where the vault lives on disk. The static
/// `assetScope` in tauri.conf.json only covers relative patterns, so vaults
/// opened from arbitrary locations need this runtime grant.
///
/// The whole vault is allowed so images referenced by notes always resolve:
/// attachments live under `attachments/`, but pasted images may be staged under
/// `.tmp` (an unsaved tab) or written to per-note `<name>_assets/` directories
/// anywhere in the tree. The app's internal metadata trees are explicitly
/// FORBIDDEN so a content-injection attack cannot read history snapshots, trash,
/// or `.git` through `asset://` — `forbid_directory` takes precedence over
/// `allow_directory`, and this also covers platforms where the scope's dotfile
/// glob matching is off (a transitive path could otherwise reach `.nekowite`).
fn allow_vault_media(app: &tauri::AppHandle, vault_root: &str) {
    use tauri::Manager;
    let path = Path::new(vault_root).to_path_buf();
    let path = path.canonicalize().unwrap_or(path);
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(&path, true);
    for hidden in [".nekowite", ".nekowite-trash", ".git"] {
        let _ = scope.forbid_directory(path.join(hidden), true);
    }
}
