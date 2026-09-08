//! NekoWite Tauri backend.
//!
//! This crate is split into layered modules (see `docs/dev.md` §5.5):
//! - [`commands`]: the `#[tauri::command]` IPC surface — thin args/DTO/error
//!   mapping only.
//! - [`domain`]: path-confinement policy, vault rules, crash recovery.
//! - [`storage`]: file, trash, index and key stores.
//! - [`providers`]: the AI providers (client, Gemini, OpenAI-compatible).
//! - [`state`]: managed app state ([`state::VaultRegistry`], watcher, AI, keys).
//! - [`errors`]: shared user-facing error helpers.
//!
//! [`lib.rs`] itself only assembles app state and registers commands.

pub mod commands;
pub mod domain;
pub mod errors;
pub mod providers;
pub mod state;
pub mod storage;

// Re-exported at the crate root for convenience/back-compat: the vault
// registry is the authority that path-confined commands consult (and it is what
// `tests/vault_auth_test.rs` exercises).
use tauri::Manager;

pub use state::VaultRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::WatcherState::default())
        .manage(state::VaultRegistry::default())
        .manage(state::AiState::default())
        .manage(state::KeyVault::default())
        .invoke_handler(tauri::generate_handler![
            commands::fs::ping,
            commands::fs::read_file,
            commands::fs::stat_file,
            commands::fs::write_file,
            commands::fs::delete_file,
            commands::recovery::list_trash,
            commands::recovery::restore_from_trash,
            commands::recovery::clear_trash,
            commands::recovery::list_history,
            commands::recovery::read_history,
            commands::recovery::restore_history,
            commands::fs::list_dir,
            commands::fs::search_notes,
            commands::fs::save_attachment,
            commands::fs::resolve_media_path,
            commands::fs::create_dir,
            commands::fs::rename_entry,
            commands::fs::register_vault,
            commands::fs::open_folder_dialog,
            commands::fs::save_file_dialog,
            commands::fs::watch_folder,
            commands::ai::ai_complete,
            commands::ai::ai_cancel,
            commands::ai::ai_list_models,
            commands::keys::store_ai_key,
            commands::keys::load_ai_key,
            commands::keys::set_master_password,
            commands::keys::unlock_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
