pub mod ai;
pub mod fs;
pub mod keys;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;

struct WatcherState(Mutex<Option<RecommendedWatcher>>);

impl Default for WatcherState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

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
    /// Record `root` (canonicalized) as an opened vault.
    pub fn register(&self, root: &str) -> Result<PathBuf, String> {
        let canonical = canonicalize_vault_root(root)?;
        let mut set = self.0.lock().map_err(|e| e.to_string())?;
        set.insert(canonical.clone());
        Ok(canonical)
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

/// Canonicalize a vault root, rejecting relative paths the same way the fs
/// layer does.
fn canonicalize_vault_root(root: &str) -> Result<PathBuf, String> {
    let p = Path::new(root);
    if !p.is_absolute() {
        return Err("vault root must be an absolute path".into());
    }
    p.canonicalize()
        .map_err(|e| format!("vault root not accessible: {e}"))
}

fn vault_root_unauthorized_error(root: &str) -> String {
    format!(
        "vault root is not open: {root}. \
         The backend only serves paths inside a vault the user actually opened. \
         Open the vault with register_vault (or pick it again with the folder dialog) before using it."
    )
}

/// Require `root` to be a vault the user opened this session, or fail with a
/// recovery hint. Called at the top of every path-confined command.
fn require_opened_vault(registry: &VaultRegistry, root: &str) -> Result<(), String> {
    registry.authorize(root).map(|_| ())
}

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

// The frontend gateway invokes every command with snake_case argument names
// (`vault_root`, `max_history`, `trash_path`, `default_name`, `start_dir`),
// while the default `#[tauri::command]` expects camelCase — hence
// `rename_all = "snake_case"` on all of them. Commands are `async fn` so the
// blocking work (fs I/O, dialogs) runs on Tauri's worker pool instead of the
// main thread.

#[tauri::command(rename_all = "snake_case")]
async fn read_file(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::read_file(&vault_root, &path)
}

#[tauri::command(rename_all = "snake_case")]
async fn stat_file(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<fs::FileStat, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::stat_file(&vault_root, &path)
}

#[tauri::command(rename_all = "snake_case")]
async fn write_file(
    vault_root: String,
    path: String,
    content: String,
    max_history: Option<u32>,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<(), String> {
    require_opened_vault(&state, &vault_root)?;
    fs::write_file(&vault_root, &path, &content, max_history)
}

#[tauri::command(rename_all = "snake_case")]
async fn delete_file(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::delete_file(&vault_root, &path)
}

#[tauri::command(rename_all = "snake_case")]
async fn list_trash(
    vault_root: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Vec<fs::TrashEntry>, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::list_trash(&vault_root)
}

#[tauri::command(rename_all = "snake_case")]
async fn restore_from_trash(
    vault_root: String,
    trash_path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::restore_from_trash(&vault_root, &trash_path)
}

#[tauri::command(rename_all = "snake_case")]
async fn clear_trash(
    vault: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<usize, String> {
    require_opened_vault(&state, &vault)?;
    fs::clear_trash(&vault)
}

#[tauri::command(rename_all = "snake_case")]
async fn list_history(
    vault_root: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Vec<fs::HistoryEntry>, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::list_history(&vault_root, &path)
}

#[tauri::command(rename_all = "snake_case")]
async fn read_history(
    vault_root: String,
    path: String,
    id: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::read_history(&vault_root, &path, &id)
}

#[tauri::command(rename_all = "snake_case")]
async fn restore_history(
    vault_root: String,
    path: String,
    id: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::restore_history(&vault_root, &path, &id)
}

#[tauri::command(rename_all = "snake_case")]
async fn list_dir(
    vault_root: String,
    path: Option<String>,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Vec<fs::FileEntry>, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::list_dir(&vault_root, path.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
async fn search_notes(
    vault_root: String,
    query: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Vec<fs::FileEntry>, String> {
    require_opened_vault(&state, &vault_root)?;
    fs::search_notes(&vault_root, &query, 100)
}

#[tauri::command(rename_all = "snake_case")]
async fn save_attachment(
    vault: String,
    file_name: String,
    base64: String,
    dir: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    fs::save_attachment(&vault, &file_name, &base64, &dir)
}

#[tauri::command(rename_all = "snake_case")]
async fn resolve_media_path(
    vault: String,
    rel_path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    fs::resolve_media_path(&vault, &rel_path)
}

#[tauri::command(rename_all = "snake_case")]
async fn create_dir(
    vault: String,
    path: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    fs::create_dir(&vault, &path)
}

#[tauri::command(rename_all = "snake_case")]
async fn rename_entry(
    vault: String,
    from: String,
    to: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<String, String> {
    require_opened_vault(&state, &vault)?;
    fs::rename_entry(&vault, &from, &to)
}

/// Register a vault root the user opened. Call this right after the user picks
/// a vault (folder dialog) or restores a previously opened one, BEFORE any
/// path-confined command, so the backend will serve it. This is the authority
/// that lets path-confined commands distinguish "a vault the user opened" from
/// arbitrary absolute paths.
#[tauri::command(rename_all = "snake_case")]
fn register_vault(
    vault_root: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<(), String> {
    state.register(&vault_root).map(|_| ())
}

#[tauri::command]
async fn open_folder_dialog(
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
async fn save_file_dialog(
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

#[tauri::command(rename_all = "snake_case")]
async fn watch_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    vault_registry: tauri::State<'_, VaultRegistry>,
    vault_root: String,
    path: Option<String>,
) -> Result<(), String> {
    require_opened_vault(&vault_registry, &vault_root)?;
    allow_vault_media(&app, &vault_root);
    let resolved = match path {
        Some(p) => fs::resolve_within(&vault_root, &p)?,
        None => fs::resolve_within(&vault_root, ".")?,
    };
    let mut new_watcher = RecommendedWatcher::new(
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
        .watch(&resolved, RecursiveMode::Recursive)
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
    let path = std::path::PathBuf::from(vault_root);
    let path = path.canonicalize().unwrap_or(path);
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(&path, true);
    for hidden in [".nekowite", ".nekowite-trash", ".git"] {
        let _ = scope.forbid_directory(path.join(hidden), true);
    }
}

/// True when any path component starts with `.`, i.e. the path is a hidden
/// file or lives under a hidden directory (`.nekowite`, `.nekowite-trash`,
/// `.git`, ...). Only real `Normal` components count, so `.`-relative
/// spellings and the root separator do not trip the filter.
pub fn has_hidden_component(p: &std::path::Path) -> bool {
    p.components().any(|c| match c {
        std::path::Component::Normal(s) => {
            s.to_str().map(|s| s.starts_with('.')).unwrap_or(false)
        }
        _ => false,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState::default())
        .manage(VaultRegistry::default())
        .manage(ai::AiState::default())
        .manage(keys::KeyVault::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            read_file,
            stat_file,
            write_file,
            delete_file,
            list_trash,
            restore_from_trash,
            clear_trash,
            list_history,
            read_history,
            restore_history,
            list_dir,
            search_notes,
            save_attachment,
            resolve_media_path,
            create_dir,
            rename_entry,
            register_vault,
            open_folder_dialog,
            save_file_dialog,
            watch_folder,
            ai::ai_complete,
            ai::ai_cancel,
            ai::ai_list_models,
            keys::store_ai_key,
            keys::load_ai_key,
            keys::set_master_password,
            keys::unlock_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
