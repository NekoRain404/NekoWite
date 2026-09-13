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
use tauri::Emitter;

use crate::domain::path_policy::{has_hidden_component, ipc_path, resolve_within};
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
pub async fn open_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string());
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

    // The vault being LEFT is deliberately NOT revoked, and this is the second
    // attempt at that idea — the first one was reverted for breaking the app.
    //
    // tauri's scope keeps `allowed_patterns` and `forbidden_patterns` in two
    // disjoint sets, and `is_allowed` consults the forbidden set FIRST and
    // returns false regardless of any allowance: its own documentation says a
    // forbidden path "gets denied always". So forbidding the previous root is
    // not a revocation that a later `allow_directory` can undo — after A → B → A
    // the forbid on A is still in force, and every image in A 403s for the rest
    // of the session. The scope exposes no way to remove a pattern, so there is
    // no reversible revocation to build with this API.
    //
    // The cost of leaving it: a vault the user has left stays readable through
    // `asset://` until the app exits. That is a same-user, same-session exposure
    // that needs something already running in the webview to exploit, and it is
    // strictly better than silently breaking every image in a vault the user
    // re-opens.
    let _ = scope.allow_directory(&path, true);
    for hidden in FORBIDDEN_METADATA_DIRS {
        let _ = scope.forbid_directory(path.join(hidden), true);
    }
    // A vault opened inside this vault keeps its OWN `.nekowite`/`.git` at its
    // own root, which the three forbids above (all rooted at the vault root) do
    // not cover.
    for nested in nested_metadata_dirs(&path) {
        let _ = scope.forbid_directory(nested, true);
    }
}

/// Directory names that must never be readable through `asset://`: history
/// snapshots, the trash, and any repository the vault happens to contain.
const FORBIDDEN_METADATA_DIRS: [&str; 3] = [".nekowite", ".nekowite-trash", ".git"];

/// How many directory entries [`nested_metadata_dirs`] will look at before it
/// stops. This runs on every vault open, and a vault is user data of unbounded
/// size, so it must not be able to stall the switch.
const NESTED_METADATA_SCAN_LIMIT: usize = 20_000;

/// Every metadata directory at or below `root`.
///
/// This includes `root`'s own, which the caller also forbids by name — the
/// scope stores forbidden patterns in a set, so the overlap costs nothing and
/// keeps this function a plain "find them all" rather than one that has to know
/// which level the caller already handled.
///
/// Depth-first and bounded. It never descends into a directory it already
/// recognises as metadata, and `DirEntry::file_type` does not follow symlinks,
/// so a symlinked tree is neither walked nor able to loop.
fn nested_metadata_dirs(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > NESTED_METADATA_SCAN_LIMIT {
                return found;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            if FORBIDDEN_METADATA_DIRS.contains(&entry.file_name().to_string_lossy().as_ref()) {
                found.push(entry.path());
                continue;
            }
            stack.push(entry.path());
        }
    }
    found
}

#[cfg(test)]
mod nested_metadata_tests {
    use super::nested_metadata_dirs;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nekowite-media-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(root: &std::path::Path) -> Vec<String> {
        nested_metadata_dirs(root)
            .iter()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    #[test]
    fn finds_a_metadata_dir_nested_anywhere_in_the_vault() {
        let root = temp_dir("nested");
        std::fs::create_dir_all(root.join(".nekowite").join("history")).unwrap();
        std::fs::create_dir_all(root.join("notes").join("sub").join(".git")).unwrap();
        std::fs::create_dir_all(root.join("notes").join("plain")).unwrap();

        let found = names(&root);
        assert!(
            found.iter().any(|n| n.ends_with("notes/sub/.git")),
            "a nested .git must be found: {found:?}"
        );
        assert!(
            found.iter().any(|n| n.ends_with("/.nekowite")),
            "the root's own is included too (forbidding twice is free): {found:?}"
        );
        assert!(
            !found.iter().any(|n| n.ends_with("notes/plain")),
            "an ordinary directory must not be reported: {found:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn does_not_walk_into_a_metadata_tree_it_already_found() {
        let root = temp_dir("prune");
        std::fs::create_dir_all(root.join("a").join(".git").join("modules").join(".git")).unwrap();
        let found = names(&root);
        assert_eq!(
            found.len(),
            1,
            "only the outermost metadata dir, not the one inside it: {found:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
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
