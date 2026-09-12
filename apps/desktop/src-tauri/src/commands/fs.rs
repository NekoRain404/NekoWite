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
) -> Result<Option<String>, String> {
    require_opened_vault(&state, &vault_root)?;
    // `Some(warning)` = the text was written, but something optional around it
    // failed (currently: the history snapshot). The window shows it; it must not
    // be mistaken for a failed save.
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

/// How long a quiet period must last before a burst is considered over.
const COALESCE_WINDOW: std::time::Duration = std::time::Duration::from_millis(150);

/// Whether an event that already arrived for a pending burst should be
/// forwarded, i.e. whether this path should be reported NOW.
///
/// The previous version of this was leading-edge — it forwarded the first event
/// and dropped everything for the same path and kind inside the window, without
/// refreshing the timestamp. That silently discarded the *later* half of a burst,
/// and the later half is the one that matters: two external writes 50 ms apart
/// produced one event for the content in between, so an open note reloaded to a
/// state that was already stale and then nothing ever arrived to correct it —
/// until the user saved, overwriting the newer external text with the stale copy.
///
/// Now the first event is forwarded immediately (so a single edit is still
/// instant) and any follow-up within the window is *held* — the caller re-emits
/// it after the burst goes quiet, which means the last state always reaches
/// subscribers.
fn should_emit_change(
    last: Option<&(String, std::time::Instant)>,
    kind: &str,
    now: std::time::Instant,
) -> bool {
    match last {
        Some((last_kind, at)) => last_kind != kind || now.duration_since(*at) >= COALESCE_WINDOW,
        None => true,
    }
}

/// A burst awaiting its trailing edge: the event to re-emit once the burst goes
/// quiet, and when that quiet period started.
struct PendingBurst {
    kind: String,
    at: std::time::Instant,
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
    // `notify` reports one logical write as a BURST of events: a plain write
    // arrives as two identical `modified` events, and an atomic
    // write-temp-then-rename arrives as `removed` + `created`/`modified` for the
    // same path. Forwarding every one of them makes every subscriber redo its
    // work (the open document re-reads and re-diffs the file, the index
    // coordinator re-parses it), and a replacement could even be misread as a
    // deletion. Collapse identical events for the same path inside a short
    // window; a different kind, or the same kind later, still gets through, so
    // no real change is hidden.
    let mut recent: std::collections::HashMap<String, (String, std::time::Instant)> =
        std::collections::HashMap::new();
    // Events held for the trailing edge of a burst, keyed by path. A burst is
    // reported once when it stops, so the LAST write of a rapid sequence is what
    // subscribers see.
    let mut pending: std::collections::HashMap<String, PendingBurst> =
        std::collections::HashMap::new();
    // The watcher root, canonical, so the hidden-component filter can be applied
    // to the path RELATIVE to the vault. Applying it to the absolute path meant a
    // vault living in a dot-directory (`~/.notes`) filtered out every event it
    // would ever produce — the whole vault looked unmodified to the app, so
    // external edits were never noticed and the next save overwrote them.
    let watch_root = resolved.clone();
    let mut new_watcher = notify::RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(event) => event,
                Err(e) => {
                    // A watcher error means events are being LOST — the handle
                    // may be exhausted or the OS queue overflowed. Staying quiet
                    // left the app believing it was watching while external
                    // changes went unseen; ask the window to resynchronise by
                    // re-reading what it has open.
                    let _ = app.emit(
                        "fs-change",
                        serde_json::json!({
                            "path": crate::domain::path_policy::ipc_path(&watch_root),
                            "kind": "resync",
                            "error": e.to_string(),
                        }),
                    );
                    return;
                }
            };
            let kind = if event.kind.is_create() {
                "created"
            } else if event.kind.is_modify() {
                "modified"
            } else if event.kind.is_remove() {
                "removed"
            } else {
                return;
            };
            let now = std::time::Instant::now();
            for path in event.paths {
                // History/trash churn and our own snapshot temp writes
                // happen under hidden directories; never surface them. The
                // check is relative to the watch root so a dot-directory
                // ANCESTOR of the vault is not mistaken for a hidden subtree.
                let rel = path
                    .strip_prefix(&watch_root)
                    .map(|r| r.to_path_buf())
                    .unwrap_or_else(|_| path.clone());
                if has_hidden_component(&rel) {
                    continue;
                }
                // Same spelling as `list_dir` (see `ipc_path`); a
                // verbatim-prefixed path here never equaled the tab path, so
                // an external edit was silently ignored.
                let ipc = crate::domain::path_policy::ipc_path(&path);
                if !should_emit_change(recent.get(&ipc), kind, now) {
                    // Inside the window: hold it instead of dropping it. The
                    // last write in a burst is the one whose content is on disk,
                    // so this is the event subscribers actually need.
                    pending.insert(
                        ipc,
                        PendingBurst {
                            kind: kind.to_string(),
                            at: now,
                        },
                    );
                    continue;
                }
                recent.insert(ipc.clone(), (kind.to_string(), now));
                let _ = app.emit(
                    "fs-change",
                    serde_json::json!({ "path": ipc, "kind": kind }),
                );
            }
            // Trailing edge: a burst that has been quiet for the full window is
            // over, so its final event goes out now. This is what makes a rapid
            // pair of external writes end with an event for the FINAL content.
            let settled: Vec<String> = pending
                .iter()
                .filter(|(_, p)| now.duration_since(p.at) >= COALESCE_WINDOW)
                .map(|(k, _)| k.clone())
                .collect();
            for ipc in settled {
                if let Some(p) = pending.remove(&ipc) {
                    // Only the kind is re-emitted, so a held `removed` after a
                    // `modified` still tells the window the file is gone.
                    recent.insert(ipc.clone(), (p.kind.clone(), now));
                    let _ = app.emit(
                        "fs-change",
                        serde_json::json!({ "path": ipc, "kind": p.kind }),
                    );
                }
            }
            // Bounded growth: a long session over a busy vault would otherwise
            // keep one entry per touched path forever.
            if recent.len() > 512 {
                recent.retain(|_, (_, at)| now.duration_since(*at) < COALESCE_WINDOW);
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

#[cfg(test)]
mod change_coalescing_tests {
    use super::{should_emit_change, COALESCE_WINDOW};
    use std::time::Instant;

    fn last(kind: &str, at: Instant) -> (String, Instant) {
        (kind.to_string(), at)
    }

    #[test]
    fn first_event_for_a_path_is_always_forwarded() {
        assert!(should_emit_change(None, "modified", Instant::now()));
    }

    #[test]
    fn the_duplicate_notify_delivers_for_one_write_is_dropped() {
        // Windows reports a single write as two identical `modified` events.
        let t0 = Instant::now();
        let previous = last("modified", t0);
        assert!(!should_emit_change(
            Some(&previous),
            "modified",
            t0 + std::time::Duration::from_millis(1)
        ));
    }

    #[test]
    fn a_replacement_burst_still_reaches_subscribers() {
        // An atomic write is `removed` then `created`/`modified` for one path:
        // different kinds, so both are forwarded and the file is never left
        // looking deleted.
        let t0 = Instant::now();
        let removed = last("removed", t0);
        assert!(should_emit_change(
            Some(&removed),
            "created",
            t0 + std::time::Duration::from_millis(2)
        ));
    }

    #[test]
    fn the_same_kind_later_is_a_new_edit() {
        let t0 = Instant::now();
        let previous = last("modified", t0);
        assert!(should_emit_change(
            Some(&previous),
            "modified",
            t0 + COALESCE_WINDOW
        ));
    }
}
