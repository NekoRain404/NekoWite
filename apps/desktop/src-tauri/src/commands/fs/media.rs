//! The media grant: which files `asset://` may serve, and how the one command that extends the
//! asset scope decides.
//!
//! **This file was split out of `commands/fs.rs`.** One subject: the asset protocol's allow-set and
//! the two checks in front of it. It changes when the protocol's scope behaviour changes, when a
//! hidden-name or extension rule changes, or when the vault authority does — and not when a
//! dialog, a note write or the watcher does.
//!
//! Every comment below survived the move verbatim, and it is the reason this file exists as its own
//! subject rather than sitting beside the command that calls it: the reasoning for "one file at a
//! time, never a directory" is a security boundary, and a boundary is worth keeping where the next
//! person to widen it will read it.

use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::domain::path_policy::{ipc_path, resolve_within_rel};
use crate::state::{require_opened_vault, VaultRegistry};
use crate::storage::file_store;

/// Directory the app stages images in while the note that pasted them has no
/// path yet. It is the ONE hidden name the asset scope may reach through; see
/// [`asset_media_grant`].
const MEDIA_STAGING_DIR: &str = ".tmp";

/// The single file the asset protocol may serve for one media reference, or the
/// reason it may not.
///
/// This is the whole allow-set. `asset://` has no IPC guard in front of it —
/// whatever the scope allows, the webview reads — so the scope is never
/// extended by a directory, a tree or a glob: one `allow_file` per resolved
/// reference, and a note can therefore only ever pull the pictures it actually
/// names. That also makes revocation unnecessary, which matters because this
/// scope cannot revoke: `allow_file`/`allow_directory` only ever append, and
/// `forbid_*` is a permanent denial that a later allow cannot undo (a previous
/// attempt that forbade the vault being left broke every image in it for the
/// rest of the session after A → B → A). Granting one file at a time leaves
/// nothing that needs taking back — a vault the user leaves stops being
/// extended, and no tree-wide grant exists to outlive it.
///
/// `tauri.conf.json`'s `assetProtocol.scope` is empty on purpose: it held
/// `attachments/**`, which granted nothing (a configured pattern stays relative,
/// the path is canonicalized) but would have handed every vault's attachment
/// tree to the protocol had it matched — `tests/asset_config_scope_test.rs`.
///
/// What is refused, and why it is refused here rather than by the scope: the
/// vault's own bookkeeping (`.nekowite`, `.nekowite-trash`, `.git`), the user's
/// dotfiles (`.env`, `.ssh`), ordinary notes and configuration — none of them
/// is a media file, and the protocol must not become a second, unguarded read
/// path for content that `read_file` guards. Path traversal, symlinks out of
/// the vault and a vault that is not the one open are already rejected by
/// [`resolve_within_rel`].
pub fn asset_media_grant(vault_root: &str, rel_path: &str) -> Result<PathBuf, String> {
    let (absolute, relative) = resolve_within_rel(vault_root, rel_path)?;
    // Hidden names first, so the answer for `.nekowite/history/x.png` is about
    // the folder it lives in rather than about its extension. The file's own
    // name is never allowed to be hidden (`.env` and `.gitignore` are not
    // pictures), and the ONLY hidden folder that may be traversed is the app's
    // own staging directory, at the top level, where a paste waits for the note
    // that pasted it to get a path.
    let parts: Vec<&str> = relative.split('/').collect();
    if let Some((name, folders)) = parts.split_last() {
        if name.starts_with('.') {
            return Err(format!(
                "refusing to serve a hidden file through asset://: {relative}"
            ));
        }
        for (depth, folder) in folders.iter().enumerate() {
            if folder.starts_with('.') && !(depth == 0 && *folder == MEDIA_STAGING_DIR) {
                return Err(format!(
                    "refusing to serve a file inside {folder}/ through asset://: {relative}"
                ));
            }
        }
    }
    // The extension decides: the app's own image allowlist is the set of files
    // the importer will put in a vault and the editor will display, so it is
    // also the set worth serving. Notes, configuration and metadata are not on
    // it and are therefore not reachable this way at all.
    if !file_store::is_importable_image(Path::new(&relative)) {
        return Err(format!(
            "refusing to serve {relative}: asset:// only serves media files"
        ));
    }
    if !absolute.is_file() {
        return Err(format!("media file not found: {relative}"));
    }
    Ok(absolute)
}

/// The IPC-boundary guard for `resolve_media_path`: the vault must be one the
/// user opened, and the reference must be a media file inside it.
pub fn authorized_media_grant(
    registry: &VaultRegistry,
    vault_root: &str,
    rel_path: &str,
) -> Result<PathBuf, String> {
    require_opened_vault(registry, vault_root)?;
    asset_media_grant(vault_root, rel_path)
}

/// Extend the asset protocol by exactly this file.
///
/// A scope that cannot be narrowed is only safe if it is never widened: the
/// grant is the file the app just resolved, never the folder holding it, so
/// there is no tree grant to revoke when the vault changes. The residue is the
/// resolved files themselves, which stay servable for the session — the same
/// files the user was already looking at, and nothing that a scope-level
/// revocation could have taken back anyway (see [`asset_media_grant`]).
fn allow_media_file(app: &tauri::AppHandle, path: &Path) {
    let _ = app.asset_protocol_scope().allow_file(path);
}

/// Resolve a media reference to the absolute path the frontend turns into an
/// `asset://` URL.
///
/// This command is also the only thing that ever extends the asset scope: the
/// file it is about to hand out is the one file the protocol is allowed to
/// serve (see [`allow_media_file`]). Because of that it must be at least as
/// strict as the protocol itself, which is why the vault is proven first, then
/// the path, the extension and the hidden-component rules are applied here —
/// and why a file that is not a media file is refused rather than resolved.
#[tauri::command(rename_all = "snake_case")]
pub async fn resolve_media_path(
    vault: String,
    rel_path: String,
    state: tauri::State<'_, VaultRegistry>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let granted = authorized_media_grant(&state, &vault, &rel_path)?;
    allow_media_file(&app, &granted);
    Ok(ipc_path(&granted))
}
