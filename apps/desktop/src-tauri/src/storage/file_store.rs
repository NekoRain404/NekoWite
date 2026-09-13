//! Vault file store: the vault-facing base IO (read, stat, write, create,
//! list) and the public surface of the storage layer.
//!
//! Every function takes a `vault_root` (the vault the user opened) as its first
//! argument and resolves the requested path through
//! [`crate::domain::path_policy`] before touching the disk, so every operation
//! is traceable to the vault root and confined inside it. The command layer
//! additionally proves the root was opened this session (see
//! [`crate::state::require_opened_vault`]) before calling in.
//!
//! What used to be one file now lives in sibling modules (roadmap 10.4), and
//! this file keeps the base IO plus the re-exports below:
//!
//! * [`crate::storage::atomic_write`] - the write lock, temp-file staging, the
//!   fsync/rename pipeline, and the create-only / no-clobber publish operations;
//! * [`crate::storage::attachment_store`] - the paste and file-picker attachment
//!   paths, their shared name and size rules, and the name-claiming write;
//! * [`crate::storage::metadata_store`] - the history side key, snapshots, and
//!   their listing, reading and restoring;
//! * [`crate::storage::rename_store`] - the rename transaction.
//!
//! Dependencies: this module depends on `atomic_write` and `metadata_store` (the
//! save pipeline) and on none of the others; nothing below imports back.

use serde::Serialize;
use std::io;
use std::path::Path;

use crate::domain::path_policy::{resolve_within, resolve_within_rel};
use crate::domain::vault::{is_mdx_path, should_skip_entry};
use crate::errors::{file_exists_error, fs_error};
use crate::storage::atomic_write::{create_new_bytes, write_lock, CreateFileError};
use crate::storage::metadata_store::DEFAULT_MAX_HISTORY;
use crate::storage::temp_files::STALE_TMP_MAX_AGE;

// --- Thin forwarders (roadmap 10.4: keep the old public names for one stage) ---
//
// A re-export, not a wrapper: each item has exactly one definition, in the
// module named here, and this block is what lets the split land without
// touching `commands/fs.rs`, `commands/recovery.rs` or `storage/trash_store.rs`
// in the same commit. The modules above are the owners; this file keeps the
// vault-facing base IO.
pub(crate) use crate::storage::atomic_write::move_no_clobber;
pub use crate::storage::atomic_write::{atomic_write, atomic_write_bytes};
pub use crate::storage::attachment_store::{
    decode_base64, import_attachment, is_importable_image, sanitize_attachment_name,
    save_attachment, IMPORT_IMAGE_EXTENSIONS, MAX_IMPORT_BYTES,
};
pub use crate::storage::metadata_store::{
    list_history, read_history, restore_history, snapshot_history, HistoryEntry,
};
pub use crate::storage::rename_store::rename_entry;
pub use crate::storage::temp_files::cleanup_stale_tmp;

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_mdx: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
}

pub fn read_file(vault_root: &str, path: &str) -> Result<String, String> {
    let resolved = resolve_within(vault_root, path)?;
    std::fs::read_to_string(&resolved).map_err(|e| fs_error("read", &resolved, e))
}

/// Stat a vault-relative path: byte size plus modified time in unix
/// milliseconds. The path is resolved within the vault first, and a missing
/// file is an error (`resolve_within` permits a not-yet-existing tail, but
/// the metadata lookup then fails).
pub fn stat_file(vault_root: &str, path: &str) -> Result<FileStat, String> {
    let resolved = resolve_within(vault_root, path)?;
    let meta = std::fs::metadata(&resolved).map_err(|e| fs_error("stat", &resolved, e))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        size: meta.len(),
        mtime,
    })
}

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
    let mut warning = None;
    if let Some(old_content) = old {
        if !old_content.is_empty() && old_content != content {
            let max = max_history.map_or(DEFAULT_MAX_HISTORY, |m| m as usize);
            if let Err(e) = snapshot_history(vault_root, path, &old_content, max) {
                warning = Some(format!(
                    "Saved, but the previous version could not be kept in history: {e}"
                ));
            }
        }
    }
    atomic_write(&resolved, content)?;
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

pub fn list_dir(vault_root: &str, path: Option<&str>) -> Result<Vec<FileEntry>, String> {
    let requested = path.unwrap_or(".");
    let resolved = resolve_within(vault_root, requested)?;
    list_dir_entries(&resolved)
}

