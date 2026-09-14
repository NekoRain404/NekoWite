//! The save: the two writes that put text into a vault file, and the history
//! version they take on the way.
//!
//! Split out of [`crate::storage::file_store`] (which keeps the read/inspect
//! half — read, stat, list, mkdir, media paths — and remains the public
//! surface, so every caller below it keeps its import path). Both functions
//! hold [`crate::storage::atomic_write::write_lock`], and that is why they sit
//! together rather than beside the reading: the guarantee is that a save, a
//! restore and a rename wait on one lock, and the read half has no such
//! ordering to keep.
//!
//! The order a save runs in is the whole of its safety, and it is:
//!
//! 1. refuse a destination the user made read-only, before any work is done
//!    for it (including the history slot the snapshot spends);
//! 2. read what is there, and STAGE the version it is about to become;
//! 3. publish atomically — a staged sibling, fsync, rename, directory fsync;
//! 4. and only now COMMIT the eviction the staged version implies.
//!
//! Step 4 used to happen with step 2, and the gap between them is what a failed
//! save spent the user's history on: it pruned a version for a write it never
//! completed, one per attempt, until the ten slots held duplicates of a file
//! that never changed. The eviction is a consequence of the save, so it waits
//! for the save.

use std::io;

use crate::domain::path_policy::resolve_within;
use crate::errors::{file_exists_error, fs_error};
use crate::storage::atomic_write::{atomic_write, create_new_bytes, write_lock, CreateFileError};
use crate::storage::destination_file;
use crate::storage::history_snapshot::{settle_failed_publish, stage_history, DEFAULT_MAX_HISTORY};
use crate::storage::temp_files::{cleanup_stale_tmp, STALE_TMP_MAX_AGE};

/// Write `content` to `path` under the vault, snapshotting the previous
/// content first (when it exists, differs, and is non-empty).
///
/// Returns `Ok(None)` when everything succeeded and `Ok(Some(warning))` when the
/// text was written but the history snapshot was not — never an error for a
/// failure of the optional part.
///
/// `max_history` caps how many snapshots are kept (default 10 when `None`).
/// `Option<u32>` keeps the command compatible with the current frontend, which
/// invokes `write_file` with only `{ vault_root, path, content }`; Tauri maps a
/// missing optional argument to `None`.
///
/// The read-old -> snapshot -> atomic-write sequence holds [`write_lock`], so
/// concurrent saves on the same vault are serialized and cannot interleave a
/// stale snapshot with a newer write. The directory the file lives in is also
/// swept for stale `.tmp` crash litter before the write.
pub fn write_file(
    vault_root: &str,
    path: &str,
    content: &str,
    max_history: Option<u32>,
) -> Result<Option<String>, String> {
    // Serialize the whole read-snapshot-write sequence. `write_file` does no
    // `.await`, so the guard never crosses a yield point and cannot deadlock
    // the async executor; it just windows two concurrent saves apart.
    let _guard = write_lock().lock().map_err(|e| e.to_string())?;
    let resolved = resolve_within(vault_root, path)?;
    // Refused before the read and the snapshot below, which is the point of
    // asking here as well as at the publish (which stays the authority): those
    // two steps are work done FOR a write that is not going to happen, and the
    // snapshot spends a history slot. A user typing into a read-only note saves
    // on every burst, so five refused saves would otherwise fill the ten-slot
    // history with duplicates of a version that never changed and evict the
    // older ones the panel exists to offer.
    destination_file::refuse_if_read_only(&resolved)?;
    if let Some(parent) = resolved.parent() {
        let _ = cleanup_stale_tmp(parent, STALE_TMP_MAX_AGE);
    }
    let old = if resolved.exists() {
        match std::fs::read_to_string(&resolved) {
            Ok(old) => Some(old),
            // A binary file has no text snapshot to take; refuse the
            // overwrite instead of destroying it untracked.
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                return Err("file is not valid UTF-8 text".into());
            }
            // Unreadable for another reason (permissions, ...): keep the old
            // best-effort behavior and write without a snapshot.
            Err(_) => None,
        }
    } else {
        None
    };
    // The snapshot is best-effort: it is a convenience the user asked for
    // implicitly, while the write is the thing they explicitly asked for. A
    // history failure (unwritable history dir, full disk, quota) used to abort
    // the save with a bare OS error, which meant an existing note could not be
    // edited at all until the unrelated problem was fixed. Report it instead, and
    // report it in a form the caller can show: `Ok(Some(warning))` means "your
    // text was written, and this other thing failed".
    //
    // It is STAGED here and only COMMITTED after the publish, because staging
    // and evicting are not one act. Pruning at this point is what charged a
    // failed save a history version: a note whose name was too long to stage a
    // sibling for exhausted its own ten slots with duplicates of itself, one
    // per attempt, while every attempt reported an error the user could do
    // nothing about — so the versions that were the recovery were the ones
    // being spent.
    let max = max_history.map_or(DEFAULT_MAX_HISTORY, |m| m as usize);
    let mut warning = None;
    let mut staged = None;
    if let Some(old_content) = old {
        if !old_content.is_empty() && old_content != content {
            match stage_history(vault_root, path, &old_content) {
                Ok(snapshot) => staged = snapshot,
                Err(e) => {
                    warning = Some(format!(
                        "Saved, but the previous version could not be kept in history: {e}"
                    ));
                }
            }
        }
    }
    if let Err(e) = atomic_write(&resolved, content) {
        settle_failed_publish(&resolved, content, staged, max);
        return Err(e);
    }
    if let Some(snapshot) = staged {
        if let Err(e) = snapshot.commit(max) {
            warning.get_or_insert(format!(
                "Saved, but the history could not be trimmed to {max} versions: {e}"
            ));
        }
    }
    Ok(warning)
}

/// Creates `path` with `content`, refusing to replace anything already there.
///
/// The difference from [`write_file`] is the whole point: saving REPLACES the
/// file it finds (that is what saving means), while a note born from a template
/// or a daily note must never land on top of a file that appeared between "is
/// this name free?" and "write it" - another instance of the app, a sync
/// client, or the user in Explorer can all win that race, and the loser used to
/// be whoever's file was already there.
///
/// The bytes are staged first and then published with a hard link, which either
/// creates the name or fails with `AlreadyExists`: the check and the creation
/// are one step, a reader never sees a half-written note, and the "taken" case
/// is reported through [`crate::errors::ALREADY_EXISTS_PREFIX`] so the caller
/// can try the next name instead of showing the user an OS error.
pub fn create_new_file(vault_root: &str, path: &str, content: &str) -> Result<(), String> {
    let _guard = write_lock().lock().map_err(|e| e.to_string())?;
    let resolved = resolve_within(vault_root, path)?;
    let parent = resolved
        .parent()
        .ok_or_else(|| format!("cannot create {path}: it has no parent folder"))?;
    std::fs::create_dir_all(parent).map_err(|e| fs_error("create the folder", parent, e))?;
    let _ = cleanup_stale_tmp(parent, STALE_TMP_MAX_AGE);
    create_new_bytes(&resolved, content.as_bytes()).map_err(|e| match e {
        CreateFileError::AlreadyExists => file_exists_error(path),
        CreateFileError::Failed(message) => message,
    })
}
