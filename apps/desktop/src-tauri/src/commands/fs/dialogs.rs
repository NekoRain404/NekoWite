//! The native dialogs: opening a vault folder, choosing where to save a file, and picking the
//! images an attachment is imported from.
//!
//! **This file was split out of `commands/fs.rs`.** One subject: a file chooser the OS puts in
//! front of the user, and the filter policy each one applies to what it hands back. It changes
//! when a dialog's shape or its filter does — not when the commands that write the chosen file do.
//!
//! What the folder dialog is *for* is not this file's decision. `open_folder_dialog` proves the
//! pick with [`VaultRegistry::approve_pick`] and returns it; registering the root stays
//! `commands/fs/vaults.rs`'s, argued at length in that file's header. The pick is the one thing
//! this command must do to the registry, because the OS dialog is the gesture that makes it a
//! user's choice at all.

use crate::state::VaultRegistry;
use crate::storage::file_store;

use super::picked::PickedImages;

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
    if let Some(path) = &picked {
        // The user pointed at this folder in the OS dialog: that is the gesture
        // `register_vault` needs. A pick the policy cannot use (a folder that
        // does not canonicalize) is simply not recorded, and `register` will
        // refuse it with a message that says why.
        let _ = state.approve_pick(path);
    }
    // Registration deliberately does NOT happen here, even though the native
    // dialog is a genuine user gesture.
    //
    // `VaultRegistry::register` REPLACES the authorized root, so registering at
    // pick time de-authorizes the vault still on screen. The frontend's switch
    // (`applyVault`) flushes the outgoing vault's dirty tabs BEFORE it registers
    // the new one — and that flush writes to the outgoing root. Registering here
    // therefore made the flush fail with "vault root not opened", which aborts
    // the switch while leaving the UI on a vault the backend now refuses: every
    // Ctrl+S, autosave, read and history restore failed until it was re-picked.
    //
    // Every pick path (sidebar, settings, startup) funnels into `applyVault`,
    // which calls `register_vault` — the command that authorizes the root and
    // extends the asset scope — once the switch is actually committed.
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
    let mut builder = app.dialog().file().set_file_name(&default_name);
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
///
/// **This is the only thing that mints an import grant**, and it does so for exactly the paths it
/// is about to return: `import_attachment` copies a path the user chose here and refuses every
/// other one (finding S4 in `docs/audits/2026-09-21-code-review.md` — see `picked.rs` for why the
/// grant is a set of paths rather than a token beside each one).
#[tauri::command(rename_all = "snake_case")]
pub async fn pick_image_files(
    app: tauri::AppHandle,
    picked: tauri::State<'_, PickedImages>,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_dialog::FilePath;
    let chosen = app
        .dialog()
        .file()
        .add_filter("Images", file_store::IMPORT_IMAGE_EXTENSIONS)
        .blocking_pick_files();
    let Some(paths) = chosen else {
        return Ok(Vec::new());
    };
    let paths: Vec<std::path::PathBuf> = paths
        .into_iter()
        .filter_map(|p| match p {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
        .filter(|p| file_store::is_importable_image(p))
        .collect();
    // Minted before the answer is built, and from the same vector: a path this command returned but
    // did not grant would be an import the user asked for and the backend refused.
    picked.mint(paths.iter().cloned());
    Ok(paths
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}