/// Pure single-level listing of `dir` with [`should_skip_entry`] filtering
/// applied. Shared by the `list_dir` command (after path resolution) and by
/// tests that exercise filtering directly against a real temp directory.
pub fn list_dir_entries(dir: &Path) -> Result<Vec<FileEntry>, String> {
    let mut out = vec![];
    let entries = std::fs::read_dir(dir).map_err(|e| fs_error("list the folder", dir, e))?;
    for entry in entries {
        // Swallowing a per-entry failure (`entries.flatten()`) silently dropped
        // it from the listing, so a folder that could not be fully enumerated
        // looked like a folder with fewer files — indistinguishable, to the
        // file tree, from one where they never existed. The history and trash
        // listings already refuse to do that.
        let entry = entry.map_err(|e| fs_error("list the folder", dir, e))?;
        let entry_path = entry.path();
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let is_symlink = entry
            .file_type()
            .map_err(|e| fs_error("inspect", &entry_path, e))?
            .is_symlink();
        if should_skip_entry(&name, is_symlink) {
            continue;
        }
        let is_dir = entry_path.is_dir();
        let path_str = crate::domain::path_policy::ipc_path(&entry_path);
        let is_mdx = is_mdx_path(&path_str);
        // Every non-hidden file is listed: the references library
        // (`.bib`/`.ris`) is discovered from this listing, so non-markdown
        // files must not be filtered out. The file tree decides what is
        // openable via the `is_mdx` flag.
        out.push(FileEntry {
            name,
            path: path_str,
            is_dir,
            is_mdx: !is_dir && is_mdx,
        });
    }
    out.sort_by(|a, b| {
        (b.is_dir as u8)
            .cmp(&(a.is_dir as u8))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Resolve a media reference (e.g. from markdown) to an absolute path the
/// frontend can feed to `convertFileSrc`. Traversal and symlink escapes are
/// rejected by [`resolve_within`]; a missing file is an error.
pub fn resolve_media_path(vault_root: &str, rel_path: &str) -> Result<String, String> {
    let resolved = resolve_within(vault_root, rel_path)?;
    if !resolved.is_file() {
        return Err(format!("media file not found: {rel_path}"));
    }
    Ok(crate::domain::path_policy::ipc_path(&resolved))
}

/// Create a directory (and any missing parents) inside the vault. Returns the
/// canonical vault-relative path of the created directory.
pub fn create_dir(vault_root: &str, path: &str) -> Result<String, String> {
    let (resolved, relative) = resolve_within_rel(vault_root, path)?;
    if resolved.exists() {
        return Err(format!("already exists: {relative}"));
    }
    std::fs::create_dir_all(&resolved).map_err(|e| fs_error("create the folder", &resolved, e))?;
    Ok(relative)
}

#[cfg(test)]
mod write_lock_scope_tests {
    use super::*;
    use crate::storage::atomic_write::write_lock;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    fn temp_root(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nekowite-lock-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The write lock is PROCESS-WIDE, not per vault: a save in one vault waits
    /// for a save in another. That is the guarantee the comment on the lock
    /// (`atomic_write::write_lock`) claims, and this test exists so narrowing the
    /// lock to a per-vault map has to be a deliberate act with updated reasoning,
    /// not a silent refactor.
    ///
    /// It lives here, at the facade, because the three paths it has to keep on
    /// ONE lock - `write_file`, `rename_entry`, `restore_history` - meet in this
    /// module; the lock itself is defined in `atomic_write`.
    #[test]
    fn the_write_lock_is_process_wide_across_vaults() {
        let vault_a = temp_root("scope-a");
        let vault_b = temp_root("scope-b");
        let b_root = vault_b.to_str().unwrap().to_string();

        let guard = write_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let ok = write_file(&b_root, "b.md", "content", None).is_ok();
            let _ = tx.send(ok);
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(250)).is_err(),
            "a write in vault B ran while vault A held the write lock: the lock is no longer process-wide"
        );

        drop(guard);
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "the blocked write must finish once the lock is released"
        );
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&vault_a);
        let _ = std::fs::remove_dir_all(&vault_b);
    }

    /// A rename must wait for a save that is in flight, and vice versa.
    ///
    /// Without a shared lock the two interleave: `write_file` resolves the old
    /// path, `rename_entry` moves the file to its new name (migrating the
    /// history and trash keys with it), and the save then publishes its temp
    /// file at the path the rename just vacated. The result is a resurrected
    /// file at the old name whose history and trash metadata belong to the new
    /// one — the rename looks like it silently failed.
    #[test]
    fn rename_entry_waits_on_the_write_lock() {
        let vault = temp_root("rename-lock");
        let root = vault.to_str().unwrap().to_string();
        std::fs::write(vault.join("a.md"), "content").unwrap();

        let guard = write_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        let root_clone = root.clone();
        let handle = std::thread::spawn(move || {
            let ok = rename_entry(&root_clone, "a.md", "b.md").is_ok();
            let _ = tx.send(ok);
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(250)).is_err(),
            "rename_entry ran while the write lock was held"
        );
        drop(guard);
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "rename_entry must finish once the lock is released"
        );
        handle.join().unwrap();
        assert!(vault.join("b.md").exists(), "the rename still happened");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn restore_history_waits_on_the_write_lock() {
        let vault = temp_root("restore-lock");
        let root = vault.to_str().unwrap().to_string();
        std::fs::write(vault.join("note.md"), "v1").unwrap();
        write_file(&root, "note.md", "v2", Some(5)).unwrap();
        let id = list_history(&root, "note.md").unwrap()[0].id.clone();

        let guard = write_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        let root_clone = root.clone();
        let handle = std::thread::spawn(move || {
            let ok = restore_history(&root_clone, "note.md", &id).is_ok();
            let _ = tx.send(ok);
        });

        assert!(
            rx.recv_timeout(Duration::from_millis(250)).is_err(),
            "restore_history ran while the write lock was held"
        );
        drop(guard);
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "restore_history must finish once the lock is released"
        );
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&vault);
    }
}
