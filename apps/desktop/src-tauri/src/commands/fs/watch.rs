//! The folder watcher: one `notify` watcher per opened vault, the events it forwards, and the
//! holding task that flushes a burst's quiet tail.
//!
//! **This file was split out of `commands/fs.rs`.** One subject: the `watch_folder` command and the
//! lifecycle of the watcher it installs — resolve the root, build the watcher, retire the previous
//! generation only once the new one exists, replace the managed watcher. It changes when the
//! watcher's lifecycle or `notify`'s callback shape changes.
//!
//! The decision about WHICH events to forward is [`coalescing`]'s, beside this file: it is pure, it
//! is what the tests pin, and it changes for its own reasons. Every comment below survived the move
//! verbatim, because each one records a failure the current shape exists to prevent.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use notify::Watcher;
use tauri::Emitter;

use crate::domain::path_policy::{has_hidden_component, ipc_path, resolve_within};
use crate::state::{require_opened_vault, VaultRegistry, WatcherState};

use super::coalescing::{should_emit_change, take_settled_pending, PendingBurst, COALESCE_WINDOW};

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
