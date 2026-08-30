pub mod ai;
pub mod fs;
pub mod keys;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::Mutex;
use tauri::Emitter;

struct WatcherState(Mutex<Option<RecommendedWatcher>>);

impl Default for WatcherState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn read_file(vault_root: String, path: String) -> Result<String, String> {
    fs::read_file(&vault_root, &path)
}

#[tauri::command]
fn write_file(vault_root: String, path: String, content: String) -> Result<(), String> {
    fs::write_file(&vault_root, &path, &content)
}

#[tauri::command]
fn list_dir(vault_root: String, path: Option<String>) -> Result<Vec<fs::FileEntry>, String> {
    fs::list_dir(&vault_root, path.as_deref())
}

#[tauri::command]
fn open_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string());
    Ok(picked)
}

#[tauri::command]
fn save_file_dialog(
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

#[tauri::command]
fn watch_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    vault_root: String,
    path: Option<String>,
) -> Result<(), String> {
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
    *state.0.lock().unwrap() = Some(new_watcher);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_stronghold::Builder::new(|password: &str| {
                use sha2::{Digest, Sha256};
                let mut hasher = Sha256::new();
                hasher.update(password.as_bytes());
                hasher.finalize().to_vec()
            })
            .build(),
        )
        .manage(WatcherState::default())
        .manage(ai::AiState::default())
        .manage(keys::KeyVault::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            read_file,
            write_file,
            list_dir,
            open_folder_dialog,
            save_file_dialog,
            watch_folder,
            ai::ai_complete,
            ai::ai_cancel,
            keys::store_ai_key,
            keys::load_ai_key,
            keys::set_master_password
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
