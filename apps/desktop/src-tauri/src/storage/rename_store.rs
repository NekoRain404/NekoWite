//! Renaming a file or directory inside a vault, and the metadata migration
//! that has to travel with it.
//!
//! This module owns the ORDER of the rename transaction (roadmap 10.4 step 4):
//! take the write lock, refuse a taken destination, move the entry without
//! clobbering, then migrate the metadata keyed by the old path. For a *file*
//! that is [`move_history_key`] here plus
//! [`crate::storage::trash_store::move_trash_key`] next door - the two side
//! tables that key off the vault-relative path. A renamed *directory* is a plain
//! move: the file tree inside it still carries old relative paths, so migrating
//! the whole subtree's keys is deliberately out of scope.
//!
//! The whole transaction holds [`crate::storage::atomic_write::write_lock`] -
//! see [`rename_entry`] for why.

use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::path_policy::{
    encode_rel_path, find_vault_metadata_dir, resolve_vault_metadata_dir, resolve_within_rel,
};
use crate::errors::fs_error;
use crate::storage::atomic_write::{move_no_clobber, write_lock};
use crate::storage::temp_files::temp_sibling;
use crate::storage::trash_store::move_trash_key;

/// Rename (move) a file or directory within the vault. The target must not
/// exist. Returns the canonical vault-relative path of the moved entry.
///
/// For a renamed *file*, the history snapshots and trash entry keyed by the
/// old vault-relative path are migrated to the new key too, so a rename doesn't
/// silently orphan (make unreachable) a file's history or a trash restore.
/// A renamed *directory* is a plain move for now: the file tree inside it
/// still carries old relative paths, so migrating the whole subtree's keys is
/// deliberately out of scope here (single-file renames are covered).
pub fn rename_entry(vault_root: &str, from: &str, to: &str) -> Result<String, String> {
    // Serialize with the saves. Without this a save that resolved the old path
    // just before the move publishes its temp file at the path the rename
    // vacated, resurrecting the file after its history and trash keys have
    // already been migrated to the new name — the rename then looks like it
    // silently failed, and the old path holds a copy nothing tracks.
    let _guard = write_lock().lock().map_err(|e| e.to_string())?;
    let (resolved_from, relative_from) = resolve_within_rel(vault_root, from)?;
    if !resolved_from.exists() {
        return Err(format!("not found: {relative_from}"));
    }
    let is_dir = resolved_from.is_dir();
    let (resolved_to, relative_to) = resolve_within_rel(vault_root, to)?;
    // `exists()` follows the filesystem's CASING rules, so on Windows a case-only
    // rename (`note.md` -> `Note.md`) hits the file itself and was rejected with
    // "target already exists: Note.md" — a message naming the very name the user
    // just asked for, which reads as nonsense.
    //
    // The comparison uses the REQUESTED spellings, not the resolved paths:
    // resolution canonicalizes, and canonicalization reports the ON-DISK casing,
    // so a request for `archive/B.md` resolves to `archive/b.md` and would look
    // identical to its own source.
    let normalize = |s: &str| s.replace('\\', "/").to_lowercase();
    let case_only_rename = from != to && normalize(from) == normalize(to);
    if resolved_to.exists() && !case_only_rename {
        return Err(format!("target already exists: {relative_to}"));
    }
    if let Some(parent) = resolved_to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| fs_error("create the folder containing", parent, e))?;
    }
    if case_only_rename {
        // Two things have to be right here, and the first attempt got both wrong
        // (measured: the rename reported success and the file kept its old name).
        //
        // 1. `resolved_to` is USELESS as the destination. Resolution canonicalizes
        //    before the move, so for `keep.md` -> `KEEP.md` it holds the OLD
        //    spelling — renaming to it is exactly what "does nothing". The
        //    destination is therefore rebuilt from the requested name (that is
        //    where the user's casing lives) on the resolved parent.
        // 2. A direct rename will not change an existing entry's case, so it goes
        //    through a temporary sibling name first. That name wears our staging
        //    shape, so a process death between the two steps leaves something the
        //    vault's temp sweeper recognises rather than an orphan — and the file
        //    is put back under its original name if the second step fails.
        let parent = resolved_to.parent().unwrap_or(Path::new("."));
        let requested_name = to
            .rsplit(['/', '\\'])
            .next()
            .filter(|n| !n.is_empty())
            .unwrap_or("renamed");
        let target = parent.join(requested_name);
        let temp = temp_sibling(parent, requested_name);
        std::fs::rename(&resolved_from, &temp)
            .map_err(|e| fs_error("rename", &resolved_from, e))?;
        if let Err(e) = std::fs::rename(&temp, &target) {
            let _ = std::fs::rename(&temp, &resolved_from);
            return Err(fs_error("rename to", &target, e));
        }
    } else {
        // Files get a real no-clobber move: between the `exists()` check above
        // and the move another writer can create the destination, and a plain
        // `rename` would REPLACE it — silently destroying that file. A directory
        // has no portable no-clobber rename, so `move_no_clobber` falls back to a
        // best-effort check plus one atomic rename for it.
        match move_no_clobber(&resolved_from, &resolved_to) {
            Ok(()) => {}
            // Someone claimed the name in the window: report it exactly as the
            // check above would have, rather than clobbering them.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                return Err(format!("target already exists: {relative_to}"));
            }
            Err(e) => return Err(fs_error("rename", &resolved_from, e)),
        }
    }
    // The relative path was canonicalized BEFORE the move, so for a case-only
    // rename it still holds the old spelling. Re-resolve to report what is
    // actually on disk now: the caller stores this string as the tab's path and
    // shows it as the note's name, so `archive/b.md` after a rename to
    // `archive/B.md` would leave the title looking as if nothing happened.
    let relative_to = resolve_within_rel(vault_root, to)
        .map(|(_, rel)| rel)
        .unwrap_or(relative_to);
    if !is_dir {
        move_history_key(vault_root, &relative_from, &relative_to);
        move_trash_key(vault_root, &relative_from, &relative_to);
    }
    Ok(relative_to)
}

