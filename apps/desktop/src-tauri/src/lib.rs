//! NekoWite Tauri backend.
//!
//! This crate is split into layered modules (see `docs/dev.md` §5.5):
//! - [`agent_runtime`]: the agent engine — its process, the ACP connection, the
//!   sessions, the permission table. It knows nothing about Tauri; the commands
//!   below are the only thing that reaches it from a window.
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

pub mod agent_runtime;
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

use crate::domain::app_owned::AppDir;

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
            //
            // It is NOT this process's `argv`, though, and the difference is the
            // whole of what the arguments may do. The plugin serves
            // `ExecuteCallback(argv, cwd)` at the session bus with no
            // peer-credential check, so any process running as this user can call
            // it with any path at all — an assertion by the caller, where the
            // command line below is a fact about what launched this process.
            // `SessionBus` says exactly that: a file inside a vault the user has
            // already authorised opens, and one from outside every vault is
            // refused rather than adopting its folder as a new root.
            open_file::handle_launch(
                app,
                args,
                Path::new(&cwd),
                open_file::LaunchChannel::SessionBus,
            );
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(open_file::PendingOpen::default())
        .manage(state::WatcherState::default())
        .manage(state::VaultRegistry::default())
        .manage(state::AiState::default())
        .manage(state::KeyVault::default())
        // The agent subsystem's handle: the engine definitions and the one
        // running engine, both empty until a session is started. Registered
        // here rather than by whoever starts it, because this file is the app's
        // assembly point and a second writer of it is a merge that compiles and
        // wires the wrong thing; what a later start path does is *fill* the two
        // slots and `manage` its own IPC state, neither of which touches this
        // list.
        .manage(state::AgentRuntimeState::default())
        .setup(|app| {
            // The folders the app's own files live in, before a window exists
            // to ask for them: the config directory the remembered-vault record
            // is written in, and the data directory the key files are written
            // in. Each is named by the module that owns it rather than by a
            // second list here — a vault can CONTAIN either (the folder dialog
            // returns `~/.config` as readily as a notes directory), and every
            // path-confined command serves whatever lies inside the vault it was
            // given, so those two files would be ordinary vault files to a
            // window that went looking for them. `domain::app_owned` is where
            // they are refused.
            let mut owned = Vec::new();
            match state::remembered_vault_dir(app.handle()) {
                Some(dir) => owned.push((AppDir::Configuration, dir)),
                // Reported rather than swallowed: a folder that does not make
                // it into this list is not refused. The app is already degraded
                // without it — the record cannot be read or written either — but
                // which of the two happened is worth a line in the log.
                None => eprintln!("could not resolve the app configuration directory"),
            }
            match storage::key_store::data_dir(app.handle()) {
                Ok(dir) => owned.push((AppDir::Data, dir)),
                Err(e) => eprintln!("could not resolve the app data directory: {e}"),
            }
            domain::app_owned::install(owned);
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
            // `argv`, before any window or listener exists. That is this
            // process's own command line — evidence only whatever started this
            // process could have produced — which is what makes it enough to
            // adopt an outside file's folder as the vault. It is resolved and
            // left in managed state — which is also where a later launch's file
            // goes — for the window to collect once its startup has settled.
            let cwd = std::env::current_dir().unwrap_or_default();
            open_file::handle_launch(
                app.handle(),
                std::env::args_os(),
                &cwd,
                open_file::LaunchChannel::CommandLine,
            );
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
            // The agent commands. Both address `AgentIpcState`, which is managed
            // by whoever starts the engine rather than here (see
            // `state::AgentRuntimeState`), so until a runtime has been started an
            // invoke of either is refused with Tauri's own "state not managed for
            // field `state` on command …" — a rejected promise naming the command
            // that is missing its state, not a silent no-op and not a panic
            // (`tauri 2.11.5`, `src/state.rs`, `State::from_command`).
            commands::agent::agent_permission_answer,
            commands::agent::agent_cancel_run,
        ])
        .run(context)
        .expect("error while running tauri application");
}
