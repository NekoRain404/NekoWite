//! Filesystem commands: the `#[tauri::command]` IPC surface for vault file
//! operations, vault registration and native dialogs.
//!
//! Each command deserializes its snake_case args, proves the vault was opened
//! this session, calls one storage/domain function, and maps the error. All
//! command names, request/response DTOs and error strings are unchanged from
//! the pre-split layout.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use notify::Watcher;
use tauri::{Emitter, Manager};

use crate::domain::path_policy::{
    has_hidden_component, ipc_path, resolve_within, resolve_within_rel,
};
use crate::state::{
    remember_vault, remembered_vault, require_opened_vault, VaultRegistry, WatcherState,
};
use crate::storage::file_store::{self, FileEntry, FileStat};
use crate::storage::trash_store;

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
    expected_content: Option<String>,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<Option<String>, String> {
    require_opened_vault(&state, &vault_root)?;
    // `Some(warning)` = the text was written, but something optional around it
    // failed (currently: the history snapshot). The window shows it; it must not
    // be mistaken for a failed save.
    crate::storage::save_store::write_file_guarded(
        &vault_root,
        &path,
        &content,
        max_history,
        expected_content.as_deref(),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn create_new_file(
    vault_root: String,
    path: String,
    content: String,
    state: tauri::State<'_, VaultRegistry>,
) -> Result<(), String> {
    require_opened_vault(&state, &vault_root)?;
    file_store::create_new_file(&vault_root, &path, &content)
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
///
/// The authority is not the call itself. A path arrives here from the window,
/// so the window could ask for `/etc` as easily as for the user's notes; what
/// makes a root servable is that the USER chose it — in the native folder
/// dialog this session, or as the vault the backend recorded last time
/// ([`remembered_vault`]). A root that is neither is refused, and the root that
/// gets through is recorded for the next launch.
#[tauri::command(rename_all = "snake_case")]
pub fn register_vault(
    vault_root: String,
    state: tauri::State<'_, VaultRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let remembered = remembered_vault(&app);
    let canonical = state.register(&vault_root, remembered.as_deref())?;
    // Only a root that got through `register` is written down, so the record
    // can never vouch for a root this function refused.
    remember_vault(&app, &canonical);
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
    at: Instant,
}

/// Pull every burst that has been quiet for [`COALESCE_WINDOW`].
fn take_settled_pending(
    pending: &mut HashMap<String, PendingBurst>,
    now: Instant,
) -> Vec<(String, PendingBurst)> {
    let keys: Vec<String> = pending
        .iter()
        .filter(|(_, p)| now.duration_since(p.at) >= COALESCE_WINDOW)
        .map(|(k, _)| k.clone())
        .collect();
    keys.into_iter()
        .filter_map(|k| pending.remove(&k).map(|p| (k, p)))
        .collect()
}

fn emit_fs_change(app: &tauri::AppHandle, path: &str, kind: &str) {
    let _ = app.emit(
        "fs-change",
        serde_json::json!({ "path": path, "kind": kind }),
    );
}

/// After the last notify event of a burst there may be no further callback, so
/// a held trailing event would sit forever. Sleep one window and emit it if it
/// is still the latest pending event for that path.
///
/// `observed_gen` is the generation read when the task was scheduled, not the
/// generation the enclosing `watch_folder` call handed out: a `watch_folder`
/// that FAILS (inotify watch limit, directory removed between resolve and
/// watch) leaves the previous watcher installed, so only a watcher that was
/// actually replaced may invalidate the tasks of the one still running.
fn schedule_pending_flush(
    app: tauri::AppHandle,
    pending: Arc<Mutex<HashMap<String, PendingBurst>>>,
    recent: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    generation: Arc<std::sync::atomic::AtomicU64>,
    observed_gen: u64,
    ipc: String,
    expected_at: Instant,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(COALESCE_WINDOW).await;
        if generation.load(Ordering::SeqCst) != observed_gen {
            return;
        }
        let Ok(mut pending) = pending.lock() else {
            return;
        };
        let Some(p) = pending.get(&ipc) else { return };
        if p.at != expected_at {
            return;
        }
        if Instant::now().duration_since(p.at) < COALESCE_WINDOW {
            return;
        }
        let p = pending.remove(&ipc).expect("entry was present");
        drop(pending);
        if let Ok(mut recent) = recent.lock() {
            recent.insert(ipc.clone(), (p.kind.clone(), Instant::now()));
        }
        emit_fs_change(&app, &ipc, &p.kind);
    });
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
    let recent: Arc<Mutex<HashMap<String, (String, Instant)>>> =
        Arc::new(Mutex::new(HashMap::new()));
    // Events held for the trailing edge of a burst, keyed by path. A burst is
    // reported once when it stops, so the LAST write of a rapid sequence is what
    // subscribers see. Shared with a timer because a quiet tail has no further
    // notify callback to flush it.
    let pending: Arc<Mutex<HashMap<String, PendingBurst>>> = Arc::new(Mutex::new(HashMap::new()));
    let generation = state.generation.clone();
    // The watcher root, canonical, so the hidden-component filter can be applied
    // to the path RELATIVE to the vault. Applying it to the absolute path meant a
    // vault living in a dot-directory (`~/.notes`) filtered out every event it
    // would ever produce — the whole vault looked unmodified to the app, so
    // external edits were never noticed and the next save overwrote them.
    let watch_root = resolved.clone();
    let recent_cb = recent.clone();
    let pending_cb = pending.clone();
    let generation_cb = generation.clone();
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
            let now = Instant::now();
            let Ok(mut recent) = recent_cb.lock() else {
                return;
            };
            let Ok(mut pending) = pending_cb.lock() else {
                return;
            };
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
                        ipc.clone(),
                        PendingBurst {
                            kind: kind.to_string(),
                            at: now,
                        },
                    );
                    schedule_pending_flush(
                        app.clone(),
                        pending_cb.clone(),
                        recent_cb.clone(),
                        generation_cb.clone(),
                        // Read at schedule time: if a later `watch_folder`
                        // installs a new watcher, this task retires.
                        generation_cb.load(Ordering::SeqCst),
                        ipc,
                        now,
                    );
                    continue;
                }
                recent.insert(ipc.clone(), (kind.to_string(), now));
                // This event supersedes any burst held for the same path. Leaving
                // the older entry armed let its flush task re-emit a stale kind
                // once the timer fired — `removed` arriving AFTER the file was
                // re-created, with no further event to correct it — and the
                // index/notes list would drop a file that is back on disk.
                pending.remove(&ipc);
                emit_fs_change(&app, &ipc, kind);
            }
            // Trailing edge: a burst that has been quiet for the full window is
            // over, so its final event goes out now. This is what makes a rapid
            // pair of external writes end with an event for the FINAL content.
            for (ipc, p) in take_settled_pending(&mut pending, now) {
                // Only the kind is re-emitted, so a held `removed` after a
                // `modified` still tells the window the file is gone.
                recent.insert(ipc.clone(), (p.kind.clone(), now));
                emit_fs_change(&app, &ipc, &p.kind);
            }
            // Bounded growth: a long session over a busy vault would otherwise
            // keep one entry per touched path forever.
            if recent.len() > 512 {
                recent.retain(|_, (_, at)| now.duration_since(*at) < COALESCE_WINDOW);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| format!("could not start watching {}: {e}", ipc_path(&resolved)))?;
    new_watcher
        .watch(&resolved, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("could not watch {}: {e}", ipc_path(&resolved)))?;
    // Retire the previous generation only now that this watcher actually exists.
    // Bumping before the fallible setup meant a FAILED call (inotify watch limit
    // exhausted, directory removed between resolve and watch) invalidated the
    // flush tasks of the watcher still installed, so its quiet tail was never
    // emitted and the next save overwrote the external edit.
    generation.fetch_add(1, Ordering::SeqCst);
    // Replacing the managed watcher drops the previous one, so a vault
    // switch stops the abandoned watcher instead of stacking a new thread.
    // A poisoned lock must not panic — return the error instead so the stale
    // watcher stays in place rather than being torn down mid-switch.
    let mut guard = state.watcher.lock().map_err(|e| e.to_string())?;
    *guard = Some(new_watcher);
    Ok(())
}

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

#[cfg(test)]
mod change_coalescing_tests {
    use super::{should_emit_change, take_settled_pending, PendingBurst, COALESCE_WINDOW};
    use std::collections::HashMap;
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

    #[test]
    fn take_settled_pending_emits_the_quiet_tail() {
        let t0 = Instant::now();
        let mut pending = HashMap::new();
        pending.insert(
            "a.md".into(),
            PendingBurst {
                kind: "modified".into(),
                at: t0,
            },
        );
        pending.insert(
            "b.md".into(),
            PendingBurst {
                kind: "created".into(),
                at: t0 + COALESCE_WINDOW,
            },
        );
        let settled = take_settled_pending(&mut pending, t0 + COALESCE_WINDOW);
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].0, "a.md");
        assert_eq!(settled[0].1.kind, "modified");
        assert!(pending.contains_key("b.md"));
    }
}