/// Migrate a file's history snapshots from the key for `from_rel` to the key
/// for `to_rel`. Best-effort: a renamed entry must not fail because a side
/// table could not be moved, so every error is swallowed. When the target key
/// already holds snapshots (a file of that relative path was previously saved),
/// the two directories are merged file-by-file instead of clobbering.
///
/// Called by [`rename_entry`] while it holds the write lock, so the key move
/// cannot interleave with a save that is mid-snapshot on either key.
fn move_history_key(vault_root: &str, from_rel: &str, to_rel: &str) {
    let from_name = encode_rel_path(from_rel);
    let to_name = encode_rel_path(to_rel);
    // A missing source is the ordinary "the old name had no history"; a
    // symlinked metadata tree is a refusal. This function reports every failure
    // by doing nothing.
    let Ok(Some(from_dir)) =
        find_vault_metadata_dir(vault_root, &[".nekowite", "history", &from_name])
    else {
        return;
    };
    // Resolve the target WITHOUT creating it: the single-rename path below
    // needs it absent, and `None` is exactly "the name is free". Either way the
    // result stays under the parent the walk already validated.
    let to_dir =
        match resolve_vault_metadata_dir(vault_root, &[".nekowite", "history", &to_name], false) {
            Ok(Some(dir)) => dir,
            Ok(None) => match from_dir.parent() {
                Some(parent) => parent.join(&to_name),
                None => return,
            },
            Err(_) => return,
        };
    if !to_dir.exists() {
        let _ = std::fs::rename(&from_dir, &to_dir);
        return;
    }
    let Ok(rd) = std::fs::read_dir(&from_dir) else {
        return;
    };
    for entry in rd.flatten() {
        let src = entry.path();
        let name = src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let mut target = to_dir.join(&name);
        if target.exists() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default();
            target = to_dir.join(format!("{name}-merged-{ts}"));
        }
        let _ = std::fs::rename(&src, &target);
    }
    let _ = std::fs::remove_dir(&from_dir);
}
