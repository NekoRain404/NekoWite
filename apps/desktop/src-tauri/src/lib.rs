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
//! [`lib.rs`] itself only assembles app state, builds the main window and
//! registers commands.

pub mod commands;
pub mod domain;
pub mod errors;
pub mod open_file;
pub mod providers;
pub mod state;
pub mod storage;

// Re-exported at the crate root for convenience/back-compat: the vault
// registry is the authority that path-confined commands consult (and it is what
// `tests/vault_auth_test.rs` exercises).
use std::path::Path;

use tauri::Manager;

pub use state::VaultRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();

    // Tauri builds the windows declared in `tauri.conf.json` itself, through a
    // builder this crate never gets to see. The editor's right-click Paste needs
    // that builder: WebKit gates the clipboard behind
    // `WebKitSettings:javascript-can-access-clipboard`, which surfaces as
    // `enable_clipboard_access()` — a builder-only method, with no key in
    // `WindowConfig` to reach it from the config file. Marking the config windows
    // as not auto-created hands the build to `setup` below, so the definition
    // itself (title, size, decorations) stays where it is and only the build
    // moves.
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // A second launch is how a file manager opens a `.md` in an app that
            // is already running, so this `argv` is where the file is. It used to
            // be thrown away here, and with it every double-click made while the
            // app was open.
            open_file::handle_launch(app, args, Path::new(&cwd));
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(open_file::PendingOpen::default())
        .manage(state::WatcherState::default())
        .manage(state::VaultRegistry::default())
        .manage(state::AiState::default())
        .manage(state::KeyVault::default())
        .setup(|app| {
            // The windows `run` above took over from Tauri's own pass, built
            // from their config so nothing about them is duplicated here.
            for config in app.config().app.windows.iter().filter(|w| !w.create) {
                tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
                    // What makes right-click Paste possible at all: with the
                    // setting off, `document.execCommand('paste')` returns false
                    // and `navigator.clipboard.readText()` rejects
                    // `NotAllowedError`, driver gesture or not.
                    .enable_clipboard_access()
                    .build()?;
            }
            // `nekowite notes.md`: the first launch's file arrives in our own
            // `argv`, before any window or listener exists. It is resolved and
            // left in managed state — which is also where a later launch's file
            // goes — for the window to collect once its startup has settled.
            let cwd = std::env::current_dir().unwrap_or_default();
            open_file::handle_launch(app.handle(), std::env::args_os(), &cwd);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_file,
            commands::fs::stat_file,
            commands::fs::write_file,
            commands::fs::create_new_file,
            commands::fs::delete_file,
            commands::recovery::list_trash,
            commands::recovery::restore_from_trash,
            commands::recovery::clear_trash,
            commands::recovery::list_history,
            commands::recovery::read_history,
            commands::recovery::restore_history,
            commands::fs::list_dir,
            commands::fs::save_attachment,
            commands::fs::resolve_media_path,
            commands::fs::create_dir,
            commands::fs::rename_entry,
            commands::fs::register_vault,
            commands::fs::open_folder_dialog,
            commands::fs::save_file_dialog,
            commands::fs::pick_image_files,
            commands::fs::import_attachment,
            commands::fs::watch_folder,
            commands::ai::ai_complete,
            commands::ai::ai_cancel,
            commands::ai::ai_list_models,
            commands::keys::store_ai_key,
            commands::keys::load_ai_key,
            commands::keys::set_master_password,
            commands::keys::unlock_vault,
            commands::system::system_accent_color,
            commands::open::take_pending_open,
        ])
        .run(context)
        .expect("error while running tauri application");
}
